import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, beforeEach, test } from "node:test";
import app from "../app";
import { db, pool } from "@workspace/db";
import {
  casIncidentEvents,
  casIncidents,
  casOutbox,
} from "@workspace/db/schema";
import { asc, eq, sql } from "drizzle-orm";
import {
  DELIVERY_LEASE_MS,
  MAX_DELIVERY_ATTEMPTS,
  claimCasOutboxItem,
  processCasOutbox,
} from "./cas";

const server = app.listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}/api`;
const apiServerDirectory = fileURLToPath(new URL("../../", import.meta.url));

async function clearCasData() {
  await db.delete(casIncidentEvents);
  await db.delete(casOutbox);
  await db.delete(casIncidents);
}

async function startApiProcess() {
  const portServer = createServer();
  portServer.listen(0);
  await once(portServer, "listening");
  const port = (portServer.address() as AddressInfo).port;
  portServer.close();
  await once(portServer, "close");

  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "src/index.ts"],
    {
      cwd: apiServerDirectory,
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
    },
  );
  const childBaseUrl = `http://127.0.0.1:${port}/api`;

  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `API process exited before becoming ready: ${child.exitCode}`,
      );
    }

    try {
      const response = await fetch(`${childBaseUrl}/healthz`);
      if (response.ok) return { child, baseUrl: childBaseUrl };
    } catch {
      // The child process has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  child.kill();
  await once(child, "exit");
  throw new Error("Timed out waiting for API process to become ready");
}

async function stopApiProcess(child: ChildProcess) {
  if (child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
}

beforeEach(async () => {
  await clearCasData();
});

const validGate0aReport = {
  schema: "cas-gate0a-report-v2",
  reportType: "gate0a-run",
  runPurpose: "Disposable proxy-launch hardware measurement only",
  evidenceClass: "physical-device-observation",
  status: "complete",
  startedAtUtc: "2024-08-26T14:00:00.000Z",
  finishedAtUtc: "2024-08-26T14:10:00.000Z",
  gate0aPassed: false,
  physicalReadinessProof: "requires-managed-Pixel-observer-review",
  target: {
    model: "Pixel 11",
    serial: "ABC123",
    device: "pixel11",
    androidVersion: "17",
    build: "BP1A.260805.001",
    androidApi: 37,
    stockAndroid: true,
    isEmulator: false,
    usbState: "device",
    usbDebuggingEnabled: true,
  },
  preflight: {
    status: "PASS",
    checks: [{
      id: "target.identity",
      name: "Authorized target identity",
      status: "PASS",
      required: true,
      observed: "Pixel 11 / pixel11 / ABC123",
      expected: "Approved Pixel 11 target in adb device state",
      nextSteps: [],
    }],
    unresolvedWarnings: [],
  },
  safety: {
    liveMessagingEnabled: false,
    networkEnabled: false,
    evidenceCaptureEnabled: false,
    covertProductionBehaviorEnabled: false,
    deviceOwnerPolicyChanged: false,
    applicationDataCleared: false,
    factoryResetPerformed: false,
  },
  coverPackage: "com.example.cover",
  deviceOwner: {
    isCasDeviceOwner: false,
    adminReceiverRegistered: false,
    reportedOnly: true,
  },
  permissions: {
    "android.permission.SEND_SMS": false,
    "android.permission.ACCESS_FINE_LOCATION": false,
    "android.permission.RECORD_AUDIO": false,
    "android.permission.CAMERA": false,
    "android.permission.INTERNET": true,
  },
  shortcut: { pinSupported: true, pinned: false, launcherControlsPinnedState: true },
  tasks: [{ taskId: 42, baseActivity: "com.example.cover/.MainActivity", topActivity: null }],
  recents: { proxyExcludedFromRecents: true, observedTaskCount: 1 },
  back: { mainActivityCallbackRecorded: true, predictiveBack: "observe_on_device" },
  observer: {
    settingsAppInfoReviewRequired: true,
    quickSettingsReviewRequired: true,
    notificationsReviewRequired: true,
    coverAppBackHomeRecentsReviewRequired: true,
  },
  evidence: {
    logs: ["host.log"],
    screenshots: ["screenshots/cold-launch.png"],
    rawReferences: ["events.ndjson", "environment.tsv"],
  },
  warnings: [],
  events: [
    { type: "PROXY_TRIGGER", wallClockMs: 1724673600123, elapsedRealtimeMs: 987654 },
    {
      type: "COVER_LAUNCH_OUTCOME",
      wallClockMs: 1724673600456,
      elapsedRealtimeMs: 987987,
      outcome: "STARTED",
      coverPackage: "com.example.cover",
    },
  ],
};

test("Gate 0A import preserves raw timestamps and stays inconclusive", async () => {
  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validGate0aReport),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    accepted: boolean;
    observation: { result: string; notes: string };
    summary: { eventCount: number; coverLaunchOutcomeCount: number };
  };
  assert.equal(body.accepted, true);
  assert.equal(body.observation.result, "inconclusive");
  assert.match(body.observation.notes, /wallClockMs=1724673600123/);
  assert.match(body.observation.notes, /elapsedRealtimeMs=987987/);
  assert.match(body.observation.notes, /outcome=STARTED/);
  assert.equal(body.summary.eventCount, 2);
  assert.equal(body.summary.coverLaunchOutcomeCount, 1);
});

test("Gate 0A import keeps emulator evidence distinct from physical evidence", async () => {
  const emulatorReport = {
    ...validGate0aReport,
    evidenceClass: "simulated-emulator",
    physicalReadinessProof: "simulated-emulator-not-proof",
    target: {
      ...validGate0aReport.target,
      model: "Pixel 8a",
      serial: "emulator-5554",
      device: "generic_x86_64",
      androidVersion: "15",
      build: "AP3A.240905.015",
      androidApi: 35,
      isEmulator: true,
    },
  };
  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(emulatorReport),
  });

  assert.equal(response.status, 200);
  const body = await response.json() as {
    observation: { notes: string };
    summary: { evidenceClass: string; preflightStatus: string };
  };
  assert.equal(body.summary.evidenceClass, "simulated-emulator");
  assert.equal(body.summary.preflightStatus, "PASS");
  assert.match(body.observation.notes, /cannot establish physical Gate 0A readiness/);
});

test("Gate 0A import rejects blocked preflight reports", async () => {
  const blocked = {
    ...validGate0aReport,
    status: "blocked",
    preflight: { ...validGate0aReport.preflight, status: "BLOCKED" },
  };
  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(blocked),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Gate 0A report is blocked; resolve the preflight blockers and import the completed report.",
    issues: [],
  });
});

test("Gate 0A import accepts a full hardware-run report over 200,000 bytes end-to-end", async () => {
  // A real Pixel run with the default 200-repeat series produces a ~250 KB
  // report; the import path must accept that volume through HTTP, not just in
  // the schema validator. Pad repeat samples until the serialized body passes
  // the byte size a real hardware report reaches.
  const hardwareReport = {
    ...validGate0aReport,
    events: [...validGate0aReport.events] as Array<Record<string, unknown>>,
  };
  let repeats = 0;
  while (JSON.stringify(hardwareReport).length <= 200_000) {
    repeats += 1;
    hardwareReport.events.push({
      type: "LAUNCH_SAMPLE",
      wallClockMs: 1724673600456 + repeats,
      elapsedRealtimeMs: 987987 + repeats,
      message: `repeat-${String(repeats).padStart(3, "0")} hardware launch sample`,
    });
  }
  const bodyText = JSON.stringify(hardwareReport);
  assert.ok(bodyText.length > 200_000, `expected a real-run-sized body, got ${bodyText.length}`);
  assert.ok(bodyText.length <= 512 * 1024, "test body must stay under the 512 KB API limit");

  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyText,
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { accepted: boolean; summary: { eventCount: number } };
  assert.equal(body.accepted, true);
  assert.equal(body.summary.eventCount, hardwareReport.events.length);
});

test("Gate 0A import accepts the exact harness-writer hardware-run report over HTTP", async () => {
  // Generate the report under test with the repo-only fixture generator, which
  // runs the harness's own write_report() against a seeded default Pixel 11 run
  // (200 repeats, per-repeat logcat references). The generator is deliberately
  // not part of the packaged field kit, so shipped tooling cannot manufacture
  // physical evidence without a device.
  const generatorPath = fileURLToPath(
    new URL("../../../../scripts/generate-gate0a-hardware-report-fixture.sh", import.meta.url),
  );
  const outDir = await mkdtemp(join(tmpdir(), "gate0a-hw-fixture-"));
  const { stdout } = await promisify(execFile)(
    "bash",
    [generatorPath, "--out-dir", outDir],
  );
  const reportPath = stdout.match(/GATE0A_HW_FIXTURE_OK report=(\S+)/)?.[1]?.trim();
  assert.ok(reportPath, "generator did not report a successful fixture write");
  const reportText = await readFile(reportPath, "utf-8");
  // The documented hardware report is ~250 KB: the fixture must stay above the
  // old 200,000-byte UI gate so a regressed size limit cannot go unnoticed,
  // and within the 512 KB transport bound.
  assert.ok(
    reportText.length > 200_000,
    `hardware report must exceed the old 200 KB UI gate: ${reportText.length} bytes`,
  );
  assert.ok(
    reportText.length <= 512 * 1024,
    `hardware report exceeds the 512 KB import limit: ${reportText.length} bytes`,
  );
  const generated = JSON.parse(reportText) as {
    evidence: { logs: string[]; screenshots: string[] };
    summary: { eventCount: number };
  };
  // The documented run's exact volume: 219 events (200 repeats), a logcat
  // reference per launch/navigation sample, retained repeat screenshots.
  assert.equal(generated.summary.eventCount, 219);
  assert.ok(
    generated.evidence.logs.length > 200,
    "expected the real per-repeat logcat reference volume",
  );
  assert.ok(generated.evidence.screenshots.length > 0, "expected retained repeat screenshots");

  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: reportText,
  });

  assert.equal(response.status, 200);
  const body = await response.json() as { accepted: boolean; summary: { eventCount: number } };
  assert.equal(body.accepted, true);
  assert.equal(body.summary.eventCount, generated.summary.eventCount);
});

test("Gate 0A import rejects an intentionally oversized report", async () => {
  // The express JSON body limit (512kb) must reject reports beyond the maximum
  // supported hardware-run size before they reach validation.
  const oversized = `{"pad":"${"x".repeat(600 * 1024)}"}`;
  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: oversized,
  });

  assert.equal(response.status, 413);
});

test("Gate 0A import rejects malformed reports with the failing field", async () => {
  const malformed = { ...validGate0aReport, schema: "cas-gate0a-report-v0" };
  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(malformed),
  });

  assert.equal(response.status, 400);
  const body = await response.json() as { error: string; issues: { path: string; message: string }[] };
  assert.match(body.error, /^Invalid cas-gate0a-report-v2 report — schema: /);
  assert.deepEqual(body.issues, [
    { path: "schema", message: 'Invalid literal value, expected "cas-gate0a-report-v2"' },
  ]);
});

test("Gate 0A import rejects physical evidence from an unapproved Pixel model", async () => {
  const wrongModel = {
    ...validGate0aReport,
    target: { ...validGate0aReport.target, model: "Pixel 8a", androidApi: 35 },
  };
  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(wrongModel),
  });

  assert.equal(response.status, 400);
  const body = await response.json() as { error: string; issues: { path: string; message: string }[] };
  assert.match(body.error, /target\.model: Physical evidence must come from the approved Pixel 11 target/);
  assert.deepEqual(body.issues, [
    { path: "target.model", message: "Physical evidence must come from the approved Pixel 11 target" },
  ]);
});

test("Gate 0A import rejects reports that cross the safety boundary", async () => {
  const unsafe = {
    ...validGate0aReport,
    safety: { ...validGate0aReport.safety, liveMessagingEnabled: true },
  };
  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(unsafe),
  });

  assert.equal(response.status, 400);
  const body = await response.json() as { error: string; issues: { path: string; message: string }[] };
  assert.match(body.error, /safety\.liveMessagingEnabled: /);
  assert.deepEqual(body.issues, [
    { path: "safety.liveMessagingEnabled", message: "Invalid literal value, expected false" },
  ]);
});

test("Gate 0A import rejects unsafe JSON keys", async () => {
  const unsafe = {
    ...validGate0aReport,
    events: [{ ...validGate0aReport.events[0], constructor: "pollute" }],
  };
  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(unsafe),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Gate 0A report contains unsafe JSON content", issues: [] });
});

after(async () => {
  await clearCasData();
  server.close();
  await once(server, "close");
  await pool.end();
});

test("concurrent triggers reuse one incident and preserve both observations", async () => {
  const [first, second] = await Promise.all([
    fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" }),
    fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" }),
  ]);

  assert.ok([201, 200].includes(first.status));
  assert.ok([201, 200].includes(second.status));

  const firstBody = (await first.json()) as { id: string; reused: boolean };
  const secondBody = (await second.json()) as { id: string; reused: boolean };
  assert.equal(firstBody.id, secondBody.id);
  assert.deepEqual(
    [firstBody.reused, secondBody.reused].sort(),
    [false, true],
  );

  const incidents = await db.select().from(casIncidents);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].id, firstBody.id);
  assert.equal(incidents[0].triggerCount, 2);
  assert.equal(incidents[0].status, "ACTIVE_UNACKED");

  const events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, firstBody.id))
    .orderBy(asc(casIncidentEvents.createdAt));
  assert.equal(events.filter((event) => event.type.startsWith("TRIGGER")).length, 2);
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("TRIGGER")).map((event) => event.type).sort(),
    ["TRIGGER_RECEIVED", "TRIGGER_REUSED"],
  );

  const outbox = await db
    .select()
    .from(casOutbox)
    .where(eq(casOutbox.incidentId, firstBody.id));
  assert.equal(outbox.length, 2);
  assert.deepEqual(outbox.map((item) => item.transport).sort(), ["SMS", "XMPP"]);

  const ack = await fetch(`${baseUrl}/cas/incidents/${firstBody.id}/ack`, {
    method: "POST",
  });
  assert.equal(ack.status, 200);
  assert.deepEqual(await ack.json(), {
    id: firstBody.id,
    status: "ACTIVE_ACKED",
  });

  const resolve = await fetch(
    `${baseUrl}/cas/incidents/${firstBody.id}/resolve`,
    { method: "POST" },
  );
  assert.equal(resolve.status, 200);
  assert.deepEqual(await resolve.json(), {
    id: firstBody.id,
    status: "RESOLVED",
  });

  const [resolved] = await db
    .select()
    .from(casIncidents)
    .where(eq(casIncidents.id, firstBody.id));
  assert.equal(resolved.status, "RESOLVED");

  const transitionTypes = (
    await db
      .select({ type: casIncidentEvents.type })
      .from(casIncidentEvents)
      .where(eq(casIncidentEvents.incidentId, firstBody.id))
  ).map((event) => event.type);
  assert.ok(transitionTypes.includes("RESPONDER_ACK"));
  assert.ok(transitionTypes.includes("RESPONDER_RESOLVE"));
});

test("separate API processes converge concurrent triggers on one incident", async () => {
  const first = await startApiProcess();
  const second = await startApiProcess();
  try {
    const responses = await Promise.all([
      fetch(`${first.baseUrl}/cas/incidents/trigger`, { method: "POST" }),
      fetch(`${second.baseUrl}/cas/incidents/trigger`, { method: "POST" }),
    ]);

    assert.ok(responses.every((response) => [200, 201].includes(response.status)));

    const firstBody = (await responses[0].json()) as { id: string; reused: boolean };
    const secondBody = (await responses[1].json()) as { id: string; reused: boolean };
    assert.equal(firstBody.id, secondBody.id);
    assert.deepEqual(
      [firstBody.reused, secondBody.reused].sort(),
      [false, true],
    );

    const incidents = await db.select().from(casIncidents);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].id, firstBody.id);
    assert.equal(incidents[0].triggerCount, 2);
    assert.equal(incidents[0].status, "ACTIVE_UNACKED");

    const events = await db
      .select()
      .from(casIncidentEvents)
      .where(eq(casIncidentEvents.incidentId, firstBody.id));
    assert.deepEqual(
      events.filter((event) => event.type.startsWith("TRIGGER")).map((event) => event.type).sort(),
      ["TRIGGER_RECEIVED", "TRIGGER_REUSED"],
    );

    const outbox = await db
      .select()
      .from(casOutbox)
      .where(eq(casOutbox.incidentId, firstBody.id));
    assert.equal(outbox.length, 2);
    assert.deepEqual(
      outbox.map((item) => `${item.transport}:${item.state}`).sort(),
      ["SMS:QUEUED", "XMPP:QUEUED"],
    );
  } finally {
    await Promise.all([
      stopApiProcess(first.child),
      stopApiProcess(second.child),
    ]);
  }
});

test("outbox delivery claims are exclusive and use stable idempotency keys", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);

  const deliveries: Array<{ id: string; key: string }> = [];
  const send = async (item: typeof casOutbox.$inferSelect, key: string) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    deliveries.push({ id: item.id, key });
  };

  const [first, second] = await Promise.all([
    processCasOutbox({ workerId: "worker-a", maxItems: 1, send }),
    processCasOutbox({ workerId: "worker-b", maxItems: 1, send }),
  ]);

  assert.equal(first.sent + second.sent, 2);
  assert.equal(deliveries.length, 2);
  assert.deepEqual(
    deliveries.map((delivery) => delivery.id).sort(),
    deliveries.map((delivery) => delivery.key).sort(),
  );

  const outbox = await db.select().from(casOutbox);
  assert.equal(outbox.length, 2);
  assert.ok(outbox.every((item) => item.state === "SENT"));
  assert.ok(outbox.every((item) => item.attempts === 1));
});

test("failed delivery records the error for retry", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);

  const failed = await processCasOutbox({
    workerId: "failure-worker",
    maxItems: 1,
    send: async () => {
      throw new Error("transport unavailable");
    },
  });

  assert.equal(failed.failed, 1);
  assert.equal(failed.deliveries[0].state, "FAILED");

  const [failedRow] = await db
    .select()
    .from(casOutbox)
    .where(eq(casOutbox.id, failed.deliveries[0].id));
  assert.equal(failedRow.state, "FAILED");
  assert.equal(failedRow.lastError, "transport unavailable");
  assert.equal(failedRow.attempts, 1);
});

test("a delivery under the attempt cap is retried after a failure", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  const send = async () => {
    throw new Error("provider rejected request");
  };

  const first = await processCasOutbox({ workerId: "retry-worker", maxItems: 1, send });
  assert.equal(first.failed, 1);
  assert.equal(first.deadLettered, 0);

  const itemId = first.deliveries[0].id;
  const [failedRow] = await db.select().from(casOutbox).where(eq(casOutbox.id, itemId));
  assert.equal(failedRow.state, "FAILED");
  assert.equal(failedRow.attempts, 1);
  assert.ok(failedRow.attempts < MAX_DELIVERY_ATTEMPTS);

  // Back off has elapsed, so the item must be claimable again. Hold the
  // sibling item back (both rows share one createdAt) so the claim is
  // deterministic.
  await db
    .update(casOutbox)
    .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
    .where(eq(casOutbox.id, itemId));
  await db
    .update(casOutbox)
    .set({ nextAttemptAt: new Date(Date.now() + 3_600_000) })
    .where(sql`${casOutbox.incidentId} = ${id} AND ${casOutbox.id} <> ${itemId}`);

  const second = await processCasOutbox({ workerId: "retry-worker", maxItems: 1, send });
  assert.equal(second.claimed, 1);
  assert.equal(second.failed, 1);
  assert.equal(second.deadLettered, 0);

  const [retriedRow] = await db.select().from(casOutbox).where(eq(casOutbox.id, itemId));
  assert.equal(retriedRow.state, "FAILED");
  assert.equal(retriedRow.attempts, 2);

  // No abandonment is journaled while the item is still retryable.
  const events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, id));
  assert.equal(events.filter((event) => event.type === "DELIVERY_ABANDONED").length, 0);
});

test("a delivery reaching the attempt cap is dead-lettered and never claimed again", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  const send = async () => {
    throw new Error("provider permanently rejects recipient");
  };

  // Drive one outbox item to the cap. Attempts increment on each claim, so
  // after MAX_DELIVERY_ATTEMPTS - 1 failures the item sits one attempt below
  // the terminal claim. Hold the sibling item back with a future backoff so
  // only the target is exercised.
  const itemId = (
    await db.select({ id: casOutbox.id }).from(casOutbox).where(eq(casOutbox.incidentId, id)).orderBy(asc(casOutbox.createdAt)).limit(1)
  )[0].id;
  await db
    .update(casOutbox)
    .set({ nextAttemptAt: new Date(Date.now() + 3_600_000) })
    .where(sql`${casOutbox.incidentId} = ${id} AND ${casOutbox.id} <> ${itemId}`);

  for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
    const run = await processCasOutbox({ workerId: "cap-worker", maxItems: 10, send });
    const delivery = run.deliveries.find((entry) => entry.id === itemId);
    assert.ok(delivery, `attempt ${attempt}: item was not claimed`);
    assert.equal(delivery.state, "FAILED");
    assert.equal(run.deadLettered, 0);
    // Clear the backoff so the next loop iteration can claim immediately.
    await db
      .update(casOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(casOutbox.id, itemId));
  }

  // The claim at the cap moves the item to the terminal state.
  const capped = await processCasOutbox({ workerId: "cap-worker", maxItems: 10, send });
  const deadLettered = capped.deliveries.find((entry) => entry.id === itemId);
  assert.ok(deadLettered);
  assert.equal(deadLettered.state, "DEAD_LETTER");
  assert.equal(deadLettered.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.equal(capped.deadLettered, 1);

  const [terminalRow] = await db.select().from(casOutbox).where(eq(casOutbox.id, itemId));
  assert.equal(terminalRow.state, "DEAD_LETTER");
  assert.equal(terminalRow.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.equal(terminalRow.lastError, "provider permanently rejects recipient");
  assert.equal(terminalRow.claimedBy, null);

  // The abandonment is journaled exactly once so responders see it.
  const events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, id));
  const abandoned = events.filter((event) => event.type === "DELIVERY_ABANDONED");
  assert.equal(abandoned.length, 1);
  assert.match(abandoned[0].detail, /abandoned after 8 attempts/);
  assert.match(abandoned[0].detail, /provider permanently rejects recipient/);

  // The dead-lettered item is never claimed again, even after its backoff
  // window would have elapsed.
  await db
    .update(casOutbox)
    .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
    .where(eq(casOutbox.id, itemId));
  const after = await processCasOutbox({ workerId: "cap-worker", maxItems: 10, send });
  assert.equal(after.deliveries.some((entry) => entry.id === itemId), false);
  assert.equal(after.deadLettered, 0);

  const [stillTerminal] = await db.select().from(casOutbox).where(eq(casOutbox.id, itemId));
  assert.equal(stillTerminal.state, "DEAD_LETTER");
  assert.equal(stillTerminal.attempts, MAX_DELIVERY_ATTEMPTS);
});

test("the state view surfaces dead-lettered deliveries distinctly", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  // Force one item directly to its final claim so the worker dead-letters it.
  // Both items share one createdAt, so hold the sibling back with a future
  // backoff to make the claim deterministic.
  const [target] = await db
    .select({ id: casOutbox.id })
    .from(casOutbox)
    .where(eq(casOutbox.incidentId, id))
    .orderBy(asc(casOutbox.createdAt))
    .limit(1);
  await db
    .update(casOutbox)
    .set({ attempts: MAX_DELIVERY_ATTEMPTS - 1 })
    .where(eq(casOutbox.id, target.id));
  await db
    .update(casOutbox)
    .set({ nextAttemptAt: new Date(Date.now() + 3_600_000) })
    .where(sql`${casOutbox.incidentId} = ${id} AND ${casOutbox.id} <> ${target.id}`);

  const run = await processCasOutbox({
    workerId: "view-worker",
    maxItems: 1,
    send: async () => {
      throw new Error("recipient unknown");
    },
  });
  assert.equal(run.deadLettered, 1);

  const state = await fetch(`${baseUrl}/cas/state`);
  assert.equal(state.status, 200);
  const body = (await state.json()) as {
    activeIncident: {
      id: string;
      outbox: Array<{
        id: string;
        state: string;
        attempts: number;
        lastError: string | null;
        terminal: boolean;
      }>;
    };
  };
  assert.equal(body.activeIncident.id, id);
  const dead = body.activeIncident.outbox.find((item) => item.id === target.id);
  assert.ok(dead);
  assert.equal(dead.state, "DEAD_LETTER");
  assert.equal(dead.terminal, true);
  assert.equal(dead.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.equal(dead.lastError, "recipient unknown");
  const pending = body.activeIncident.outbox.find((item) => item.id !== target.id);
  assert.ok(pending);
  assert.equal(pending.state, "QUEUED");
  assert.equal(pending.terminal, false);
});

test("delivery stays duplicate-free after a worker crash", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);

  // Fake provider whose accepted idempotency keys are durable: they live
  // outside any worker and survive a worker's death.
  const provider = {
    acceptedKeys: new Set<string>(),
    presentations: [] as Array<{ id: string; key: string }>,
    sends: 0,
    suppressed: 0,
    send: async (item: typeof casOutbox.$inferSelect, key: string) => {
      provider.presentations.push({ id: item.id, key });
      if (provider.acceptedKeys.has(key)) {
        provider.suppressed += 1;
        return;
      }
      provider.acceptedKeys.add(key);
      provider.sends += 1;
    },
  };

  // Worker A claims the oldest item and the provider accepts it, then the
  // worker dies before it can mark the record SENT.
  const claimed = await claimCasOutboxItem("worker-a", new Date());
  assert.ok(claimed);
  await provider.send(claimed, claimed.id);

  const [midCrash] = await db
    .select()
    .from(casOutbox)
    .where(eq(casOutbox.id, claimed.id));
  assert.equal(midCrash.state, "PROCESSING");
  assert.equal(midCrash.claimedBy, "worker-a");
  assert.equal(midCrash.sentAt, null);

  // The lease expires while the crashed worker is gone.
  await db
    .update(casOutbox)
    .set({ claimedAt: new Date(Date.now() - DELIVERY_LEASE_MS - 1_000) })
    .where(eq(casOutbox.id, claimed.id));

  // Worker B reclaims the stale lease and retries; the provider suppresses
  // the duplicate instead of sending the alert a second time.
  const recovery = await processCasOutbox({
    workerId: "worker-b",
    maxItems: 10,
    send: provider.send,
  });
  assert.equal(recovery.sent, 2);
  assert.equal(recovery.failed, 0);
  assert.ok(recovery.deliveries.every((delivery) => delivery.state === "SENT"));

  // The reclaimed item was presented twice with the same stable key, but the
  // provider only sent it once.
  const reclaimedPresentations = provider.presentations.filter(
    (presentation) => presentation.id === claimed.id,
  );
  assert.equal(reclaimedPresentations.length, 2);
  assert.ok(reclaimedPresentations.every((presentation) => presentation.key === claimed.id));
  assert.equal(provider.sends, 2);
  assert.equal(provider.suppressed, 1);

  const outbox = await db
    .select()
    .from(casOutbox)
    .orderBy(asc(casOutbox.createdAt));
  assert.equal(outbox.length, 2);
  assert.ok(outbox.every((item) => item.state === "SENT"));
  assert.ok(outbox.every((item) => item.sentAt !== null));

  const recovered = outbox.find((item) => item.id === claimed.id);
  const fresh = outbox.find((item) => item.id !== claimed.id);
  assert.ok(recovered && fresh);
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.claimedBy, null);
  assert.equal(fresh.attempts, 1);
});

test("concurrent ACK requests accept one transition and conflict the other", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  const responses = await Promise.all([
    fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST" }),
    fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST" }),
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);

  const incident = await db.select().from(casIncidents).where(eq(casIncidents.id, id));
  assert.equal(incident[0].status, "ACTIVE_ACKED");

  const events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, id));
  assert.equal(events.filter((event) => event.type === "RESPONDER_ACK").length, 1);
});

test("concurrent RESOLVE requests accept one transition and conflict the other", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };
  const ack = await fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST" });
  assert.equal(ack.status, 200);

  const responses = await Promise.all([
    fetch(`${baseUrl}/cas/incidents/${id}/resolve`, { method: "POST" }),
    fetch(`${baseUrl}/cas/incidents/${id}/resolve`, { method: "POST" }),
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);

  const incident = await db.select().from(casIncidents).where(eq(casIncidents.id, id));
  assert.equal(incident[0].status, "RESOLVED");

  const events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, id));
  assert.equal(events.filter((event) => event.type === "RESPONDER_ACK").length, 1);
  assert.equal(events.filter((event) => event.type === "RESPONDER_RESOLVE").length, 1);
});

test("separate API processes accept one concurrent ACK and journal one event", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  const first = await startApiProcess();
  const second = await startApiProcess();
  try {
    const responses = await Promise.all([
      fetch(`${first.baseUrl}/cas/incidents/${id}/ack`, { method: "POST" }),
      fetch(`${second.baseUrl}/cas/incidents/${id}/ack`, { method: "POST" }),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);

    const [incident] = await db
      .select()
      .from(casIncidents)
      .where(eq(casIncidents.id, id));
    assert.equal(incident.status, "ACTIVE_ACKED");

    const events = await db
      .select()
      .from(casIncidentEvents)
      .where(eq(casIncidentEvents.incidentId, id));
    assert.equal(events.filter((event) => event.type === "RESPONDER_ACK").length, 1);
  } finally {
    await Promise.all([
      stopApiProcess(first.child),
      stopApiProcess(second.child),
    ]);
  }
});

test("separate API processes accept one concurrent RESOLVE and journal one event", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };
  const ack = await fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST" });
  assert.equal(ack.status, 200);

  const first = await startApiProcess();
  const second = await startApiProcess();
  try {
    const responses = await Promise.all([
      fetch(`${first.baseUrl}/cas/incidents/${id}/resolve`, { method: "POST" }),
      fetch(`${second.baseUrl}/cas/incidents/${id}/resolve`, { method: "POST" }),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);

    const [incident] = await db
      .select()
      .from(casIncidents)
      .where(eq(casIncidents.id, id));
    assert.equal(incident.status, "RESOLVED");

    const events = await db
      .select()
      .from(casIncidentEvents)
      .where(eq(casIncidentEvents.incidentId, id));
    assert.equal(events.filter((event) => event.type === "RESPONDER_RESOLVE").length, 1);
  } finally {
    await Promise.all([
      stopApiProcess(first.child),
      stopApiProcess(second.child),
    ]);
  }
});