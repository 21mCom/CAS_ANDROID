// Drives the committed real-browser console proof
// (artifacts/covert-alert-system/e2e/console-mid-session-lock.spec.ts):
// provisions a disposable PostgreSQL cluster, boots the api-server with a
// fixed test-only enrollment credential and this console's built bundle
// behind `vite preview` with /api proxied, then runs the Playwright suite.
// Everything is torn down on pass or fail.
//
// Prerequisites: pnpm install, Playwright's chromium (`pnpm --filter
// @workspace/covert-alert-system exec playwright install chromium`, or set
// CAS_E2E_CHROMIUM_PATH to an existing executable), and initdb/pg_ctl/psql on
// PATH (same as scripts/run-cas-contract-tests.mjs).

import { spawn } from "node:child_process";
import { createServer } from "node:net";

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
          // Pass the optional local browser override through if set.
          ...(process.env.CAS_E2E_CHROMIUM_PATH
            ? { CAS_E2E_CHROMIUM_PATH: process.env.CAS_E2E_CHROMIUM_PATH }
            : {}),
        },
      });
      console.log("Console browser proof passed: mid-session revocation locked the console.");
    } finally {
      await stopProcess(webServer, "console preview");
      await stopProcess(apiServer, "api-server");
    }
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
