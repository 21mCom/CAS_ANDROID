/**
 * Contract tests for the credential-burst alert pinger
 * (lib/cas-auth-burst-alert.ts).
 *
 * The pinger replaces the self-hosting runbook's cron watchdog (SELF-HOSTING
 * Step 10) on deployments that cannot scan their own logs: the server pings
 * a healthchecks.io-style check itself. These tests prove, with an injected
 * fetch:
 *  - no URL configured -> no worker (bursts stay log-only),
 *  - a malformed or non-http(s) URL fails loudly at boot,
 *  - a burst pings the check's /fail URL exactly, trailing slash tolerated,
 *  - quiet-time success pings keep the check green and are suppressed while
 *    a burst is fresh (so the check is not flipped up mid-flood),
 *  - a failed ping is logged and the loop survives,
 *  - stop() ends the pings.
 *
 * No database and no network: fetch and the clock are injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveCasAuthBurstAlertUrl,
  startCasAuthBurstAlert,
} from "./cas-auth-burst-alert";

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

type Ping = { url: string };

function recordingFetch(calls: Ping[], failWith?: Error) {
  return async (url: string) => {
    calls.push({ url });
    if (failWith) throw failWith;
    return { status: 200 };
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail("condition not reached before deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("no CAS_AUTH_BURST_ALERT_URL configured -> no worker starts", () => {
  assert.equal(resolveCasAuthBurstAlertUrl({}), undefined);
  assert.equal(startCasAuthBurstAlert({ env: {}, log: silentLog }), null);
});

test("malformed or non-http(s) URL fails loudly", () => {
  assert.throws(() => resolveCasAuthBurstAlertUrl({ CAS_AUTH_BURST_ALERT_URL: "not a url" }));
  assert.throws(() =>
    resolveCasAuthBurstAlertUrl({ CAS_AUTH_BURST_ALERT_URL: "ftp://hc.example/ping" }),
  );
  assert.equal(
    resolveCasAuthBurstAlertUrl({ CAS_AUTH_BURST_ALERT_URL: "https://hc-ping.com/uuid" }),
    "https://hc-ping.com/uuid",
  );
});

test("a burst pings the check's /fail URL, trailing slash tolerated", async () => {
  const calls: Ping[] = [];
  const handle = startCasAuthBurstAlert({
    url: "https://hc-ping.com/second-uuid/",
    fetchImpl: recordingFetch(calls),
    log: silentLog,
    intervalMs: 60_000,
    initialDelayMs: 60_000,
  });
  assert.ok(handle);
  handle!.recordBurst();
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls, [{ url: "https://hc-ping.com/second-uuid/fail" }]);
  await handle!.stop();
});

test("quiet-time success pings keep the check green and stop after stop()", async () => {
  const calls: Ping[] = [];
  const handle = startCasAuthBurstAlert({
    url: "https://hc-ping.com/second-uuid",
    fetchImpl: recordingFetch(calls),
    log: silentLog,
    intervalMs: 25,
    initialDelayMs: 5,
  })!;
  await waitFor(() => calls.length >= 2);
  assert.ok(calls.every((c) => c.url === "https://hc-ping.com/second-uuid"));
  await handle.stop();
  const settled = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.length, settled);
});

test("success pings are suppressed while a burst is fresh", async () => {
  const calls: Ping[] = [];
  let clock = 1_000_000;
  const handle = startCasAuthBurstAlert({
    url: "https://hc-ping.com/second-uuid",
    fetchImpl: recordingFetch(calls),
    log: silentLog,
    now: () => clock,
    intervalMs: 20,
    initialDelayMs: 5,
    suppressMs: 10_000,
  })!;
  // One initial success ping lands before the burst.
  await waitFor(() => calls.length === 1);
  handle.recordBurst();
  await waitFor(() => calls.some((c) => c.url.endsWith("/fail")));
  const afterFail = calls.length;
  // Still inside the suppression window: no further success pings.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    calls.filter((c) => !c.url.endsWith("/fail")).length,
    afterFail - 1,
  );
  // After the window passes, the success ping resumes and flips the check up.
  clock += 10_001;
  await waitFor(() => calls.filter((c) => !c.url.endsWith("/fail")).length > afterFail - 1);
  await handle.stop();
});

test("a failed ping is logged and the loop survives", async () => {
  const calls: Ping[] = [];
  const warnings: string[] = [];
  const handle = startCasAuthBurstAlert({
    url: "https://hc-ping.com/second-uuid",
    fetchImpl: recordingFetch(calls, new Error("hc unreachable")),
    log: { ...silentLog, warn: (_obj, msg) => warnings.push(String(msg)) },
    intervalMs: 20,
    initialDelayMs: 5,
  })!;
  await waitFor(() => calls.length >= 2);
  await waitFor(() => warnings.length >= 1);
  await handle.stop();
});

test("a non-2xx ping response warns instead of reporting success", async () => {
  const calls: Ping[] = [];
  const warnings: unknown[] = [];
  const handle = startCasAuthBurstAlert({
    url: "https://hc-ping.com/second-uuid",
    fetchImpl: async (url) => {
      calls.push({ url });
      return { status: 503, ok: false };
    },
    log: { ...silentLog, warn: (obj) => warnings.push(obj) },
    intervalMs: 60_000,
    initialDelayMs: 5,
  })!;
  await waitFor(() => warnings.length === 1);
  await handle.stop();
  assert.equal(calls.length, 1);
});

test("a success ping in flight when a burst hits cannot clear the alert afterwards", async () => {
  // The success ping hangs until released; the burst's /fail must be
  // delivered strictly AFTER it completes, so the check's last word is down.
  const calls: Ping[] = [];
  let releaseSuccess: (() => void) | undefined;
  const handle = startCasAuthBurstAlert({
    url: "https://hc-ping.com/second-uuid",
    fetchImpl: (url) => {
      calls.push({ url });
      if (url.endsWith("/fail")) return Promise.resolve({ status: 200, ok: true });
      return new Promise((resolve) => {
        releaseSuccess = () => resolve({ status: 200, ok: true });
      });
    },
    log: silentLog,
    intervalMs: 60_000,
    initialDelayMs: 5,
  })!;
  await waitFor(() => calls.length === 1); // success ping in flight
  handle.recordBurst();
  // The /fail ping is queued behind the hung success ping, not sent yet.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(calls, [{ url: "https://hc-ping.com/second-uuid" }]);
  releaseSuccess!();
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls[1], { url: "https://hc-ping.com/second-uuid/fail" });
  await handle.stop();
});

test("a success ping queued before a burst is skipped at send time", async () => {
  const calls: Ping[] = [];
  let clock = 1_000_000;
  let releaseFail: (() => void) | undefined;
  const handle = startCasAuthBurstAlert({
    url: "https://hc-ping.com/second-uuid",
    fetchImpl: (url) => {
      calls.push({ url });
      if (url.endsWith("/fail")) {
        return new Promise((resolve) => {
          releaseFail = () => resolve({ status: 200, ok: true });
        });
      }
      return Promise.resolve({ status: 200, ok: true });
    },
    log: silentLog,
    now: () => clock,
    intervalMs: 20,
    initialDelayMs: 60_000, // no initial ping; the burst comes first
    suppressMs: 10_000,
  })!;
  handle.recordBurst();
  await waitFor(() => calls.length === 1); // /fail in flight
  // While /fail hangs, several ticks queue success pings behind it.
  await new Promise((resolve) => setTimeout(resolve, 80));
  releaseFail!();
  // Every queued success ping is inside the suppression window at send time:
  // none may go out after the /fail.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(calls, [{ url: "https://hc-ping.com/second-uuid/fail" }]);
  await handle.stop();
});

test("stop() drains every pending ping, not just the latest", async () => {
  const calls: Ping[] = [];
  const releases: Array<() => void> = [];
  const handle = startCasAuthBurstAlert({
    url: "https://hc-ping.com/second-uuid",
    fetchImpl: (url) => {
      calls.push({ url });
      return new Promise((resolve) => releases.push(() => resolve({ status: 200, ok: true })));
    },
    log: silentLog,
    intervalMs: 60_000,
    initialDelayMs: 5,
  })!;
  await waitFor(() => calls.length === 1); // success ping hung
  handle.recordBurst(); // /fail queued behind it
  let stopped = false;
  const stopPromise = handle.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(stopped, false); // still draining the hung success ping
  releases.shift()!(); // release success -> /fail starts
  await waitFor(() => calls.length === 2);
  assert.equal(stopped, false); // now draining the /fail ping
  releases.shift()!();
  await stopPromise;
  assert.equal(stopped, true);
});
