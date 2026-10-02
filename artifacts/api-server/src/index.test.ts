/**
 * Live boot-wiring proof for the weekly mailbox health probe
 * (lib/cas-email-health-worker.ts started from src/index.ts).
 *
 * The worker's unit suite (cas-email-health-worker.test.ts) drives
 * startCasEmailHealthWorker directly, so it cannot catch a server that never
 * starts the worker at all — a removed startup call or a mis-wired interval
 * would leave the console permanently silent while looking "tested". This
 * suite instead boots the REAL server entrypoint (src/index.ts) as a child
 * process against the disposable review database, with the probe cadence
 * shortened through the operator knobs (CAS_EMAIL_PROBE_DELAY_MS /
 * CAS_EMAIL_PROBE_INTERVAL_MS) and the mailbox pointed at the stub SMTP
 * server, then proves over HTTP:
 *
 *  - the worker is scheduled by server boot: the probe result lands in the
 *    console-visible status payload (/api/cas/outbox/status -> email) with
 *    the configured cadence metadata (probeIntervalMs), without any test
 *    code touching the worker;
 *  - the interval timer fires, not just the after-boot delay: the stub sees
 *    a second AUTH login on the shortened cadence;
 *  - the probe stays AUTH-only (no MAIL/DATA, no message recorded);
 *  - shutdown stops the worker cleanly (SIGTERM exits 0).
 *
 * Wiring coverage: deleting the startCasEmailHealthWorker() call in
 * src/index.ts fails this suite twice — the static source guard below fails
 * immediately, and the live test times out because the status payload's
 * email health never leaves null.
 *
 * Safety: the child boots WITHOUT the test-harness markers (NODE_ENV=test /
 * CAS_TEST_DISPOSABLE_DB=1) precisely because index.ts disables the probe
 * under them — that is the behavior under test. The workspace may hold live
 * mailbox secrets, so the child gets a fully overridden CAS_EMAIL_SMTP_* set
 * aimed at the stub; the probe never touches a real mailbox. No incident is
 * ever triggered, so no delivery path runs. The database is the disposable
 * review database, proven by the boot guard below.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as httpCreateServer } from "node:http";
import { test } from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { db } from "@workspace/db";
import { casEmailAccounts } from "@workspace/db/schema";
import { SMTP_STUB_CERT_PATH, startStubSmtp } from "./lib/cas-smtp-stub";
import { assertDisposableTestDatabase } from "./lib/cas-test-db-guard";

// The child server writes enrollment rows to whatever DATABASE_URL points
// at: refuse to boot unless the contract runner's disposable review database
// is provably the target (never the dev database).
assertDisposableTestDatabase();

const apiServerDirectory = fileURLToPath(new URL("../", import.meta.url));

// Shortened cadence knobs: the first probe lands ~0.3s after boot and the
// interval timer re-fires every 1.5s, so a full schedule cycle (boot delay +
// interval tick) is observable inside a test window.
const PROBE_DELAY_MS = 300;
const PROBE_INTERVAL_MS = 1_500;
const ALERT_TOKEN = "cas-test-boot-alert-token";

async function findFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

type BootedServer = {
  child: ChildProcess;
  baseUrl: string;
  output: () => string;
};

async function bootApiServer(
  env: NodeJS.ProcessEnv,
  options: { keepHarnessMarkers?: boolean } = {},
): Promise<BootedServer> {
  const port = await findFreePort();
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  // Strip the test-harness markers: index.ts deliberately skips the probe
  // worker under them, and this suite proves the production boot path. The
  // burst-pinger isolation test below keeps them on purpose.
  if (!options.keepHarnessMarkers) {
    delete childEnv.NODE_ENV;
    delete childEnv.CAS_TEST_DISPOSABLE_DB;
    delete childEnv.CAS_TEST_EXPECTED_DATABASE_NAME;
    delete childEnv.CAS_TEST_FORBIDDEN_DATABASE_URL;
  }
  delete childEnv.CAS_TRUST_PROXY;
  // Never inherit an HTTPS mail provider or the deployment's real mailbox:
  // every probe the child runs must land on the stub below.
  delete childEnv.CAS_EMAIL_PROVIDER_URL;
  // Same quarantine for the auth-burst security monitor: this suite boots
  // WITHOUT the harness markers (that is the behavior under test), so an
  // inherited CAS_AUTH_BURST_ALERT_URL would start the pinger for real and
  // let the child ping — or flip — the operator's live check.
  delete childEnv.CAS_AUTH_BURST_ALERT_URL;
  Object.assign(childEnv, env, { PORT: String(port), HOST: "127.0.0.1" });

  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "src/index.ts"],
    { cwd: apiServerDirectory, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let captured = "";
  child.stdout?.on("data", (chunk) => (captured += chunk));
  child.stderr?.on("data", (chunk) => (captured += chunk));

  const baseUrl = `http://127.0.0.1:${port}/api`;
  // Generous readiness window: a cold tsx compile of the API graph on a
  // loaded box demonstrably exceeds 20s (same budget as cas.test.ts).
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `API process exited before becoming ready: ${child.exitCode}\n${captured}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return { child, baseUrl, output: () => captured };
    } catch {
      // The child process has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  await once(child, "exit");
  throw new Error(`Timed out waiting for API process to become ready\n${captured}`);
}

/**
 * The dev logger writes through an async transport thread (pino-pretty), so
 * log lines land in the child's stdout after the fact they describe — every
 * log assertion must poll, never check once.
 */
async function waitForOutput(
  server: BootedServer,
  pattern: RegExp,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(server.output())) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`server log never showed ${what} (${pattern})\n${server.output()}`);
}

async function stopApiProcess(server: BootedServer): Promise<number | null> {
  if (server.child.exitCode !== null) return server.child.exitCode;
  server.child.kill("SIGTERM");
  const result = await Promise.race([
    once(server.child, "exit").then(([code]) => code as number | null),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000)),
  ]);
  if (result === "timeout") {
    server.child.kill("SIGKILL");
    await once(server.child, "exit");
    assert.fail(`API process ignored SIGTERM for 15s\n${server.output()}`);
  }
  return result;
}

test("src/index.ts wires the mailbox probe worker into server boot", () => {
  // Fast, explicit guard: if the startup call is deleted from src/index.ts
  // this fails immediately instead of after the live test's poll timeout.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /startCasEmailHealthWorker\(\)/,
    "src/index.ts no longer starts the mailbox probe worker at boot — a silently dead alert mailbox would never reach the console",
  );
});

test("src/index.ts starts the auth-burst pinger only outside the test-harness branch", () => {
  // Static guard for the isolation rule: the pinger start must sit in the
  // else-branch of the testHarnessDeliveryForced check, never on the
  // unconditional boot path — an inherited CAS_AUTH_BURST_ALERT_URL in a
  // harness process would ping (or flip) the operator's real security
  // monitor, the same risk class as live provider delivery.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(testHarnessDeliveryForced\(\)\) \{[\s\S]*?\} else \{[\s\S]*?authBurstAlert = startCasAuthBurstAlert\(\);/,
    "src/index.ts starts the auth-burst pinger outside the test-harness guard — harness runs could contact the live security monitor",
  );
});

test("a harness-marked server never contacts the auth-burst monitor", async () => {
  // Live proof of the same rule: boot the real entrypoint WITH the harness
  // markers kept and CAS_AUTH_BURST_ALERT_URL pointed at a stub check. The
  // pinger must never start (no startup log line) and the stub must see zero
  // requests — even the quiet-time success ping would flip a real check.
  const hits: string[] = [];
  const stub = httpCreateServer((req, res) => {
    hits.push(req.url ?? "");
    res.statusCode = 200;
    res.end("OK");
  });
  stub.listen(0, "127.0.0.1");
  await once(stub, "listening");
  const stubPort = (stub.address() as AddressInfo).port;

  let server: BootedServer | undefined;
  try {
    server = await bootApiServer(
      {
        CAS_ALERT_TOKEN: ALERT_TOKEN,
        CAS_AUTH_BURST_ALERT_URL: `http://127.0.0.1:${stubPort}/burst-check`,
      },
      { keepHarnessMarkers: true },
    );
    await waitForOutput(server, /Test harness detected/, 15_000, "the harness warning");
    assert.doesNotMatch(
      server.output(),
      /CAS auth burst alert pinger started/,
      `pinger started under harness markers\n${server.output()}`,
    );
    // Give any mis-wired pinger a window to fire its first ping.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(
      hits.length,
      0,
      `harness-marked server contacted the burst monitor: ${hits.join(",")}\n${server.output()}`,
    );
    const exitCode = await stopApiProcess(server);
    assert.equal(exitCode, 0, `server did not shut down cleanly\n${server.output()}`);
  } finally {
    if (server && server.child.exitCode === null) {
      server.child.kill("SIGKILL");
      await once(server.child, "exit").catch(() => {});
    }
    stub.close();
    await once(stub, "close").catch(() => {});
  }
});

test("a booted server schedules and fires the mailbox probe on its configured cadence", async (t) => {
  // The probe target resolves console account rows first; other suites share
  // this disposable database, so clear any rows they left to keep the probe
  // deterministically on the environment target aimed at the stub.
  await db.delete(casEmailAccounts);

  const stub = await startStubSmtp("starttls");
  let server: BootedServer | undefined;
  try {
    server = await bootApiServer({
      CAS_ALERT_TOKEN: ALERT_TOKEN,
      CAS_EMAIL_SMTP_HOST: "localhost",
      CAS_EMAIL_SMTP_PORT: String(stub.port),
      CAS_EMAIL_SMTP_USER: "boot-probe@example.org",
      CAS_EMAIL_SMTP_PASSWORD: "boot-probe-app-password",
      CAS_EMAIL_SMTP_CA_FILE: SMTP_STUB_CERT_PATH,
      CAS_EMAIL_PROBE_DELAY_MS: String(PROBE_DELAY_MS),
      CAS_EMAIL_PROBE_INTERVAL_MS: String(PROBE_INTERVAL_MS),
    });

    // The probe worker must be the one started by server boot, not by any
    // test code: the child logged the startup and did NOT take the
    // test-harness branch that disables the probe.
    await waitForOutput(
      server,
      /CAS email mailbox probe worker started/,
      15_000,
      "the probe worker startup",
    );
    assert.doesNotMatch(server.output(), /Test harness detected/);

    // Console reads are credential-gated: enroll a device credential through
    // the real enrollment endpoint, then read the status payload with it.
    const enrollment = await fetch(`${server.baseUrl}/cas/devices/enroll`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ALERT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "boot-probe-test" }),
    });
    if (enrollment.status !== 201) {
      assert.fail(`enrollment failed: ${enrollment.status} ${await enrollment.text()}`);
    }
    const { token } = (await enrollment.json()) as { token: string };
    const authHeaders = { authorization: `Bearer ${token}` };

    type StatusPayload = {
      email: {
        probeIntervalMs: number;
        state: string;
        target: string;
        lastProbeAt: string | null;
        lastFailure: { classification: string; message: string } | null;
      } | null;
    };
    const readStatus = async (): Promise<StatusPayload> => {
      const response = await fetch(`${server!.baseUrl}/cas/outbox/status`, {
        headers: authHeaders,
      });
      if (response.status !== 200) {
        assert.fail(`status read failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as StatusPayload;
    };

    // The booted server must schedule and complete a probe cycle on its own:
    // poll the console-visible state until the first probe lands.
    let status: StatusPayload | undefined;
    const firstProbeDeadline = Date.now() + 30_000;
    while (Date.now() < firstProbeDeadline) {
      status = await readStatus();
      if (status.email?.state === "ok") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      status?.email,
      `probe health never appeared in the status payload — did src/index.ts start the worker?\n${server.output()}`,
    );
    assert.equal(
      status.email.state,
      "ok",
      `probe did not reach ok within 30s: ${JSON.stringify(status.email)}\n${server.output()}`,
    );
    // Cadence metadata: the console must see the interval the server was
    // configured with, so a mis-wired schedule is visible, not silent.
    assert.equal(status.email.probeIntervalMs, PROBE_INTERVAL_MS);
    assert.equal(status.email.target, "environment");
    assert.ok(status.email.lastProbeAt);
    assert.equal(status.email.lastFailure, null);
    await waitForOutput(server, /CAS email mailbox probe passed/, 10_000, "a passing probe");

    // The weekly cadence is an interval timer, not a one-shot: with the
    // shortened knob the stub must see a second AUTH login from a later tick.
    const secondProbeDeadline = Date.now() + 15_000;
    while (stub.authLogins.length < 2 && Date.now() < secondProbeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      stub.authLogins.length >= 2,
      `interval timer never re-fired the probe (saw ${stub.authLogins.length} login)\n${server.output()}`,
    );

    // Every scheduled cycle stayed AUTH-only: nothing was ever sent.
    const commands = stub.transcript.map((entry) => entry.line.split(" ")[0]);
    assert.ok(!commands.includes("MAIL"), `probe must not start a send: ${commands.join(",")}`);
    assert.ok(!commands.includes("DATA"), `probe must not send data: ${commands.join(",")}`);
    assert.equal(stub.messages.length, 0);
    assert.ok(stub.authLogins.every((login) => login.tls));
    assert.ok(
      stub.authLogins.every((login) => login.decoded.includes("boot-probe@example.org")),
      "the child probed with credentials other than the stub's — it must never touch the real mailbox",
    );

    // Shutdown stops the worker cleanly.
    const exitCode = await stopApiProcess(server);
    assert.equal(exitCode, 0, `server did not shut down cleanly\n${server.output()}`);
    await waitForOutput(server, /CAS email mailbox probe worker stopped/, 5_000, "the worker stop");
  } finally {
    if (server && server.child.exitCode === null) {
      server.child.kill("SIGKILL");
      await once(server.child, "exit").catch(() => {});
    }
    await stub.close();
  }
});
