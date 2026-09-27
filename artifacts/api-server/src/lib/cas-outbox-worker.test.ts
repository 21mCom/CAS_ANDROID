import assert from "node:assert/strict";
import { test } from "node:test";
import {
  startCasOutboxWorker,
  type CasOutboxWorkerHandle,
} from "./cas-outbox-worker";
import {
  getCasOutboxWorkerHeartbeat,
  resetCasOutboxWorkerHeartbeat,
} from "./cas-outbox-status";
import type { CasOutboxWorkerResult } from "../routes/cas";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await sleep(5);
  }
}

function makeResult(workerId: string, claimed = 0): CasOutboxWorkerResult {
  return {
    workerId,
    claimed,
    sent: claimed,
    failed: 0,
    deadLettered: 0,
    deliveries: [],
  };
}

function silentLog() {
  const entries: { level: string; obj: unknown; msg?: string }[] = [];
  return {
    entries,
    info(obj: unknown, msg?: string) {
      entries.push({ level: "info", obj, msg });
    },
    error(obj: unknown, msg?: string) {
      entries.push({ level: "error", obj, msg });
    },
  };
}

test("worker ticks on the interval and stop() ends the loop", async () => {
  let ticks = 0;
  const worker: CasOutboxWorkerHandle = startCasOutboxWorker({
    intervalMs: 10,
    workerId: "loop-test",
    log: silentLog(),
    runTick: async ({ workerId }) => {
      ticks += 1;
      return makeResult(workerId);
    },
  });

  await waitFor(() => ticks >= 3);
  await worker.stop();
  const stoppedAt = ticks;
  await sleep(50);
  assert.equal(ticks, stoppedAt, "no ticks should run after stop()");
});

test("a throwing tick is logged and the loop keeps running", async () => {
  const log = silentLog();
  let calls = 0;
  const worker = startCasOutboxWorker({
    intervalMs: 10,
    workerId: "crash-test",
    log,
    runTick: async ({ workerId }) => {
      calls += 1;
      if (calls === 1) throw new Error("adapter exploded");
      return makeResult(workerId, 1);
    },
  });

  await waitFor(() => calls >= 3);
  await worker.stop();

  assert.ok(
    log.entries.some(
      (entry) => entry.level === "error" && entry.msg === "CAS outbox tick failed",
    ),
    "the throwing tick must be logged, not crash the loop",
  );
  assert.ok(calls >= 3, "the loop must continue after a tick throws");
});

test("ticks never overlap: a slow tick causes the next interval to be skipped", async () => {
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const worker = startCasOutboxWorker({
    intervalMs: 10,
    workerId: "overlap-test",
    log: silentLog(),
    runTick: async ({ workerId }) => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(45); // spans several interval firings
      active -= 1;
      return makeResult(workerId);
    },
  });

  await waitFor(() => started >= 2);
  await worker.stop();
  assert.equal(maxActive, 1, "ticks must never run concurrently");
});

test("stop() waits for an in-flight tick to settle", async () => {
  let tickStarted = false;
  let tickSettled = false;
  const worker = startCasOutboxWorker({
    intervalMs: 5,
    workerId: "drain-test",
    log: silentLog(),
    runTick: async ({ workerId }) => {
      tickStarted = true;
      await sleep(40);
      tickSettled = true;
      return makeResult(workerId);
    },
  });

  await waitFor(() => tickStarted && !tickSettled); // a tick has started but not finished
  await worker.stop();
  assert.equal(tickSettled, true, "stop() must await the in-flight tick");
});

test("the heartbeat records configuration and every completed tick", async () => {
  resetCasOutboxWorkerHeartbeat();
  const worker = startCasOutboxWorker({
    intervalMs: 10,
    maxItemsPerTick: 4,
    workerId: "heartbeat-test",
    log: silentLog(),
    runTick: async ({ workerId }) => makeResult(workerId, 2),
  });

  const initial = getCasOutboxWorkerHeartbeat();
  assert.ok(initial, "the worker must publish its configuration on start");
  assert.equal(initial.workerId, "heartbeat-test");
  assert.equal(initial.intervalMs, 10);
  assert.equal(initial.batchSize, 4);
  assert.equal(initial.lastTickAt, null);
  assert.equal(initial.ticksCompleted, 0);

  await waitFor(() => (getCasOutboxWorkerHeartbeat()?.ticksCompleted ?? 0) >= 2);
  const heartbeat = getCasOutboxWorkerHeartbeat();
  assert.ok(heartbeat?.lastTickAt, "a completed tick must update the heartbeat");
  assert.ok(heartbeat.lastTickDurationMs !== null);
  assert.deepEqual(heartbeat.lastTick, {
    claimed: 2,
    sent: 2,
    failed: 0,
    deadLettered: 0,
  });

  await worker.stop();
  assert.ok(
    getCasOutboxWorkerHeartbeat()?.stoppedAt,
    "stop() must mark the heartbeat so the console can flag a dead worker",
  );
  resetCasOutboxWorkerHeartbeat();
});

test("a throwing tick is recorded as the heartbeat's last error", async () => {
  resetCasOutboxWorkerHeartbeat();
  const worker = startCasOutboxWorker({
    intervalMs: 10,
    workerId: "heartbeat-error-test",
    log: silentLog(),
    runTick: async () => {
      throw new Error("provider unreachable");
    },
  });

  await waitFor(() => getCasOutboxWorkerHeartbeat()?.lastError != null);
  await worker.stop();

  const heartbeat = getCasOutboxWorkerHeartbeat();
  assert.equal(heartbeat?.lastError?.message, "provider unreachable");
  assert.ok(heartbeat?.lastError?.at);
  assert.equal(
    heartbeat?.ticksCompleted,
    0,
    "a failed tick must not count as completed",
  );
  resetCasOutboxWorkerHeartbeat();
});

test("claimed items log claimed/sent/failed/deadLettered counts per tick", async () => {
  const log = silentLog();
  const worker = startCasOutboxWorker({
    intervalMs: 5,
    workerId: "count-test",
    log,
    runTick: async (workerOpts) => {
      const result = makeResult(workerOpts.workerId, 2);
      result.failed = 1;
      result.deadLettered = 1;
      return result;
    },
  });

  await waitFor(() =>
    log.entries.some((entry) => entry.msg === "CAS outbox tick completed"),
  );
  await worker.stop();

  const tickLog = log.entries.find(
    (entry) => entry.msg === "CAS outbox tick completed",
  );
  assert.ok(tickLog);
  const obj = tickLog.obj as Record<string, number>;
  assert.equal(obj.claimed, 2);
  assert.equal(obj.sent, 2);
  assert.equal(obj.failed, 1);
  assert.equal(obj.deadLettered, 1);
});
