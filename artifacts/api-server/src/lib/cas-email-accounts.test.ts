import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  casEmailAccounts,
  casIncidents,
  casProviderDeliveries,
  casResponders,
} from "@workspace/db/schema";
import {
  CasProviderError,
  createConsoleEmailProvider,
  createSmtpEmailProvider,
} from "./delivery-providers";
import {
  deleteEmailAccount,
  emailDeliverySource,
  getEmailAccount,
  saveEmailAccount,
} from "./cas-email-accounts";
import { deliverableGatewayTransports } from "./cas-delivery-config";
import { maskRecipient } from "./cas-device-delivery";
import { probeSmtpAccount } from "./cas-smtp";
import { SMTP_STUB_CERT_PATH, startStubSmtp } from "./cas-smtp-stub";

/**
 * Console-managed email accounts (the Email delivery page): storage,
 * precedence over the environment config, primary-to-fallback redundancy,
 * and the connect-and-authenticate probe behind "Test connection".
 */

// Console sends trust the stub's self-signed fixture the same way a
// self-hosted relay would: via the CA-file setting.
const ACCOUNT_ENV = { CAS_EMAIL_SMTP_CA_FILE: SMTP_STUB_CERT_PATH } as NodeJS.ProcessEnv;

const STUB_CA_PEM = readFileSync(SMTP_STUB_CERT_PATH, "utf8");

const baseMessage = { transport: "EMAIL", priority: "P1", body: "CAS P1 alert body" } as const;

before(async () => {
  await db.delete(casProviderDeliveries);
  await db.delete(casEmailAccounts);
  await db.delete(casResponders);
  await db
    .insert(casIncidents)
    .values(
      ["inc-acct-env", "inc-acct-1", "inc-acct-fallback", "inc-acct-bothfail"].map((id) => ({
        id,
        priority: "P1",
        status: "ACTIVE_UNACKED",
      })),
    )
    .onConflictDoNothing();
});

test("account save/read/delete round-trips and drives the delivery source", async () => {
  assert.deepEqual(await emailDeliverySource({} as NodeJS.ProcessEnv), {
    source: "none",
    environment: { smtpConfigured: false, providerConfigured: false },
  });
  await saveEmailAccount("primary", {
    host: "smtp.example.org",
    port: 465,
    user: "cas-alerts@example.org",
    password: "app-password",
  });
  const saved = await getEmailAccount("primary");
  assert.equal(saved?.host, "smtp.example.org");
  assert.equal(saved?.smtpUser, "cas-alerts@example.org");
  // The password is stored server-side (the sender must present it); the
  // console API never returns it.
  assert.equal(saved?.password, "app-password");
  assert.equal((await emailDeliverySource({} as NodeJS.ProcessEnv)).source, "console");
  assert.equal(await deleteEmailAccount("primary"), true);
  assert.equal(await deleteEmailAccount("primary"), false);
  // With the console row gone the environment config owns the channel again.
  const envStatus = await emailDeliverySource({
    CAS_EMAIL_SMTP_HOST: "smtp.example.org",
  } as NodeJS.ProcessEnv);
  assert.equal(envStatus.source, "environment");
  assert.equal(envStatus.environment.smtpConfigured, true);
});

test("a console primary account is used for sends, ahead of any env adapter", async () => {
  const consoleStub = await startStubSmtp("starttls");
  const envStub = await startStubSmtp("starttls");
  try {
    await saveEmailAccount("primary", {
      host: "localhost",
      port: consoleStub.port,
      user: "cas-alerts@example.org",
      password: "pw",
    });
    const envAdapter = createSmtpEmailProvider({
      host: "localhost",
      port: envStub.port,
      secure: false,
      user: "env@example.org",
      password: "pw",
      caFile: SMTP_STUB_CERT_PATH,
      recipients: [],
    });
    const email = createConsoleEmailProvider(ACCOUNT_ENV, envAdapter);
    await email.send(
      { ...baseMessage, incidentId: "inc-acct-1" },
      "inc-acct-1-email",
      ["lead@example.org"],
    );
    assert.equal(consoleStub.messages.length, 1);
    assert.equal(envStub.connections(), 0); // console settings own the channel
  } finally {
    await consoleStub.close();
    await envStub.close();
    await deleteEmailAccount("primary");
  }
});

test("the env adapter still serves when no console primary exists", async () => {
  const envStub = await startStubSmtp("starttls");
  try {
    const envAdapter = createSmtpEmailProvider({
      host: "localhost",
      port: envStub.port,
      secure: false,
      user: "env@example.org",
      password: "pw",
      caFile: SMTP_STUB_CERT_PATH,
      recipients: [],
    });
    const email = createConsoleEmailProvider(ACCOUNT_ENV, envAdapter);
    await email.send(
      { ...baseMessage, incidentId: "inc-acct-env" },
      "inc-acct-env-email",
      ["lead@example.org"],
    );
    assert.equal(envStub.messages.length, 1);
  } finally {
    await envStub.close();
  }
});

test("a primary failure falls back to the second account for the same recipient", async () => {
  const primary = await startStubSmtp("starttls", { authCode: 535 });
  const fallback = await startStubSmtp("starttls");
  try {
    await saveEmailAccount("primary", {
      host: "localhost",
      port: primary.port,
      user: "primary@example.org",
      password: "bad",
    });
    await saveEmailAccount("fallback", {
      host: "localhost",
      port: fallback.port,
      user: "fallback@example.org",
      password: "good",
    });
    const email = createConsoleEmailProvider(ACCOUNT_ENV, undefined);
    await email.send(
      { ...baseMessage, incidentId: "inc-acct-fallback" },
      "inc-acct-fallback-email",
      ["lead@example.org"],
    );
    assert.equal(primary.authLogins.length, 1); // primary refused the password
    assert.equal(primary.messages.length, 0); // no message crossed the primary
    assert.equal(fallback.messages.length, 1); // the fallback delivered it
    // Exactly one acceptance is recorded — a retry skips this recipient.
    const ledger = await db
      .select()
      .from(casProviderDeliveries)
      .where(eq(casProviderDeliveries.incidentId, "inc-acct-fallback"));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].recipientMasked, maskRecipient("lead@example.org"));
  } finally {
    await primary.close();
    await fallback.close();
    await deleteEmailAccount("primary");
    await deleteEmailAccount("fallback");
  }
});

test("when both accounts fail, the error names both legs and stays masked", async () => {
  const primary = await startStubSmtp("starttls", { authCode: 535 });
  const fallback = await startStubSmtp("starttls", { rcptCodeFor: () => 550 });
  try {
    await saveEmailAccount("primary", {
      host: "localhost",
      port: primary.port,
      user: "primary@example.org",
      password: "bad",
    });
    await saveEmailAccount("fallback", {
      host: "localhost",
      port: fallback.port,
      user: "fallback@example.org",
      password: "good",
    });
    const email = createConsoleEmailProvider(ACCOUNT_ENV, undefined);
    await assert.rejects(
      email.send(
        { ...baseMessage, incidentId: "inc-acct-bothfail" },
        "inc-acct-bothfail-email",
        ["gone@example.org"],
      ),
      (error: unknown) => {
        assert.ok(error instanceof CasProviderError);
        assert.equal(error.classification, "authentication"); // the primary's leg leads
        assert.equal(error.retryable, false);
        assert.match(error.message, /fallback account also failed/);
        assert.match(error.message, /rejected/); // the fallback's classification
        // Recipient and account logins never persist raw.
        assert.ok(!error.message.includes("gone@example.org"));
        assert.ok(error.message.includes(maskRecipient("gone@example.org")));
        assert.ok(!error.message.includes("primary@example.org"));
        return true;
      },
    );
  } finally {
    await primary.close();
    await fallback.close();
    await deleteEmailAccount("primary");
    await deleteEmailAccount("fallback");
  }
});

test("email counts as deliverable with only a console account and a console responder", async () => {
  assert.deepEqual(await deliverableGatewayTransports({} as NodeJS.ProcessEnv), []);
  await saveEmailAccount("primary", {
    host: "smtp.example.org",
    port: 465,
    user: "u@example.org",
    password: "pw",
  });
  // Account configured but nobody to email yet.
  assert.deepEqual(await deliverableGatewayTransports({} as NodeJS.ProcessEnv), []);
  const now = new Date();
  await db.insert(casResponders).values({
    id: "rsp-acct-1",
    name: "Lead responder",
    enabled: true,
    emailAddress: "lead@example.org",
    createdAt: now,
    updatedAt: now,
  });
  assert.deepEqual(await deliverableGatewayTransports({} as NodeJS.ProcessEnv), ["EMAIL"]);
  await deleteEmailAccount("primary");
});

test("the connection probe authenticates without sending and classifies failures", async () => {
  const good = await startStubSmtp("starttls");
  const refusing = await startStubSmtp("starttls", { authCode: 535 });
  try {
    await probeSmtpAccount({
      host: "localhost",
      port: good.port,
      secure: false,
      user: "cas-alerts@example.org",
      password: "pw",
      caPem: STUB_CA_PEM,
    });
    assert.equal(good.authLogins.length, 1);
    assert.equal(good.messages.length, 0); // the probe never sends mail
    await assert.rejects(
      probeSmtpAccount({
        host: "localhost",
        port: refusing.port,
        secure: false,
        user: "cas-alerts@example.org",
        password: "wrong",
        caPem: STUB_CA_PEM,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CasProviderError);
        assert.equal(error.classification, "authentication");
        assert.equal(error.retryable, false);
        assert.ok(!error.message.includes("cas-alerts@example.org"));
        return true;
      },
    );
    await assert.rejects(
      probeSmtpAccount({ host: "localhost", port: 1, secure: false }),
      /username or app password/,
    );
  } finally {
    await good.close();
    await refusing.close();
  }
});
