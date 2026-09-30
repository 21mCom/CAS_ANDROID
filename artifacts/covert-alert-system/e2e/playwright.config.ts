import { defineConfig } from '@playwright/test';

// Real-browser console proofs. The harness (scripts/run-console-browser-proof.mjs)
// boots a disposable PostgreSQL, the api-server with a fixed test-only
// enrollment credential, and this app's built bundle behind `vite preview`
// with /api proxied to the api-server, then runs this suite against them.
//
// CAS_E2E_WEB_ORIGIN  — origin the browser should load (vite preview).
// CAS_E2E_CHROMIUM_PATH — optional local override for the browser executable
//   (the workspace has no Playwright-managed browser download by default);
//   CI installs the bundled chromium and leaves this unset.
const webOrigin = process.env.CAS_E2E_WEB_ORIGIN;
const chromiumPath = process.env.CAS_E2E_CHROMIUM_PATH;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // One spec, one browser: the proofs share a disposable database and the
  // per-IP rejection backoff, so parallel workers would contaminate each other.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // The anti-guessing backoff can hold a rejected-credential 401 for tens of
  // seconds; a locked-surface assertion needs room for that delay plus the
  // console's own polling cadence.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: webOrigin,
    headless: true,
    launchOptions: {
      // --no-sandbox keeps the browser usable in containers that run as root
      // (workspace and CI runners); the harness only ever talks to localhost.
      args: ['--no-sandbox'],
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
