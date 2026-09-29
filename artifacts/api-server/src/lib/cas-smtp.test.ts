import assert from "node:assert/strict";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { casEmailAccounts, casIncidents, casProviderDeliveries, casResponders } from "@workspace/db/schema";
import {
  CasProviderError,
  createSmtpEmailProvider,
  loadConfiguredProviders,
} from "./delivery-providers";
import {
  assertUnambiguousEmailConfig,
  readEmailSmtpConfig,
} from "./cas-provider-env";
import { deliverableGatewayTransports } from "./cas-delivery-config";
import { maskRecipient } from "./cas-device-delivery";
import { SMTP_STUB_CERT_PATH, startStubSmtp, type StubSmtpServer } from "./cas-smtp-stub";

// AUTH PLAIN payload separator (NUL) without a literal escape, so this
// source file stays plain text.
const NUL = String.fromCharCode(0);

const CERT_PATH = SMTP_STUB_CERT_PATH;

const baseMessage = {
  transport: "EMAIL",
  priority: "P1",
  body: "CAS P1 alert body — unicode survives ✓",
} as const;

function smtpMessage(incidentId: string) {
  return { ...baseMessage, incidentId };
}

function stubProvider(stub: StubSmtpServer, extra: { secure?: boolean } = {}) {
  return createSmtpEmailProvider({
    host: "localhost",
    port: stub.port,
    secure: extra.secure ?? true,
    user: "cas-alerts@example.org",
    password: "test-app-password",
    caFile: CERT_PATH,
    recipients: [],
  });
}

before(async () => {
  await db.delete(casProviderDeliveries);
  await db.delete(casResponders);
  await db.delete(casEmailAccounts);
  // The delivery ledger references cas_incidents (FK), so every incident id
  // the tests send for must exist.
  await db
    .insert(casIncidents)
    .values(
      [
        "inc-smtp-1",
        "inc-smtp-starttls",
        "inc-smtp-long-ehlo",
        "inc-smtp-notls",
        "inc-smtp-auth",
        "inc-smtp-retry",
        "inc-smtp-550",
        "inc-smtp-nocreds",
        "inc-smtp-injection",
      ].map((id) => ({ id, priority: "P1", status: "ACTIVE_UNACKED" })),
    )
    .onConflictDoNothing();
});

// ---- Configuration parsing -------------------------------------------------

test("SMTP env config parses with TLS-safe defaults and refuses bad ports", () => {
  assert.equal(readEmailSmtpConfig({}), undefined);
  assert.equal(readEmailSmtpConfig({ CAS_EMAIL_PROVIDER_URL: "https://mail.example.org" }), undefined);

  const defaults = readEmailSmtpConfig({ CAS_EMAIL_SMTP_HOST: "smtp.gmail.com" });
  assert.deepEqual(defaults, {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    user: undefined,
    password: undefined,
    from: undefined,
    caFile: undefined,
  });

  const starttls = readEmailSmtpConfig({
    CAS_EMAIL_SMTP_HOST: "smtp.example.org",
    CAS_EMAIL_SMTP_PORT: "587",
    CAS_EMAIL_SMTP_USER: "cas-alerts@example.org",
    CAS_EMAIL_SMTP_PASSWORD: "app-password",
  });
  assert.equal(starttls?.port, 587);
  assert.equal(starttls?.secure, false);
  // The sender defaults to the mailbox login; CAS_EMAIL_FROM overrides it.
  assert.equal(starttls?.from, "cas-alerts@example.org");
  assert.equal(
    readEmailSmtpConfig({
      CAS_EMAIL_SMTP_HOST: "smtp.example.org",
      CAS_EMAIL_SMTP_USER: "cas-alerts@example.org",
      CAS_EMAIL_FROM: "alerts@example.net",
    })?.from,
    "alerts@example.net",
  );

  for (const bad of ["abc", "0", "-1", "70000", "465.5"]) {
    assert.throws(
      () => readEmailSmtpConfig({ CAS_EMAIL_SMTP_HOST: "h", CAS_EMAIL_SMTP_PORT: bad }),
      /Invalid CAS_EMAIL_SMTP_PORT/,
      `port ${bad}`,
    );
  }
});

test("setting both email transports is a loud configuration error, never a silent pick", () => {
  assert.doesNotThrow(() => assertUnambiguousEmailConfig({}));
  assert.doesNotThrow(() =>
    assertUnambiguousEmailConfig({ CAS_EMAIL_SMTP_HOST: "smtp.example.org" }),
  );
  assert.doesNotThrow(() =>
    assertUnambiguousEmailConfig({ CAS_EMAIL_PROVIDER_URL: "https://mail.example.org" }),
  );
  assert.throws(
    () =>
      assertUnambiguousEmailConfig({
        CAS_EMAIL_SMTP_HOST: "smtp.example.org",
        CAS_EMAIL_PROVIDER_URL: "https://mail.example.org",
      }),
    /configured twice/,
  );
  // loadConfiguredProviders is evaluated at server boot, so the
  // contradiction aborts startup with a clear message.
  assert.throws(
    () =>
      loadConfiguredProviders({
        CAS_EMAIL_SMTP_HOST: "smtp.example.org",
        CAS_EMAIL_PROVIDER_URL: "https://mail.example.org",
      } as NodeJS.ProcessEnv),
    /configured twice/,
  );
});

test("loadConfiguredProviders selects the SMTP email adapter when SMTP env is present", async () => {
  const adapters = loadConfiguredProviders({
    CAS_EMAIL_SMTP_HOST: "smtp.example.org",
    CAS_EMAIL_SMTP_USER: "cas-alerts@example.org",
    CAS_EMAIL_SMTP_PASSWORD: "app-password",
  } as NodeJS.ProcessEnv);
  assert.equal(adapters.email?.transport, "EMAIL");
  const httpsOnly = loadConfiguredProviders({
    CAS_EMAIL_PROVIDER_URL: "https://mail.example.org",
  } as NodeJS.ProcessEnv);
  assert.equal(httpsOnly.email?.transport, "EMAIL");
  // The email adapter is always present now (console account rows resolve
  // at send time); with no configuration anywhere it fails loudly.
  const unconfigured = loadConfiguredProviders({} as NodeJS.ProcessEnv);
  assert.equal(unconfigured.email?.transport, "EMAIL");
  await assert.rejects(
    unconfigured.email.send(smtpMessage("inc-smtp-nocreds"), "inc-smtp-nocreds-email", ["lead@example.org"]),
    /not-configured|No EMAIL delivery/,
  );
});

test("email channel is deliverable when SMTP is configured, exactly like the HTTPS path", async () => {
  assert.deepEqual(await deliverableGatewayTransports({} as NodeJS.ProcessEnv), []);
  const viaSmtp = await deliverableGatewayTransports({
    CAS_EMAIL_SMTP_HOST: "smtp.example.org",
    CAS_EMAIL_RECIPIENTS: "lead@example.org",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(viaSmtp, ["EMAIL"]);
  const viaHttps = await deliverableGatewayTransports({
    CAS_EMAIL_PROVIDER_URL: "https://mail.example.org",
    CAS_EMAIL_RECIPIENTS: "lead@example.org",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(viaHttps, ["EMAIL"]);
  // SMTP host without any reachable recipient stays undeliverable, so a
  // trigger never queues an item that can only dead-letter.
  assert.deepEqual(
    await deliverableGatewayTransports({ CAS_EMAIL_SMTP_HOST: "smtp.example.org" } as NodeJS.ProcessEnv),
    [],
  );
});

// ---- Protocol behavior against the stub server ------------------------------

test("SMTP send over implicit TLS authenticates, sends headers and base64 body, journals masked recipients", async () => {
  const stub = await startStubSmtp("implicit-tls");
  try {
    const email = stubProvider(stub);
    await email.send(smtpMessage("inc-smtp-1"), "inc-smtp-1-email", ["lead@example.org", "backup@example.org"]);

    assert.equal(stub.connections(), 2); // one short-lived connection per recipient
    assert.equal(stub.messages.length, 2);
    // Credentials crossed only inside TLS, as the AUTH PLAIN payload
    // base64(NUL + user + NUL + password).
    assert.equal(stub.authLogins.length, 2);
    assert.ok(
      stub.authLogins.every(
        (login) =>
          login.tls &&
          login.decoded === ["", "cas-alerts@example.org", "test-app-password"].join(NUL),
      ),
    );
    assert.ok(stub.transcript.every((entry) => entry.tls));
    assert.ok(!JSON.stringify(stub.transcript).includes("test-app-password"));

    const first = stub.messages[0];
    assert.match(first.raw, /^From: cas-alerts@example\.org\r$/m);
    assert.match(first.raw, /^To: lead@example\.org\r$/m);
    assert.match(first.raw, /^Subject: CAS P1 alert inc-smtp-1\r$/m);
    assert.match(first.raw, /^Message-ID: <[0-9a-f]{64}@example\.org>\r$/m);
    const bodyBase64 = first.raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    assert.equal(Buffer.from(bodyBase64, "base64").toString("utf8"), baseMessage.body);

    const ledger = await db
      .select()
      .from(casProviderDeliveries)
      .where(eq(casProviderDeliveries.incidentId, "inc-smtp-1"));
    assert.deepEqual(
      ledger.map((row) => row.recipientMasked).sort(),
      [maskRecipient("lead@example.org"), maskRecipient("backup@example.org")].sort(),
    );
    assert.ok(ledger.every((row) => row.transport === "EMAIL"));
  } finally {
    await stub.close();
  }
});

test("STARTTLS path encrypts before AUTH; EHLO/STARTTLS stay the only plaintext commands", async () => {
  const stub = await startStubSmtp("starttls");
  try {
    const email = stubProvider(stub, { secure: false });
    await email.send(smtpMessage("inc-smtp-starttls"), "inc-smtp-starttls-email", ["lead@example.org"]);

    assert.equal(stub.messages.length, 1);
    assert.equal(stub.messages[0].tls, true);
    const plaintextCommands = stub.transcript.filter((entry) => !entry.tls).map((entry) => entry.line);
    assert.deepEqual(plaintextCommands, ["EHLO cas-alert", "STARTTLS"]);
    assert.equal(stub.authLogins.length, 1);
    assert.equal(stub.authLogins[0].tls, true);
  } finally {
    await stub.close();
  }
});

test("a long EHLO capability list cannot hide a late STARTTLS advertisement", async () => {
  const stub = await startStubSmtp("starttls", { longGreeting: true });
  try {
    const email = stubProvider(stub, { secure: false });
    await email.send(smtpMessage("inc-smtp-long-ehlo"), "inc-smtp-long-ehlo-email", ["lead@example.org"]);
    assert.equal(stub.messages.length, 1);
    assert.equal(stub.messages[0].tls, true);
    const plaintextCommands = stub.transcript.filter((entry) => !entry.tls).map((entry) => entry.line);
    assert.deepEqual(plaintextCommands, ["EHLO cas-alert", "STARTTLS"]);
  } finally {
    await stub.close();
  }
});

test("a server without STARTTLS fails loudly as not-configured and never sees credentials", async () => {
  const stub = await startStubSmtp("starttls", { offerStarttls: false });
  try {
    const email = stubProvider(stub, { secure: false });
    await assert.rejects(
      email.send(smtpMessage("inc-smtp-notls"), "inc-smtp-notls-email", ["lead@example.org"]),
      (error: unknown) => {
        assert.ok(error instanceof CasProviderError);
        assert.equal(error.classification, "not-configured");
        assert.equal(error.retryable, false);
        assert.match(error.message, /STARTTLS/);
        return true;
      },
    );
    assert.equal(stub.authLogins.length, 0);
  } finally {
    await stub.close();
  }
});

test("refused mailbox credentials classify as a permanent authentication failure", async () => {
  const stub = await startStubSmtp("implicit-tls", { authCode: 535 });
  try {
    const email = stubProvider(stub);
    await assert.rejects(
      email.send(smtpMessage("inc-smtp-auth"), "inc-smtp-auth-email", ["lead@example.org"]),
      (error: unknown) => {
        assert.ok(error instanceof CasProviderError);
        assert.equal(error.classification, "authentication");
        assert.equal(error.retryable, false);
        assert.match(error.message, /app password/);
        return true;
      },
    );
    assert.equal(stub.messages.length, 0);
  } finally {
    await stub.close();
  }
});

test("a transient 4xx is retryable and the retry skips the already-accepted recipient via the ledger", async () => {
  let backupAttempts = 0;
  const stub = await startStubSmtp("implicit-tls", {
    rcptCodeFor: (recipient) =>
      recipient.includes("backup") && ++backupAttempts === 1 ? 451 : 250,
  });
  try {
    const email = stubProvider(stub);
    const recipients = ["lead@example.org", "backup@example.org"];
    const message = smtpMessage("inc-smtp-retry");

    await assert.rejects(
      email.send(message, "inc-smtp-retry-email", recipients),
      (error: unknown) => {
        assert.ok(error instanceof CasProviderError);
        assert.equal(error.classification, "server-outage");
        assert.equal(error.retryable, true);
        // The masked recipient rides along so the journal names whose
        // delivery failed without storing the address.
        assert.ok(error.message.includes(`recipient ${maskRecipient("backup@example.org")}`));
        assert.ok(!error.message.includes("backup@example.org"));
        return true;
      },
    );
    assert.equal(stub.messages.length, 1); // only lead@example.org accepted

    // Retry: the ledger skips lead@example.org; only the failed recipient
    // is re-sent. A second retry sends nothing.
    await email.send(message, "inc-smtp-retry-email", recipients);
    await email.send(message, "inc-smtp-retry-email", recipients);
    assert.equal(stub.messages.length, 2);
    assert.match(stub.messages[1].raw, /^To: backup@example\.org\r$/m);

    const ledger = await db
      .select()
      .from(casProviderDeliveries)
      .where(eq(casProviderDeliveries.incidentId, "inc-smtp-retry"));
    assert.deepEqual(
      ledger.map((row) => row.recipientMasked).sort(),
      [maskRecipient("lead@example.org"), maskRecipient("backup@example.org")].sort(),
    );
  } finally {
    await stub.close();
  }
});

test("a rejection echoing the recipient address is redacted before it can be journaled", async () => {
  const stub = await startStubSmtp("implicit-tls", { rcptCodeFor: () => 550 });
  try {
    const email = stubProvider(stub);
    await assert.rejects(
      email.send(smtpMessage("inc-smtp-550"), "inc-smtp-550-email", ["gone@example.org"]),
      (error: unknown) => {
        assert.ok(error instanceof CasProviderError);
        assert.equal(error.classification, "rejected");
        assert.equal(error.retryable, false);
        // The stub's 550 echoed <gone@example.org>; the persisted message
        // must carry only the masked form.
        assert.ok(!error.message.includes("gone@example.org"));
        assert.ok(error.message.includes(maskRecipient("gone@example.org")));
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("missing mailbox credentials fail loudly at send time without connecting", async () => {
  const stub = await startStubSmtp("implicit-tls");
  try {
    const email = createSmtpEmailProvider({
      host: "localhost",
      port: stub.port,
      secure: true,
      caFile: CERT_PATH,
      recipients: [],
    });
    await assert.rejects(
      email.send(smtpMessage("inc-smtp-nocreds"), "inc-smtp-nocreds-email", ["lead@example.org"]),
      (error: unknown) => {
        assert.ok(error instanceof CasProviderError);
        assert.equal(error.classification, "not-configured");
        assert.match(error.message, /CAS_EMAIL_SMTP_USER/);
        return true;
      },
    );
    assert.equal(stub.connections(), 0);
  } finally {
    await stub.close();
  }
});

test("a recipient containing a line break is refused as header injection before any connection", async () => {
  const stub = await startStubSmtp("implicit-tls");
  try {
    const email = stubProvider(stub);
    await assert.rejects(
      email.send(smtpMessage("inc-smtp-injection"), "inc-smtp-injection-email", ["lead@example.org\r\nBCC: attacker@example.net"]),
      /header injection|line break/,
    );
    assert.equal(stub.connections(), 0);
  } finally {
    await stub.close();
  }
});

test("a bad CA file path fails loudly when the adapter is built (boot time), not mid-incident", () => {
  assert.throws(
    () =>
      createSmtpEmailProvider({
        host: "localhost",
        port: 465,
        secure: true,
        user: "u",
        password: "p",
        caFile: "/nonexistent/ca.pem",
        recipients: [],
      }),
    /ENOENT/,
  );
});
