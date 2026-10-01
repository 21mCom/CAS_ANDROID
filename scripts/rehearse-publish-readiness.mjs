// Publish-readiness rehearsal for the always-on Replit deployment
// (artifacts/api-server/PUBLISH-ON-REPLIT.md). Proves, against the exact
// production build and a throwaway PostgreSQL cluster, the contract the
// published deployment must keep:
//
//   1. Static posture: .replit targets a Reserved VM, the API production run
//      sets NODE_ENV=production, the console ships as a static build, and the
//      mockup Canvas has no production service (so /__mockup is never
//      deployed).
//   2. First-publish boot: against a brand-new, EMPTY database (what
//      "Create production database" hands the deployment) the server applies
//      the committed drizzle migrations itself at boot
//      (artifacts/api-server/src/lib/db-schema-ensure.ts) — no
//      workspace-shell schema step exists anymore — and a restart against
//      the now-migrated database is a clean no-op.
//   3. Credential gate: enrollment with the deployment's CAS_ALERT_TOKEN
//      works, state reads need the enrolled credential, revocation locks the
//      device from its next request, and the management/update endpoints
//      reject anonymous callers.
//   4. Lockdown: the dev provider-inbox sink is not mounted under
//      NODE_ENV=production (404, not just disabled deliveries).
//   5. Console: the static build serves at / and its /api proxy contract
//      (what the deployment router provides) reaches the API.
//
// Safety: the API process runs with NODE_ENV=production but every provider,
// SMTP, recipient, and sink variable is cleared and the database is
// disposable, so no real delivery can fire. The credentials below are
// fixed test-only values that authenticate nothing real.
//
// Prerequisites: pnpm install, and initdb/pg_ctl/createdb on PATH (same as
// scripts/run-cas-contract-tests.mjs).

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runWithDisposableReviewDatabase } from "./disposable-review-database.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Fixed, test-only credentials. They live only inside this disposable
// rehearsal (throwaway database, loopback-only servers).
const ALERT_TOKEN = "publish-rehearsal-alert-token";
const DEVICE_TOKEN = "publish-rehearsal-device-token";

let passed = 0;
function check(condition, label) {
  if (!condition) {
    throw new Error(`REHEARSAL FAILED: ${label}`);
  }
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

async function expectStatus(label, url, expectedStatus, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  check(
    response.status === expectedStatus,
    `${label} — expected HTTP ${expectedStatus}, got ${response.status} (${body.slice(0, 200)})`,
  );
  return body;
}

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

// --- 1. Static deployment posture ------------------------------------------

const dotReplit = readFileSync(join(workspaceRoot, ".replit"), "utf8");
check(
  /deploymentTarget\s*=\s*"vm"/.test(dotReplit),
  '.replit targets a Reserved VM (deploymentTarget = "vm"), so the always-on workers never freeze',
);

const apiToml = readFileSync(
  join(workspaceRoot, "artifacts/api-server/.replit-artifact/artifact.toml"),
  "utf8",
);
check(
  apiToml.includes("[services.production.run]") && /NODE_ENV\s*=\s*"production"/.test(apiToml),
  "api-server production run sets NODE_ENV=production (dev sink and dev helpers stay off)",
);

const consoleToml = readFileSync(
  join(workspaceRoot, "artifacts/covert-alert-system/.replit-artifact/artifact.toml"),
  "utf8",
);
check(
  /serve\s*=\s*"static"/.test(consoleToml),
  "console ships as a static production build served at /",
);

const mockupToml = readFileSync(
  join(workspaceRoot, "artifacts/mockup-sandbox/.replit-artifact/artifact.toml"),
  "utf8",
);
check(
  !mockupToml.includes("[services.production"),
  "mockup Canvas has no production service — /__mockup is never deployed",
);

// --- 2-5. Live rehearsal against a disposable database ----------------------

try {
  await runWithDisposableReviewDatabase(async ({ run, environment }) => {
    // Build exactly what the deployment build runs — with NODE_ENV forced to
    // production, because the disposable-database harness environment sets
    // NODE_ENV=test and Vite preserves an explicit NODE_ENV into the browser
    // bundle (dev-only plugins, import.meta.env.DEV). Setting production only
    // at preview time would rehearse a bundle the deployment never serves.
    const buildEnvironment = {
      ...environment,
      NODE_ENV: "production",
      CAS_TEST_DISPOSABLE_DB: "0",
    };
    run("pnpm", ["--filter", "@workspace/api-server", "run", "build"], { env: buildEnvironment });
    run("pnpm", ["--filter", "@workspace/covert-alert-system", "run", "build"], { env: buildEnvironment });

    const apiPort = await findAvailablePort();
    const webPort = await findAvailablePort();
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    const webOrigin = `http://127.0.0.1:${webPort}`;

    const spawnApiServer = () => spawn(
      "node",
      ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"],
      {
        cwd: workspaceRoot,
        env: {
          ...environment,
          // Production posture, mirroring the deployment's run env — the
          // disposable-database harness markers are switched back off so the
          // test-harness delivery forcing cannot mask a lockdown gap.
          NODE_ENV: "production",
          CAS_TEST_DISPOSABLE_DB: "0",
          PORT: String(apiPort),
          HOST: "127.0.0.1",
          CAS_ALERT_TOKEN: ALERT_TOKEN,
          // Recommended MVP delivery posture from PUBLISH-ON-REPLIT.md: the
          // handset delivers SMS itself.
          CAS_SMS_DELIVERY_MODE: "device",
          CAS_DEVICE_CHANNELS: "SMS",
          CAS_DEVICE_TOKEN: DEVICE_TOKEN,
          // Clear every live provider/SMTP/recipient/sink variable that the
          // workspace environment may carry: this process must prove it can
          // run production posture without touching a real provider.
          CAS_DEV_PROVIDER_SINK: "",
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
          CAS_EMAIL_FROM: "",
          CAS_EMAIL_RECIPIENTS: "",
          CAS_EMAIL_SMTP_HOST: "",
          CAS_EMAIL_SMTP_PORT: "",
          CAS_EMAIL_SMTP_USER: "",
          CAS_EMAIL_SMTP_PASSWORD: "",
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

    let apiServer = spawnApiServer();
    let webServer = null;
    try {
      // First-publish posture: the production database is brand-new and
      // EMPTY — this rehearsal deliberately never runs a schema command, so
      // the boot-time ensure alone must make the database usable.
      await waitForHttpOk(`${apiOrigin}/api/healthz`, "api-server (fresh empty database)");
      check(true, "server boots against a brand-new empty production database (startup probe passes)");
      await expectStatus(
        "anonymous state read is rejected",
        `${apiOrigin}/api/cas/state`,
        401,
      );

      // Proof that boot itself applied the committed migrations — no
      // workspace-shell step ran in this rehearsal.
      const journal = run(
        "psql",
        [environment.DATABASE_URL, "-tAc", "SELECT COUNT(*) FROM drizzle.__drizzle_migrations"],
        { env: environment, stdio: "pipe" },
      );
      check(
        Number(journal.stdout.trim()) >= 1,
        `boot applied the committed migrations to the empty database (journal holds ${journal.stdout.trim()} entries) — no manual schema step`,
      );

      await expectStatus(
        "anonymous enrollment is rejected",
        `${apiOrigin}/api/cas/devices/enroll`,
        401,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      await expectStatus(
        "a wrong enrollment credential is rejected",
        `${apiOrigin}/api/cas/devices/enroll`,
        401,
        {
          method: "POST",
          headers: { authorization: "Bearer wrong-on-purpose", "content-type": "application/json" },
          body: JSON.stringify({ label: "rehearsal" }),
        },
      );

      const enrolled = JSON.parse(await expectStatus(
        "enrollment with the deployment CAS_ALERT_TOKEN succeeds",
        `${apiOrigin}/api/cas/devices/enroll`,
        201,
        {
          method: "POST",
          headers: { authorization: `Bearer ${ALERT_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ label: "publish-rehearsal" }),
        },
      ));
      check(
        typeof enrolled.token === "string" && enrolled.token.startsWith("casdev_"),
        "enrollment returns a per-device credential (casdev_…)",
      );
      const deviceToken = enrolled.token;
      const deviceId = enrolled.device.id;
      const deviceAuth = { headers: { authorization: `Bearer ${deviceToken}` } };

      await expectStatus(
        "state read with the enrolled credential succeeds",
        `${apiOrigin}/api/cas/state`,
        200,
        deviceAuth,
      );
      await expectStatus(
        "device list rejects anonymous callers",
        `${apiOrigin}/api/cas/devices`,
        401,
      );
      await expectStatus(
        "handset pickup rejects anonymous callers",
        `${apiOrigin}/api/cas/outbox/device-pending`,
        401,
      );
      await expectStatus(
        "update manifest rejects anonymous callers",
        `${apiOrigin}/api/cas/app-updates/manifest`,
        401,
      );
      await expectStatus(
        "update manifest answers 404 (nothing published) for an enrolled device",
        `${apiOrigin}/api/cas/app-updates/manifest`,
        404,
        deviceAuth,
      );
      await expectStatus(
        "update download answers 404 (nothing published) for an enrolled device",
        `${apiOrigin}/api/cas/app-updates/latest.apk`,
        404,
        deviceAuth,
      );

      // Lockdown: the dev provider-inbox sink must not exist in production —
      // a 404 on both the inbox read and a would-be delivery POST.
      await expectStatus(
        "dev provider-inbox is not mounted in production (GET)",
        `${apiOrigin}/api/cas/dev/provider-inbox`,
        404,
      );
      await expectStatus(
        "dev provider-inbox is not mounted in production (POST)",
        `${apiOrigin}/api/cas/dev/provider-inbox/whatsapp`,
        404,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );

      await expectStatus(
        "revocation with the enrollment credential succeeds",
        `${apiOrigin}/api/cas/devices/${deviceId}/revoke`,
        200,
        { method: "POST", headers: { authorization: `Bearer ${ALERT_TOKEN}` } },
      );
      await expectStatus(
        "the revoked device is locked out from its very next request",
        `${apiOrigin}/api/cas/state`,
        401,
        deviceAuth,
      );

      // Redeploy posture: a restart against the now-migrated database must
      // be a clean no-op (drizzle records applied migrations), not a second
      // schema rewrite, and the lockout must survive it.
      await stopProcess(apiServer, "api-server (first boot)");
      apiServer = spawnApiServer();
      await waitForHttpOk(`${apiOrigin}/api/healthz`, "api-server (restart)");
      check(true, "restart against the migrated database boots cleanly (schema ensure is idempotent)");
      await expectStatus(
        "the revoked credential stays locked after the restart",
        `${apiOrigin}/api/cas/state`,
        401,
        deviceAuth,
      );

      // Console: the static production build serves at /, and /api through
      // the same origin (what the deployment router provides) reaches the API.
      webServer = spawn(
        "pnpm",
        ["--filter", "@workspace/covert-alert-system", "exec", "vite", "preview", "--config", "vite.config.ts", "--host", "127.0.0.1"],
        {
          cwd: workspaceRoot,
          env: {
            ...environment,
            NODE_ENV: "production",
            PORT: String(webPort),
            BASE_PATH: "/",
            // vite.config.ts only adds this proxy when the variable is set;
            // day-to-day dev/preview behavior is untouched.
            CAS_E2E_API_ORIGIN: apiOrigin,
          },
          stdio: ["ignore", "inherit", "inherit"],
        },
      );
      const consoleHtml = await (async () => {
        await waitForHttpOk(`${webOrigin}/`, "console preview");
        const response = await fetch(`${webOrigin}/`);
        return response.text();
      })();
      check(
        consoleHtml.includes('id="root"'),
        "console production build serves at / (the enrollment prompt renders client-side)",
      );
      await expectStatus(
        "the console's /api proxy contract reaches the API health check",
        `${webOrigin}/api/healthz`,
        200,
      );
    } finally {
      if (webServer) await stopProcess(webServer, "console preview");
      await stopProcess(apiServer, "api-server");
    }
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  console.log(
    `Publish-readiness rehearsal passed (${passed} checks): Reserved VM target, automatic schema ` +
    "apply on a fresh database (no manual step) with an idempotent restart, enrollment gate, " +
    "revocation lockout, update-endpoint 404s, dev-sink lockdown, and console serving.",
  );
}
