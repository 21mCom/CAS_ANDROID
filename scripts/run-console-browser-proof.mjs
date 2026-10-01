// Drives the committed real-browser console proofs
// (artifacts/covert-alert-system/e2e/*.spec.ts): provisions a disposable
// PostgreSQL cluster, boots the api-server with a fixed test-only enrollment
// credential and this console's built bundle behind `vite preview` with /api
// proxied, then runs the Playwright suite. For the email-probe proof it also
// generates a throwaway TLS identity and serves a fake SMTP endpoint that
// always refuses AUTH. The api-server runs in device-direct SMS mode
// (CAS_SMS_DELIVERY_MODE=device) so the handset-SIM chip proof can exercise
// the real trigger → device receipt path; no proof's trigger queues a
// gateway channel (email provider variables are cleared and the responders
// table is empty), so no server-side delivery can fire. Everything is torn
// down on pass or fail.
//
// Prerequisites: pnpm install, Playwright's chromium (`pnpm --filter
// @workspace/covert-alert-system exec playwright install chromium`, or set
// CAS_E2E_CHROMIUM_PATH to an existing executable), openssl on PATH
// (throwaway cert for the fake SMTP server), and initdb/pg_ctl/psql on
// PATH (same as scripts/run-cas-contract-tests.mjs).

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWithDisposableReviewDatabase } from "./disposable-review-database.mjs";

// Fixed, test-only credential. It lives only inside the disposable harness
// (throwaway database, localhost-only servers) and authenticates nothing real.
const ALERT_TOKEN = "e2e-browser-proof-alert-token";
const INCIDENT_ID = "e2e-mid-session-lock-incident";

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve a local port");
  }
  const { port } = address;
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return port;
}

async function waitForHttpOk(url, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`${label} did not come up at ${url} within ${timeoutMs}ms (${lastError})`);
}

function stopProcess(child, label) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise();
    const killTimer = setTimeout(() => {
      console.warn(`${label} ignored SIGTERM; sending SIGKILL`);
      child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolvePromise();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Throwaway TLS identity for the fake SMTP server: the api-server's probe
 * client never disables certificate verification, so the STARTTLS handshake
 * needs a cert the server explicitly trusts (CAS_EMAIL_SMTP_CA_FILE). The
 * self-signed cert doubles as its own CA; it lives only for this run.
 */
function generateThrowawaySmtpIdentity(run) {
  const directory = mkdtempSync(join(tmpdir(), "cas-e2e-smtp-"));
  const keyFile = join(directory, "key.pem");
  const certFile = join(directory, "cert.pem");
  run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyFile,
    "-out", certFile,
    "-days", "3650",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
  ]);
  return { keyFile, certFile };
}

/**
 * Starts the fake SMTP server (scripts/fake-smtp-auth-refusal-server.mjs) as
 * its own process and resolves with its port once it reports listening. It
 * cannot live in this process: the harness drives the proof with synchronous
 * spawns, which would freeze an in-process server's event loop for the whole
 * Playwright run and every probe would socket-timeout.
 */
function startFakeSmtpServer({ keyFile, certFile }) {
  const child = spawn(
    "node",
    [join(import.meta.dirname, "fake-smtp-auth-refusal-server.mjs"), keyFile, certFile],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    const onData = (chunk) => {
      stdout += chunk;
      const match = /FAKE_SMTP_PORT=(\d+)/.exec(stdout);
      if (match) {
        cleanup();
        resolvePromise({ port: Number(match[1]), child });
      }
    };
    const onExit = (code) => {
      cleanup();
      rejectPromise(new Error(`Fake SMTP server exited before listening (code ${code}): ${stdout}`));
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

try {
  await runWithDisposableReviewDatabase(async ({ run, environment }) => {
    // The disposable-DB callback is async-aware: it awaits the returned
    // promise before tearing the cluster down (see disposable-review-database.mjs).
    run("pnpm", ["--filter", "@workspace/db", "run", "push-force"], { env: environment });

    // Seed the incident directly. Never use the trigger endpoint here: with
    // live provider secrets in the environment an incident trigger would fan
    // out real deliveries (NODE_ENV=test forces the dev sink, but a seeded
    // row keeps this proof delivery-free by construction).
    run("psql", [
      environment.DATABASE_URL,
      "-v", "ON_ERROR_STOP=1",
      "-c",
      `INSERT INTO cas_incidents (id, priority, status, trigger_count, created_at, updated_at) VALUES ('${INCIDENT_ID}', 'P1', 'ACTIVE_UNACKED', 1, now(), now())`,
    ]);

    run("pnpm", ["--filter", "@workspace/api-server", "run", "build"], { env: environment });
    run("pnpm", ["--filter", "@workspace/covert-alert-system", "run", "build"], { env: environment });

    const apiPort = await findAvailablePort();
    const webPort = await findAvailablePort();
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    const webOrigin = `http://127.0.0.1:${webPort}`;

    // Fake SMTP endpoint for the email-probe proof: always refuses AUTH, so
    // a console mailbox saved at it produces a failed probe within seconds.
    const smtpIdentity = generateThrowawaySmtpIdentity(run);
    const fakeSmtp = await startFakeSmtpServer(smtpIdentity);

    const apiServer = spawn(
      "node",
      ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"],
      {
        env: {
          ...environment,
          PORT: String(apiPort),
          HOST: "127.0.0.1",
          CAS_ALERT_TOKEN: ALERT_TOKEN,
          SESSION_SECRET: "e2e-browser-proof-session-secret",
          // The disposable-database environment sets NODE_ENV=test and
          // CAS_TEST_DISPOSABLE_DB=1, under which the api-server disables
          // the mailbox probe worker — but the email-probe proof exists to
          // watch that worker fail against a bad password, so this process
          // runs with the test-harness forcing off. Safety is preserved by
          // construction: no proof ever triggers an alert (the incident row
          // is seeded directly), so no delivery can fire, and the probe's
          // only mail server is the fake one below.
          NODE_ENV: "production",
          CAS_TEST_DISPOSABLE_DB: "0",
          // Device-direct SMS mode: the handset-SIM chip proof triggers an
          // incident and posts the handset's receipt through the real
          // device-receipt endpoint, which stays 409-closed in gateway mode.
          // Safe here because the trigger only queues handset-delivered SMS
          // (every gateway channel is undeliverable with the email provider
          // variables cleared and no responder rows), and the outbox worker
          // never claims device channels in this mode.
          CAS_SMS_DELIVERY_MODE: "device",
          // Clear every live gateway provider configuration: endpoint URLs,
          // tokens, sender identities, and the env recipient fallbacks for
          // all four transports. This is what makes the handset-SIM chip
          // proof's real trigger safe — with no gateway endpoint configured
          // and no responder rows in the disposable DB, the trigger queues
          // only the handset-delivered SMS row, and the production-mode
          // outbox worker (test-sink forcing is off here) can never contact
          // a real provider. It also keeps the pre-save probe ticks skipping
          // instead of AUTHing against the real mailbox on a fast cadence;
          // the email-probe proof's saved console account owns the channel.
          CAS_SMS_PROVIDER_URL: "",
          CAS_SMS_PROVIDER_TOKEN: "",
          CAS_SMS_FROM: "",
          CAS_SMS_RECIPIENTS: "",
          CAS_XMPP_PROVIDER_URL: "",
          CAS_XMPP_PROVIDER_TOKEN: "",
          CAS_XMPP_FROM_JID: "",
          CAS_XMPP_RECIPIENTS: "",
          CAS_WHATSAPP_PROVIDER_URL: "",
          CAS_WHATSAPP_PROVIDER_TOKEN: "",
          CAS_WHATSAPP_FROM: "",
          CAS_WHATSAPP_RECIPIENTS: "",
          CAS_EMAIL_PROVIDER_URL: "",
          CAS_EMAIL_PROVIDER_TOKEN: "",
          CAS_EMAIL_RECIPIENTS: "",
          CAS_EMAIL_SMTP_HOST: "",
          CAS_EMAIL_SMTP_PORT: "",
          CAS_EMAIL_SMTP_USER: "",
          CAS_EMAIL_SMTP_PASSWORD: "",
          // Fast probe cadence so the saved bad-password account is probed
          // seconds after the spec saves it, not 15s/weekly.
          CAS_EMAIL_PROBE_DELAY_MS: "1000",
          CAS_EMAIL_PROBE_INTERVAL_MS: "2000",
          // Trust the fake SMTP server's throwaway self-signed cert for the
          // mandatory STARTTLS handshake.
          CAS_EMAIL_SMTP_CA_FILE: smtpIdentity.certFile,
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    const webServer = spawn(
      "pnpm",
      ["--filter", "@workspace/covert-alert-system", "exec", "vite", "preview", "--config", "vite.config.ts", "--host", "127.0.0.1"],
      {
        env: {
          ...environment,
          NODE_ENV: "production",
          PORT: String(webPort),
          BASE_PATH: "/",
          // vite.config.ts only adds this proxy when the variable is set, so
          // day-to-day dev/preview behavior is untouched.
          CAS_E2E_API_ORIGIN: apiOrigin,
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

    try {
      await waitForHttpOk(`${apiOrigin}/api/healthz`, "api-server");
      await waitForHttpOk(webOrigin + "/", "console preview");
      run("pnpm", [
        "--filter", "@workspace/covert-alert-system",
        "exec", "playwright", "test", "--config", "e2e/playwright.config.ts",
      ], {
        env: {
          ...environment,
          CAS_E2E_API_ORIGIN: apiOrigin,
          CAS_E2E_WEB_ORIGIN: webOrigin,
          CAS_E2E_ALERT_TOKEN: ALERT_TOKEN,
          CAS_E2E_SMTP_PORT: String(fakeSmtp.port),
          // Pass the optional local browser override through if set.
          ...(process.env.CAS_E2E_CHROMIUM_PATH
            ? { CAS_E2E_CHROMIUM_PATH: process.env.CAS_E2E_CHROMIUM_PATH }
            : {}),
        },
      });
      console.log("Console browser proofs passed: mid-session revocation lock, failed mailbox login check, handset-SIM chip tooltip, and first-click evidence download.");
    } finally {
      await stopProcess(webServer, "console preview");
      await stopProcess(apiServer, "api-server");
      await stopProcess(fakeSmtp.child, "fake smtp server");
    }
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
