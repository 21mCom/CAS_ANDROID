/**
 * Contract tests for the mailbox health probe worker
 * (lib/cas-email-health-worker.ts).
 *
 * The probe exists so a silently rotted mailbox app password (revoked,
 * expired, invalidated by a password reset) surfaces as console-visible
 * email-channel health instead of a dead-lettered alert mid-incident. These
 * tests run the worker against the shared stub SMTP server over real TLS and
 * prove:
 *  - the probe authenticates and sends NO mail (no MAIL/RCPT/DATA, no
 *    message recorded by the stub),
 *  - a refused app password (535) lands in the registry as a classified
 *    "authentication" failure the console turns into a red warning,
 *  - a healthy mailbox records an OK probe,
 *  - with no SMTP target (HTTPS provider or nothing configured) the tick is
 *    a skip with an explanatory note, never a false alarm,
 *  - console-managed account rows take precedence over the environment,
 *    matching the delivery path.
 *
 * No database: account lookups and the env are injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { startStubSmtp, SMTP_STUB_CERT_PATH, type StubSmtpServer } from "./cas-smtp-stub";
import { startCasEmailHealthWorker, type CasEmailHealthWorkerHandle } from "./cas-email-health-worker";
import {
  getCasEmailChannelHealth,
  resetCasEmailChannelHealth,
  type CasEmailChannelHealth,
} from "./cas-email-health";
import type { EmailAccountRow } from "./cas-email-accounts";

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function smtpEnv(stub: StubSmtpServer): NodeJS.ProcessEnv {
  // The env TLS-mode rule keys on the port number (465 = implicit TLS);
  // the stub port is dynamic, so the client takes the STARTTLS path and the
  // stub runs in starttls mode, with its fixture cert trusted via CA file.
  return {
    CAS_EMAIL_SMTP_HOST: "localhost",
    CAS_EMAIL_SMTP_PORT: String(stub.port),
    CAS_EMAIL_SMTP_USER: "alerts@example.org",
    CAS_EMAIL_SMTP_PASSWORD: "app-password",
    CAS_EMAIL_SMTP_CA_FILE: SMTP_STUB_CERT_PATH,
  };
}

const noAccounts = async () => undefined;

/** Tolerant startup polling: wait until the probe tick has settled. */
async function waitForHealth(
  predicate: (health: CasEmailChannelHealth) => boolean,
  timeoutMs = 5_000,
): Promise<CasEmailChannelHealth> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = getCasEmailChannelHealth();
    if (health && predicate(health)) return health;
    if (Date.now() > deadline) {
      assert.fail(`probe registry did not reach the expected state; last seen: ${JSON.stringify(health)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withWorker(
  options: Parameters<typeof startCasEmailHealthWorker>[0],
  body: () => Promise<void>,
) {
  resetCasEmailChannelHealth();
  const worker: CasEmailHealthWorkerHandle = startCasEmailHealthWorker({
    initialDelayMs: 5,
    intervalMs: 60_000,
    log: silentLog,
    getAccount: noAccounts,
    ...options,
  });
  try {
    await body();
  } finally {
    await worker.stop();
    resetCasEmailChannelHealth();
  }
}

test("a healthy mailbox records an OK probe and sends no email", async () => {
  const stub = await startStubSmtp("starttls");
  try {
    await withWorker({ env: smtpEnv(stub) }, async () => {
      const health = await waitForHealth((h) => h.state === "ok");
      assert.equal(health.target, "environment");
      assert.ok(health.lastProbeAt);
      assert.equal(health.lastFailure, null);
      // The probe must authenticate without sending anything.
      const commands = stub.transcript.map((entry) => entry.line.split(" ")[0]);
      assert.ok(commands.includes("AUTH"));
      assert.ok(!commands.includes("MAIL"), `probe must not start a send: ${commands.join(",")}`);
      assert.ok(!commands.includes("DATA"), `probe must not send data: ${commands.join(",")}`);
      assert.equal(stub.messages.length, 0);
      // Credentials only ever crossed the wire encrypted.
      assert.ok(stub.authLogins.every((login) => login.tls));
    });
  } finally {
    await stub.close();
  }
});

test("a refused app password records a classified authentication failure", async () => {
  const stub = await startStubSmtp("starttls", { authCode: 535 });
  try {
    await withWorker({ env: smtpEnv(stub) }, async () => {
      const health = await waitForHealth((h) => h.state === "failed");
      assert.equal(health.target, "environment");
      assert.equal(health.lastFailure?.classification, "authentication");
      assert.match(health.lastFailure?.message ?? "", /Mailbox login check failed/);
      // The failure text is the redacted, classified message from cas-smtp —
      // never the credential.
      assert.ok(!(health.lastFailure?.message ?? "").includes("app-password"));
      assert.equal(stub.messages.length, 0);
    });
  } finally {
    await stub.close();
  }
});

test("an unreachable mailbox records a retryable-classified failure, not a crash", async () => {
  // Port 1 refuses connections immediately — a network-class failure.
  await withWorker(
    {
      env: {
        CAS_EMAIL_SMTP_HOST: "127.0.0.1",
        CAS_EMAIL_SMTP_PORT: "1",
        CAS_EMAIL_SMTP_USER: "alerts@example.org",
        CAS_EMAIL_SMTP_PASSWORD: "app-password",
      },
    },
    async () => {
      const health = await waitForHealth((h) => h.state === "failed");
      assert.ok(health.lastFailure);
      assert.notEqual(health.lastFailure?.classification, "authentication");
    },
  );
});

test("no email configuration at all is a skip with a note, never a false alarm", async () => {
  await withWorker({ env: {} }, async () => {
    const health = await waitForHealth((h) => h.state === "skipped");
    assert.equal(health.target, "none");
    assert.match(health.note ?? "", /No email delivery is configured/);
    assert.equal(health.lastFailure, null);
  });
});

test("HTTPS-provider email delivery skips the SMTP probe with the reason recorded", async () => {
  await withWorker(
    { env: { CAS_EMAIL_PROVIDER_URL: "https://mail-provider.example/submit" } },
    async () => {
      const health = await waitForHealth((h) => h.state === "skipped");
      assert.match(health.note ?? "", /CAS_EMAIL_PROVIDER_URL/);
      assert.equal(health.lastFailure, null);
    },
  );
});

test("a console-managed primary account owns the probe target over the environment", async () => {
  const stub = await startStubSmtp("starttls");
  try {
    const row = {
      slot: "primary",
      host: "localhost",
      port: stub.port,
      smtpUser: "console-alerts@example.org",
      password: "console-app-password",
      fromAddress: null,
      updatedAt: new Date(),
    } as EmailAccountRow;
    await withWorker(
      {
        // Env points at a port nothing listens on: if the worker probed the
        // environment instead of the console row, this test would fail.
        env: {
          CAS_EMAIL_SMTP_HOST: "127.0.0.1",
          CAS_EMAIL_SMTP_PORT: "1",
          CAS_EMAIL_SMTP_USER: "env@example.org",
          CAS_EMAIL_SMTP_PASSWORD: "env-password",
          // The internal-CA bundle applies to console accounts too.
          CAS_EMAIL_SMTP_CA_FILE: SMTP_STUB_CERT_PATH,
        },
        getAccount: async (slot) => (slot === "primary" ? row : undefined),
      },
      async () => {
        const health = await waitForHealth((h) => h.state === "ok");
        assert.equal(health.target, "console");
        assert.equal(
          stub.authLogins.some((login) => login.decoded.includes("console-alerts@example.org")),
          true,
        );
        assert.equal(stub.messages.length, 0);
      },
    );
  } finally {
    await stub.close();
  }
});

test("a dead fallback mailbox is reported even while the primary still logs in", async () => {
  const good = await startStubSmtp("starttls");
  const dead = await startStubSmtp("starttls", { authCode: 535 });
  try {
    const account = (slot: string, stub: StubSmtpServer, user: string) =>
      ({
        slot,
        host: "localhost",
        port: stub.port,
        smtpUser: user,
        password: "app-password",
        fromAddress: null,
        updatedAt: new Date(),
      }) as EmailAccountRow;
    await withWorker(
      {
        env: { CAS_EMAIL_SMTP_CA_FILE: SMTP_STUB_CERT_PATH },
        getAccount: async (slot) =>
          slot === "primary"
            ? account("primary", good, "primary@example.org")
            : account("fallback", dead, "fallback@example.org"),
      },
      async () => {
        const health = await waitForHealth((h) => h.state === "failed");
        assert.equal(health.target, "console");
        assert.equal(health.lastFailure?.classification, "authentication");
        assert.match(health.lastFailure?.message ?? "", /fallback mailbox/);
        assert.equal(good.messages.length + dead.messages.length, 0);
      },
    );
  } finally {
    await good.close();
    await dead.close();
  }
});
