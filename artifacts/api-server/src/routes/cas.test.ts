import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, beforeEach, test } from "node:test";
import app from "../app";
import { db, pool } from "@workspace/db";
import {
  casGateEvidence,
  casIncidentEvents,
  casIncidents,
  casOutbox,
  casSetupReadiness,
  casTransportCooldowns,
} from "@workspace/db/schema";
import { asc, eq, sql } from "drizzle-orm";
import {
  DELIVERY_LEASE_MS,
  MAX_DELIVERY_ATTEMPTS,
  claimCasOutboxItem,
  processCasOutbox,
  retryDelayMs,
} from "./cas";
import {
  createCasDeliverySender,
  createEmailProvider,
  createSmsProvider,
  createXmppProvider,
} from "../lib/delivery-providers";
import {
  getCasOutboxWorkerHeartbeat,
  recordCasOutboxTick,
  recordCasOutboxTickError,
  registerCasOutboxWorkerHeartbeat,
  resetCasOutboxWorkerHeartbeat,
} from "../lib/cas-outbox-status";
import { findJournalSecretLeaks } from "../lib/journal-secret-audit";
import {
  setCasAuthRejectionRecorder,
  type CasAuthRejection,
} from "../lib/cas-auth";

// Alert trigger and incident/outbox mutations are credential-gated. The suite
// presents this token on every guarded call; spawned API processes inherit it
// through the spawned environment. Set before any request is made.
process.env.CAS_ALERT_TOKEN ??= "cas-test-alert-token";
const AUTH_HEADERS = { authorization: `Bearer ${process.env.CAS_ALERT_TOKEN}` };

const server = app.listen(0);
await once(server, "listening");
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}/api`;
const apiServerDirectory = fileURLToPath(new URL("../../", import.meta.url));

// Isolate the suite from the deployment's shared environment: the workspace
// may legitimately have CAS_SMS_DELIVERY_MODE=device, device channel lists,
// or real provider URLs set, and ambient values would change what trigger
// queues and what the claim query excludes. Tests that need a different mode
// set it explicitly with save/restore helpers.
process.env.CAS_SMS_DELIVERY_MODE = "gateway";
delete process.env.CAS_DEVICE_CHANNELS;
delete process.env.CAS_DEVICE_TOKEN;
// Placeholder SMS provider config: gateway-mode triggers then queue an SMS
// row that worker tests can claim with their injected senders; the
// provider-free shape is exercised explicitly via withEnv.
process.env.CAS_SMS_PROVIDER_URL = "https://sms-provider.invalid/submit";
process.env.CAS_SMS_RECIPIENTS = "+1555000111";
delete process.env.CAS_EMAIL_PROVIDER_URL;
delete process.env.CAS_EMAIL_RECIPIENTS;
// The trigger route only queues outbox items for channels that can actually
// deliver, so the suite runs with a syntactically valid placeholder XMPP
// config to keep the XMPP row that older tests expect. Nothing ever fetches
// this URL: worker delivery in these tests always receives explicit adapters,
// and the child API processes' 10-second worker never ticks within an
// assertion window.
process.env.CAS_XMPP_PROVIDER_URL = "http://127.0.0.1:9/cas-test-xmpp";
process.env.CAS_XMPP_RECIPIENTS = "ops@example.org";

async function clearCasData() {
  await db.delete(casIncidentEvents);
  await db.delete(casOutbox);
  await db.delete(casIncidents);
  await db.delete(casTransportCooldowns);
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
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
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
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
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
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
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
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
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
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
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
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: oversized,
  });

  assert.equal(response.status, 413);
});

test("Gate 0A import rejects malformed reports with the failing field", async () => {
  const malformed = { ...validGate0aReport, schema: "cas-gate0a-report-v0" };
  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(malformed),
  });

  assert.equal(response.status, 400);
  const body = await response.json() as { error: string; issues: { path: string; message: string }[] };
  assert.match(body.error, /^Invalid cas-gate0a-report-v2 report — schema: /);
  assert.deepEqual(body.issues, [
    { path: "schema", message: 'Invalid literal value, expected "cas-gate0a-report-v2"' },
  ]);
});

test("Gate 0A import reports every failing field when a report has more than three problems", async () => {
  const broken = {
    ...validGate0aReport,
    schema: "cas-gate0a-report-v0",
    reportType: "gate0b-run",
    startedAtUtc: "not-a-timestamp",
    finishedAtUtc: "also-not-a-timestamp",
    coverPackage: "",
  };
  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(broken),
  });

  assert.equal(response.status, 400);
  const body = await response.json() as { error: string; issues: { path: string; message: string }[] };
  // The summary stays short, but the structured list carries every failure.
  assert.deepEqual(body.issues.map((issue) => issue.path), [
    "schema",
    "reportType",
    "startedAtUtc",
    "finishedAtUtc",
    "coverPackage",
  ]);
  assert.ok(body.issues.every((issue) => issue.message.length > 0));
  assert.match(body.error, /\(and 2 more issues\)$/);
});

test("Gate 0A import rejects physical evidence from an unapproved Pixel model", async () => {
  const wrongModel = {
    ...validGate0aReport,
    target: { ...validGate0aReport.target, model: "Pixel 8a", androidApi: 35 },
  };
  const response = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
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
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
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
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
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
    fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS }),
    fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS }),
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
    headers: AUTH_HEADERS,
  });
  assert.equal(ack.status, 200);
  assert.deepEqual(await ack.json(), {
    id: firstBody.id,
    status: "ACTIVE_ACKED",
  });

  const resolve = await fetch(
    `${baseUrl}/cas/incidents/${firstBody.id}/resolve`,
    { method: "POST", headers: AUTH_HEADERS },
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
      fetch(`${first.baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS }),
      fetch(`${second.baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS }),
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
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
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
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
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
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
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
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
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
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
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

test("a re-queued dead-letter delivery becomes claimable and deliverable again", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  // Drive one item to its final claim so the worker dead-letters it. Both
  // items share one createdAt, so hold the sibling back with a future backoff
  // to keep every claim deterministic.
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

  const abandoned = await processCasOutbox({
    workerId: "requeue-worker",
    maxItems: 1,
    send: async () => {
      throw new Error("provider permanently rejects recipient");
    },
  });
  assert.equal(abandoned.deadLettered, 1);
  const [deadRow] = await db.select().from(casOutbox).where(eq(casOutbox.id, target.id));
  assert.equal(deadRow.state, "DEAD_LETTER");

  // The responder fixes the provider problem and re-queues the delivery.
  const requeue = await fetch(`${baseUrl}/cas/outbox/${target.id}/requeue`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(requeue.status, 200);
  const requeued = (await requeue.json()) as { id: string; state: string };
  assert.equal(requeued.id, target.id);
  assert.equal(requeued.state, "QUEUED");

  const [resetRow] = await db.select().from(casOutbox).where(eq(casOutbox.id, target.id));
  assert.equal(resetRow.state, "QUEUED");
  assert.equal(resetRow.attempts, 0);
  assert.equal(resetRow.claimedBy, null);
  assert.equal(resetRow.claimedAt, null);
  assert.ok(resetRow.nextAttemptAt.getTime() <= Date.now());

  // The journal shows abandonment followed by the manual recovery, in order.
  const events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, id))
    .orderBy(asc(casIncidentEvents.createdAt));
  const abandonedIndex = events.findIndex((event) => event.type === "DELIVERY_ABANDONED");
  const requeuedEvents = events.filter((event) => event.type === "DELIVERY_REQUEUED");
  assert.ok(abandonedIndex >= 0);
  assert.equal(requeuedEvents.length, 1);
  assert.ok(events.indexOf(requeuedEvents[0]) > abandonedIndex);
  assert.match(requeuedEvents[0].detail, /re-queued the abandoned SMS delivery/);
  assert.match(requeuedEvents[0].detail, /provider permanently rejects recipient/);

  // The worker claims the re-queued item on its next pass and, with the
  // provider fixed, delivers it.
  const recovered = await processCasOutbox({
    workerId: "requeue-worker",
    maxItems: 1,
    send: async () => {},
  });
  assert.equal(recovered.claimed, 1);
  assert.equal(recovered.sent, 1);
  assert.equal(recovered.deliveries[0].id, target.id);
  assert.equal(recovered.deliveries[0].state, "SENT");

  const [sentRow] = await db.select().from(casOutbox).where(eq(casOutbox.id, target.id));
  assert.equal(sentRow.state, "SENT");
  assert.equal(sentRow.attempts, 1);
});

test("re-queue journals the responder note when one is provided", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  // Drive one item to DEAD_LETTER; hold the sibling back so claims are deterministic.
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
  await processCasOutbox({
    workerId: "requeue-note-worker",
    maxItems: 1,
    send: async () => {
      throw new Error("provider rejects stale credentials");
    },
  });

  const postRequeue = (body: unknown) =>
    fetch(`${baseUrl}/cas/outbox/${target.id}/requeue`, {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const deadLetterAgain = () =>
    db
      .update(casOutbox)
      .set({ state: "DEAD_LETTER", claimedBy: null, claimedAt: null })
      .where(eq(casOutbox.id, target.id));
  const requeuedEvents = async () =>
    (await db
      .select()
      .from(casIncidentEvents)
      .where(eq(casIncidentEvents.incidentId, id))
      .orderBy(asc(casIncidentEvents.createdAt)))
      .filter((event) => event.type === "DELIVERY_REQUEUED");

  // Malformed and out-of-bounds notes are rejected before any state change
  // or journal entry: a non-string, a whitespace-only note (trimmed to
  // empty), and a note past the 500-character bound.
  for (const body of [
    { reason: 42 },
    { reason: "   " },
    { reason: "x".repeat(501) },
  ]) {
    const invalid = await postRequeue(body);
    assert.equal(invalid.status, 400);
    const [stillDead] = await db.select().from(casOutbox).where(eq(casOutbox.id, target.id));
    assert.equal(stillDead.state, "DEAD_LETTER");
  }
  assert.equal((await requeuedEvents()).length, 0);

  // The responder records what they fixed; the journal carries the note.
  const requeue = await postRequeue({ reason: "Rotated the SMS provider credentials and verified auth in the provider console." });
  assert.equal(requeue.status, 200);

  const eventsAfterNote = await requeuedEvents();
  assert.equal(eventsAfterNote.length, 1);
  assert.match(eventsAfterNote[0].detail, /re-queued the abandoned SMS delivery/);
  assert.match(eventsAfterNote[0].detail, /Responder note: Rotated the SMS provider credentials and verified auth in the provider console\./);
  assert.match(eventsAfterNote[0].detail, /provider rejects stale credentials/);

  // Boundary notes are accepted: a single character, and exactly 500
  // characters (the note is journaled verbatim at the end of the detail).
  await deadLetterAgain();
  const oneChar = await postRequeue({ reason: "x" });
  assert.equal(oneChar.status, 200);
  await deadLetterAgain();
  const maxNote = `rotated ${"a".repeat(492)}`;
  assert.equal(maxNote.length, 500);
  const maxLength = await postRequeue({ reason: maxNote });
  assert.equal(maxLength.status, 200);

  const allEvents = await requeuedEvents();
  assert.equal(allEvents.length, 3);
  assert.match(allEvents[1].detail, /Responder note: x$/);
  assert.ok(allEvents[2].detail.endsWith(`Responder note: ${maxNote}`));
});

test("re-queue rejects notes that contain credentials and journals nothing", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  // Drive one item to DEAD_LETTER so a valid note would otherwise succeed.
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
  await processCasOutbox({
    workerId: "requeue-secret-worker",
    maxItems: 1,
    send: async () => {
      throw new Error("provider rejects stale credentials");
    },
  });

  const postRequeue = (body: unknown) =>
    fetch(`${baseUrl}/cas/outbox/${target.id}/requeue`, {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // Each of these pastes an obvious secret shape a responder might copy out
  // of a provider console while fixing the delivery problem.
  const leakedNotes = [
    "Rotated key to sk_live_EXAMPLEPLACEHOLDER",
    "New key is sk-9f8e7d6c5b4a3210fedc9876",
    "Set header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dbsj9s8df",
    "Updated provider password=Sup3rSecret!2026 in the console",
    "Reset api_key: ab12cd34ef56gh78ij90 in provider settings",
    "New bot token xoxb-123456789012-abcdefghijkl",
    "AWS key AKIAEXAMPLEPLACEHOLDER still valid",
    "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkq",
  ];
  for (const reason of leakedNotes) {
    const rejected = await postRequeue({ reason });
    assert.equal(rejected.status, 400, `note should be rejected: ${reason}`);
    const payload = (await rejected.json()) as { error: string };
    assert.match(payload.error, /appears to contain/);
    assert.match(payload.error, /Never paste credentials/);
    // The rejection must not echo the secret back.
    assert.ok(!payload.error.includes(reason));
    // No state change and no journal entry for a rejected note.
    const [stillDead] = await db.select().from(casOutbox).where(eq(casOutbox.id, target.id));
    assert.equal(stillDead.state, "DEAD_LETTER");
  }
  let events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, id));
  assert.equal(events.filter((event) => event.type === "DELIVERY_REQUEUED").length, 0);

  // Legitimate notes still pass: describing the rotation, mentioning a
  // credential by name without a value, and near-miss wording.
  const legitimateNotes = [
    "Rotated the SMS provider credentials and verified auth in the provider console.",
    "Checked the api_key rotation runbook and the password policy page.",
    "Reissued the provider token; old one revoked.",
  ];
  for (const reason of legitimateNotes) {
    const ok = await postRequeue({ reason });
    assert.equal(ok.status, 200, `note should be accepted: ${reason}`);
    // Put the item back so the next note can be exercised.
    await db
      .update(casOutbox)
      .set({ state: "DEAD_LETTER", claimedBy: null, claimedAt: null })
      .where(eq(casOutbox.id, target.id));
  }

  events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, id));
  const requeued = events.filter((event) => event.type === "DELIVERY_REQUEUED");
  assert.equal(requeued.length, legitimateNotes.length);
  assert.match(requeued[0].detail, /Responder note: Rotated the SMS provider credentials/);
});

test("journal audit flags pre-guard DELIVERY_REQUEUED entries that pasted a credential", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  // Simulate entries written before the guard shipped: stored verbatim, one
  // carrying a pasted credential, one a legitimate fix description.
  const secret = "sk_live_EXAMPLEPLACEHOLDER";
  await db.insert(casIncidentEvents).values([
    {
      id: `${id}-legacy-leak`,
      incidentId: id,
      type: "DELIVERY_REQUEUED",
      priority: "P1",
      detail: `Responder re-queued the abandoned sms delivery. Responder note: rotated to ${secret}`,
      createdAt: new Date("2026-09-10T00:00:00Z"),
    },
    {
      id: `${id}-legacy-clean`,
      incidentId: id,
      type: "DELIVERY_REQUEUED",
      priority: "P1",
      detail: "Responder re-queued the abandoned sms delivery. Responder note: Rotated the SMS provider credentials.",
      createdAt: new Date("2026-09-11T00:00:00Z"),
    },
  ]);

  const { scanned, hits } = await findJournalSecretLeaks();
  assert.ok(scanned >= 2);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].eventId, `${id}-legacy-leak`);
  assert.match(hits[0].patternLabel, /provider API key/);
  // The audit output must never carry the secret value itself.
  assert.ok(!JSON.stringify(hits).includes(secret));
});

test("re-queue refuses deliveries that are not dead-lettered", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };
  const items = await db
    .select({ id: casOutbox.id })
    .from(casOutbox)
    .where(eq(casOutbox.incidentId, id))
    .orderBy(asc(casOutbox.createdAt));
  assert.equal(items.length, 2);

  // A QUEUED item still has the regular retry path; re-queue is a conflict.
  const queuedRequeue = await fetch(`${baseUrl}/cas/outbox/${items[0].id}/requeue`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(queuedRequeue.status, 409);

  // A SENT item is already delivered; re-queue is a conflict.
  await db
    .update(casOutbox)
    .set({ nextAttemptAt: new Date(Date.now() + 3_600_000) })
    .where(eq(casOutbox.id, items[0].id));
  const sent = await processCasOutbox({
    workerId: "requeue-guard-worker",
    maxItems: 1,
    send: async () => {},
  });
  assert.equal(sent.sent, 1);
  assert.equal(sent.deliveries[0].id, items[1].id);
  const sentRequeue = await fetch(`${baseUrl}/cas/outbox/${items[1].id}/requeue`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(sentRequeue.status, 409);

  // An unknown item is a 404, and none of the refusals touch the journal.
  const missing = await fetch(`${baseUrl}/cas/outbox/no-such-item/requeue`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(missing.status, 404);
  const events = await db
    .select()
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.incidentId, id));
  assert.equal(events.filter((event) => event.type === "DELIVERY_REQUEUED").length, 0);
});

test("delivery stays duplicate-free after a worker crash", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
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
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  const responses = await Promise.all([
    fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST", headers: AUTH_HEADERS }),
    fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST", headers: AUTH_HEADERS }),
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
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };
  const ack = await fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(ack.status, 200);

  const responses = await Promise.all([
    fetch(`${baseUrl}/cas/incidents/${id}/resolve`, { method: "POST", headers: AUTH_HEADERS }),
    fetch(`${baseUrl}/cas/incidents/${id}/resolve`, { method: "POST", headers: AUTH_HEADERS }),
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
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  const first = await startApiProcess();
  const second = await startApiProcess();
  try {
    const responses = await Promise.all([
      fetch(`${first.baseUrl}/cas/incidents/${id}/ack`, { method: "POST", headers: AUTH_HEADERS }),
      fetch(`${second.baseUrl}/cas/incidents/${id}/ack`, { method: "POST", headers: AUTH_HEADERS }),
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

type StubProviderRequest = {
  idempotencyKey: string | undefined;
  authorization: string | undefined;
  payload: Record<string, unknown>;
};

type StubProviderResponse = number | { status: number; headers?: Record<string, string> };

async function startStubProvider(handler: (request: StubProviderRequest) => StubProviderResponse | Promise<StubProviderResponse>) {
  const requests: StubProviderRequest[] = [];
  const server: HttpServer = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const request: StubProviderRequest = {
        idempotencyKey: req.headers["idempotency-key"] as string | undefined,
        authorization: req.headers.authorization,
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      requests.push(request);
      const handled = await handler(request);
      const status = typeof handled === "number" ? handled : handled.status;
      const extraHeaders = typeof handled === "number" ? {} : handled.headers ?? {};
      res.writeHead(status, { "Content-Type": "text/plain", ...extraHeaders });
      res.end(`stub status ${status}`);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/submit`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

test("SMS and XMPP adapters send through their providers with outbox-ID idempotency keys", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id: incidentId } = (await trigger.json()) as { id: string };

  const provider = await startStubProvider(() => 200);
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({
        url: provider.url,
        token: "sms-token",
        from: "+15550000",
        recipients: ["+15550001", "+15550002"],
      }),
      xmpp: createXmppProvider({
        url: provider.url,
        token: "xmpp-token",
        from: "cas@example.org",
        recipients: ["ops@example.org"],
      }),
    });

    const result = await processCasOutbox({ workerId: "provider-worker", send });
    assert.equal(result.claimed, 2);
    assert.equal(result.sent, 2);
    assert.equal(result.failed, 0);

    const outbox = await db
      .select()
      .from(casOutbox)
      .where(eq(casOutbox.incidentId, incidentId));
    assert.ok(outbox.every((item) => item.state === "SENT"));

    // Two SMS recipients plus one XMPP recipient reached the provider.
    assert.equal(provider.requests.length, 3);
    const outboxIds = outbox.map((item) => item.id);
    for (const request of provider.requests) {
      assert.ok(request.idempotencyKey);
      const [outboxId, recipient] = request.idempotencyKey!.split(":");
      assert.ok(outboxIds.includes(outboxId));
      assert.equal(request.payload.idempotencyKey, request.idempotencyKey);
      assert.equal(request.payload.to, recipient);
      assert.ok(String(request.payload.body).includes(incidentId));
    }

    const smsRequests = provider.requests.filter((request) => request.authorization === "Bearer sms-token");
    assert.deepEqual(
      smsRequests.map((request) => request.idempotencyKey).sort(),
      [`${incidentId}-sms:+15550001`, `${incidentId}-sms:+15550002`],
    );
    assert.ok(smsRequests.every((request) => request.payload.from === "+15550000"));

    const xmppRequests = provider.requests.filter((request) => request.authorization === "Bearer xmpp-token");
    assert.equal(xmppRequests.length, 1);
    assert.equal(xmppRequests[0].idempotencyKey, `${incidentId}-xmpp:ops@example.org`);
    assert.equal(xmppRequests[0].payload.stanzaId, `${incidentId}-xmpp:ops@example.org`);
    assert.equal(xmppRequests[0].payload.from, "cas@example.org");
  } finally {
    await provider.close();
  }
});

test("a provider outage fails the delivery as retryable and keeps the outbox record", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  const provider = await startStubProvider(() => 503);
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: provider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: provider.url, recipients: ["ops@example.org"] }),
    });
    const result = await processCasOutbox({ workerId: "outage-worker", send });
    assert.equal(result.failed, 2);
    assert.equal(result.sent, 0);

    const outbox = await db.select().from(casOutbox);
    assert.equal(outbox.length, 2);
    for (const item of outbox) {
      assert.equal(item.state, "FAILED");
      assert.match(item.lastError ?? "", /^server-outage \(retryable\):/);
      assert.match(item.lastError ?? "", /HTTP 503/);
      assert.equal(item.attempts, 1);
      assert.ok(item.nextAttemptAt.getTime() > Date.now());
      assert.equal(item.sentAt, null);
    }
  } finally {
    await provider.close();
  }
});

test("a 429 with a Retry-After hint schedules the next attempt no earlier than the hint", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  const provider = await startStubProvider(() => ({
    status: 429,
    headers: { "Retry-After": "120" },
  }));
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: provider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: provider.url, recipients: ["ops@example.org"] }),
    });
    const startedAt = Date.now();
    const result = await processCasOutbox({ workerId: "rate-limit-worker", send });
    assert.equal(result.failed, 2);
    assert.equal(result.sent, 0);

    const outbox = await db.select().from(casOutbox);
    assert.equal(outbox.length, 2);
    for (const item of outbox) {
      assert.equal(item.state, "FAILED");
      assert.match(item.lastError ?? "", /^rate-limited \(retryable\):/);
      // The 120s hint exceeds the generic 60s backoff cap, so observing a
      // delay near 120s proves the hint (not the default backoff) scheduled
      // this attempt.
      const delay = item.nextAttemptAt.getTime() - startedAt;
      assert.ok(delay >= 120_000, `nextAttemptAt delay ${delay}ms is earlier than the 120s hint`);
      assert.ok(delay < 130_000, `nextAttemptAt delay ${delay}ms overshoots the 120s hint`);
    }
  } finally {
    await provider.close();
  }
});

test("a 429 without a Retry-After hint falls back to exponential backoff", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  const provider = await startStubProvider(() => 429);
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: provider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: provider.url, recipients: ["ops@example.org"] }),
    });
    const startedAt = Date.now();
    const result = await processCasOutbox({ workerId: "unhinted-rate-limit-worker", send });
    assert.equal(result.failed, 2);

    const outbox = await db.select().from(casOutbox);
    for (const item of outbox) {
      assert.equal(item.state, "FAILED");
      assert.match(item.lastError ?? "", /^rate-limited \(retryable\):/);
      // First failure: 1s of generic backoff with up to -20% jitter (800ms
      // floor), nowhere near a provider hint.
      const delay = item.nextAttemptAt.getTime() - startedAt;
      assert.ok(delay >= 800, `nextAttemptAt delay ${delay}ms skipped the generic backoff`);
      assert.ok(delay < 10_000, `nextAttemptAt delay ${delay}ms looks like a hint was applied`);
    }
  } finally {
    await provider.close();
  }
});

test("a 429 with a malformed Retry-After hint falls back to exponential backoff", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  const provider = await startStubProvider(() => ({
    status: 429,
    headers: { "Retry-After": "not-a-valid-hint" },
  }));
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: provider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: provider.url, recipients: ["ops@example.org"] }),
    });
    const startedAt = Date.now();
    const result = await processCasOutbox({ workerId: "malformed-hint-worker", send });
    assert.equal(result.failed, 2);

    const outbox = await db.select().from(casOutbox);
    for (const item of outbox) {
      assert.equal(item.state, "FAILED");
      assert.match(item.lastError ?? "", /^rate-limited \(retryable\):/);
      // Same as the unhinted case: 1s backoff with up to -20% jitter.
      const delay = item.nextAttemptAt.getTime() - startedAt;
      assert.ok(delay >= 800, `nextAttemptAt delay ${delay}ms skipped the generic backoff`);
      assert.ok(delay < 10_000, `nextAttemptAt delay ${delay}ms looks like a hint was applied`);
    }
  } finally {
    await provider.close();
  }
});

test("retryDelayMs jitter stays within ±20% of the exponential backoff", () => {
  // Deterministic extremes: random() === 0 gives the full -20%, === 1 the +20%.
  for (let attempts = 1; attempts <= 8; attempts += 1) {
    const backoff = Math.min(
      60_000,
      1_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 6),
    );
    assert.equal(retryDelayMs(attempts, undefined, () => 0), Math.round(backoff * 0.8));
    assert.equal(retryDelayMs(attempts, undefined, () => 1), Math.round(backoff * 1.2));
  }

  // A spread of pseudo-random draws must never leave the jitter band, which
  // is what spreads a synchronized fleet of retries across the window.
  let seed = 42;
  const lcg = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 1_000; i += 1) {
    const attempts = 1 + Math.floor(lcg() * 8);
    const backoff = Math.min(
      60_000,
      1_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 6),
    );
    const delay = retryDelayMs(attempts, undefined, lcg);
    assert.ok(delay >= Math.floor(backoff * 0.8), `delay ${delay}ms is below the -20% jitter floor of ${backoff}ms`);
    assert.ok(delay <= Math.ceil(backoff * 1.2), `delay ${delay}ms is above the +20% jitter ceiling of ${backoff}ms`);
  }
});

test("retryDelayMs jitter never undercuts a provider's Retry-After hint", () => {
  // A 120s hint against a 1s first-attempt backoff: even the full -20% draw
  // must not schedule the next attempt sooner than the provider asked for.
  assert.equal(retryDelayMs(1, 120_000, () => 0), 120_000);
  assert.equal(retryDelayMs(1, 120_000, () => 1), 120_000);
  // A hint inside the jitter band is still honored as a lower bound.
  assert.ok(retryDelayMs(4, 8_800, () => 0) >= 8_800);
  assert.ok(retryDelayMs(4, 8_800, () => 1) >= 8_800);
});

test("a rate-limited transport is cooled down for the rest of the run so it cannot starve the other transport", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  // Queue two older SMS items ahead of the triggered pair so, without a
  // per-transport cooldown, the worker would hammer the throttled SMS
  // provider for the whole batch before ever reaching XMPP.
  await db.insert(casOutbox).values([
    { id: `${id}-sms-backlog-1`, incidentId: id, transport: "SMS", state: "QUEUED", priority: "P1", createdAt: new Date(Date.now() - 3_000) },
    { id: `${id}-sms-backlog-2`, incidentId: id, transport: "SMS", state: "QUEUED", priority: "P1", createdAt: new Date(Date.now() - 2_000) },
  ]);

  const smsProvider = await startStubProvider(() => 429);
  const xmppProvider = await startStubProvider(() => 200);
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: smsProvider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: xmppProvider.url, recipients: ["ops@example.org"] }),
    });
    const result = await processCasOutbox({ workerId: "cooldown-worker", maxItems: 10, send });

    // The first SMS failure puts SMS on cooldown for this run; the remaining
    // SMS backlog is left queued instead of hammering the provider, and the
    // XMPP item is delivered in the same run.
    assert.equal(smsProvider.requests.length, 1);
    assert.equal(xmppProvider.requests.length, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.sent, 1);

    const outbox = await db.select().from(casOutbox);
    assert.equal(outbox.filter((item) => item.transport === "SMS" && item.state === "QUEUED").length, 2);
    assert.equal(outbox.filter((item) => item.transport === "SMS" && item.state === "FAILED").length, 1);
    assert.equal(outbox.filter((item) => item.transport === "XMPP" && item.state === "SENT").length, 1);
  } finally {
    await smsProvider.close();
    await xmppProvider.close();
  }
});

test("an oversized Retry-After hint is clamped to the cooldown cap instead of being ignored", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  // One hour is beyond the sane-hint cap (10 minutes). Dropping the hint
  // entirely would retry in ~1s and keep hammering the provider; clamping
  // must cool the transport down for the full cap instead.
  const provider = await startStubProvider(() => ({
    status: 429,
    headers: { "Retry-After": "3600" },
  }));
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: provider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: provider.url, recipients: ["ops@example.org"] }),
    });
    const startedAt = Date.now();
    const result = await processCasOutbox({ workerId: "clamp-worker", send });
    assert.equal(result.failed, 2);

    const outbox = await db.select().from(casOutbox);
    for (const item of outbox) {
      assert.equal(item.state, "FAILED");
      const delay = item.nextAttemptAt.getTime() - startedAt;
      assert.ok(delay >= 600_000, `nextAttemptAt delay ${delay}ms ignored the hint instead of clamping it`);
      assert.ok(delay < 610_000, `nextAttemptAt delay ${delay}ms overshoots the 600s clamp`);
    }
  } finally {
    await provider.close();
  }
});

test("a rate-limited transport stays cooled down across worker ticks while the other transport drains", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  // Deep SMS backlog ahead of the XMPP item: without a cross-tick cooldown,
  // every worker tick would claim another SMS record and hammer the
  // throttled provider well before its 120s Retry-After window elapses.
  await db.insert(casOutbox).values([
    { id: `${id}-sms-backlog-1`, incidentId: id, transport: "SMS", state: "QUEUED", priority: "P1", createdAt: new Date(Date.now() - 3_000) },
    { id: `${id}-sms-backlog-2`, incidentId: id, transport: "SMS", state: "QUEUED", priority: "P1", createdAt: new Date(Date.now() - 2_000) },
  ]);

  const smsProvider = await startStubProvider(() => ({
    status: 429,
    headers: { "Retry-After": "120" },
  }));
  const xmppProvider = await startStubProvider(() => 200);
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: smsProvider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: xmppProvider.url, recipients: ["ops@example.org"] }),
    });

    // First tick: one SMS attempt fails with the 120s hint, XMPP drains.
    const first = await processCasOutbox({ workerId: "tick-worker", maxItems: 10, send });
    assert.equal(smsProvider.requests.length, 1);
    assert.equal(first.failed, 1);
    assert.equal(first.sent, 1);

    // Subsequent ticks (different worker, like separate API processes) must
    // not touch the SMS provider again while the hint window is still open.
    for (let tick = 0; tick < 3; tick += 1) {
      const run = await processCasOutbox({ workerId: `tick-worker-${tick}`, maxItems: 10, send });
      assert.equal(run.claimed, 0, `tick ${tick + 2} claimed a cooled-down transport`);
    }
    assert.equal(smsProvider.requests.length, 1);
    assert.equal(xmppProvider.requests.length, 1);

    // The cooldown row is persisted, so the exclusion survives process
    // restarts too.
    const cooldowns = await db.select().from(casTransportCooldowns);
    assert.equal(cooldowns.length, 1);
    assert.equal(cooldowns[0].transport, "SMS");
    assert.ok(cooldowns[0].nextAllowedAt.getTime() > Date.now() + 100_000);

    const outbox = await db.select().from(casOutbox);
    assert.equal(outbox.filter((item) => item.transport === "SMS" && item.state === "QUEUED").length, 2);
    assert.equal(outbox.filter((item) => item.transport === "XMPP" && item.state === "SENT").length, 1);
  } finally {
    await smsProvider.close();
    await xmppProvider.close();
  }
});

test("a 503 with a Retry-After hint cools the transport down across worker ticks, not just the failed item", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  await db.insert(casOutbox).values([
    { id: `${id}-sms-backlog-1`, incidentId: id, transport: "SMS", state: "QUEUED", priority: "P1", createdAt: new Date(Date.now() - 3_000) },
    { id: `${id}-sms-backlog-2`, incidentId: id, transport: "SMS", state: "QUEUED", priority: "P1", createdAt: new Date(Date.now() - 2_000) },
  ]);

  const smsProvider = await startStubProvider(() => ({
    status: 503,
    headers: { "Retry-After": "120" },
  }));
  const xmppProvider = await startStubProvider(() => 200);
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: smsProvider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: xmppProvider.url, recipients: ["ops@example.org"] }),
    });

    const first = await processCasOutbox({ workerId: "outage-hint-worker", maxItems: 10, send });
    assert.equal(smsProvider.requests.length, 1);
    assert.equal(first.failed, 1);
    assert.equal(first.sent, 1);

    // The honored hint is a transport-level cooldown: later ticks must not
    // hit the failing provider again while the window is open, even though
    // only the first backlog item carries the scheduled delay.
    const second = await processCasOutbox({ workerId: "outage-hint-worker-2", maxItems: 10, send });
    assert.equal(second.claimed, 0);
    assert.equal(smsProvider.requests.length, 1);

    const cooldowns = await db.select().from(casTransportCooldowns);
    assert.equal(cooldowns.length, 1);
    assert.equal(cooldowns[0].transport, "SMS");
    assert.ok(cooldowns[0].nextAllowedAt.getTime() > Date.now() + 100_000);

    const failed = await db.select().from(casOutbox).where(eq(casOutbox.state, "FAILED"));
    assert.equal(failed.length, 1);
    assert.match(failed[0].lastError ?? "", /^server-outage \(retryable\):/);
  } finally {
    await smsProvider.close();
    await xmppProvider.close();
  }
});

test("a provider authentication failure is classified as permanent", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  const provider = await startStubProvider(() => 403);
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: provider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: provider.url, recipients: ["ops@example.org"] }),
    });
    const result = await processCasOutbox({ workerId: "auth-worker", send });
    assert.equal(result.failed, 2);

    const outbox = await db.select().from(casOutbox);
    for (const item of outbox) {
      assert.equal(item.state, "FAILED");
      assert.match(item.lastError ?? "", /^authentication \(permanent\):/);
    }
  } finally {
    await provider.close();
  }
});

test("a provider idempotency conflict on replay counts as delivered, not a duplicate", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  // The provider remembers keys it already accepted and answers replays with
  // the documented 409 + X-Idempotency-Replayed contract, which is how a
  // retried worker learns the first attempt did deliver.
  const acceptedKeys = new Set<string>();
  const provider = await startStubProvider((request) => {
    if (acceptedKeys.has(request.idempotencyKey!)) {
      return { status: 409, headers: { "X-Idempotency-Replayed": "true" } };
    }
    acceptedKeys.add(request.idempotencyKey!);
    return 200;
  });
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: provider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: provider.url, recipients: ["ops@example.org"] }),
    });

    const first = await processCasOutbox({ workerId: "replay-worker-a", send });
    assert.equal(first.sent, 2);

    // Simulate a worker that reclaimed the lease after a crash: force the rows
    // back to QUEUED and let a second worker replay the same idempotency keys.
    await db.update(casOutbox).set({ state: "QUEUED", sentAt: null, nextAttemptAt: new Date() });
    const second = await processCasOutbox({ workerId: "replay-worker-b", send });
    assert.equal(second.sent, 2);
    assert.equal(second.failed, 0);

    const outbox = await db.select().from(casOutbox);
    assert.ok(outbox.every((item) => item.state === "SENT"));
    // Each recipient key hit the provider exactly twice: the original send and
    // the replay; the provider suppressed the duplicate via the stable key.
    assert.equal(provider.requests.length, 4);
    assert.equal(acceptedKeys.size, 2);
  } finally {
    await provider.close();
  }
});

test("a bare 409 on first submission fails as rejected, never as sent", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  // A 409 without the documented X-Idempotency-Replayed header is an ordinary
  // conflict; the alert must not be marked delivered.
  const provider = await startStubProvider(() => 409);
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: provider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: provider.url, recipients: ["ops@example.org"] }),
    });
    const result = await processCasOutbox({ workerId: "conflict-worker", send });
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 2);

    const outbox = await db.select().from(casOutbox);
    for (const item of outbox) {
      assert.equal(item.state, "FAILED");
      assert.match(item.lastError ?? "", /^rejected \(permanent\):/);
      assert.match(item.lastError ?? "", /not a recognized idempotent replay/);
      assert.equal(item.sentAt, null);
    }
  } finally {
    await provider.close();
  }
});

test("a non-HTTPS provider endpoint is refused before any alert content is sent", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  const send = createCasDeliverySender({
    sms: createSmsProvider({ url: "http://sms-gateway.example.com/submit", recipients: ["+15550001"] }),
    xmpp: createXmppProvider({ url: "http://xmpp-gateway.example.com/submit", recipients: ["ops@example.org"] }),
  });
  const result = await processCasOutbox({ workerId: "cleartext-worker", send });
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 2);

  const outbox = await db.select().from(casOutbox);
  for (const item of outbox) {
    assert.equal(item.state, "FAILED");
    assert.match(item.lastError ?? "", /^not-configured \(permanent\):/);
    assert.match(item.lastError ?? "", /must use HTTPS/);
    assert.equal(item.sentAt, null);
  }
});

test("provider redirects are never followed and never mark an alert sent", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  // A redirect target that would happily return 200 if fetch followed the
  // redirect — which must never happen, since 301/302 would fake delivery and
  // 307/308 could forward alert content to an untrusted origin.
  let targetHits = 0;
  const target: HttpServer = createHttpServer((_req, res) => {
    targetHits += 1;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("redirect target");
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/final`;

  // SMS gets a 302 (body-dropping redirect), XMPP gets a 308 (payload-forwarding redirect).
  const provider = await startStubProvider((request) =>
    String(request.payload.to).startsWith("+")
      ? { status: 302, headers: { Location: targetUrl } }
      : { status: 308, headers: { Location: targetUrl } });
  try {
    const send = createCasDeliverySender({
      sms: createSmsProvider({ url: provider.url, recipients: ["+15550001"] }),
      xmpp: createXmppProvider({ url: provider.url, recipients: ["ops@example.org"] }),
    });
    const result = await processCasOutbox({ workerId: "redirect-worker", send });
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 2);
    assert.equal(targetHits, 0);

    const outbox = await db.select().from(casOutbox);
    for (const item of outbox) {
      assert.equal(item.state, "FAILED");
      assert.match(item.lastError ?? "", /^rejected \(permanent\):/);
      assert.match(item.lastError ?? "", /redirects are never followed/);
      assert.equal(item.sentAt, null);
    }
  } finally {
    await provider.close();
    target.close();
    await once(target, "close");
  }
});

test("an unreachable provider is classified as a retryable network failure", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const deadPort = (portServer.address() as AddressInfo).port;
  portServer.close();
  await once(portServer, "close");

  const send = createCasDeliverySender({
    sms: createSmsProvider({ url: `http://127.0.0.1:${deadPort}/submit`, recipients: ["+15550001"] }),
    xmpp: createXmppProvider({ url: `http://127.0.0.1:${deadPort}/submit`, recipients: ["ops@example.org"] }),
  });
  const result = await processCasOutbox({ workerId: "offline-worker", send });
  assert.equal(result.failed, 2);

  const outbox = await db.select().from(casOutbox);
  for (const item of outbox) {
    assert.equal(item.state, "FAILED");
    assert.match(item.lastError ?? "", /^network \(retryable\):/);
  }
});

test("a transport without a configured provider fails explicitly and keeps the record", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);

  const send = createCasDeliverySender({});
  const result = await processCasOutbox({ workerId: "unconfigured-worker", send });
  assert.equal(result.claimed, 2);
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 2);

  const outbox = await db.select().from(casOutbox);
  assert.equal(outbox.length, 2);
  for (const item of outbox) {
    assert.equal(item.state, "FAILED");
    assert.match(item.lastError ?? "", /^not-configured \(permanent\):/);
    assert.equal(item.attempts, 1);
  }
});

test("separate API processes accept one concurrent RESOLVE and journal one event", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };
  const ack = await fetch(`${baseUrl}/cas/incidents/${id}/ack`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(ack.status, 200);

  const first = await startApiProcess();
  const second = await startApiProcess();
  try {
    const responses = await Promise.all([
      fetch(`${first.baseUrl}/cas/incidents/${id}/resolve`, { method: "POST", headers: AUTH_HEADERS }),
      fetch(`${second.baseUrl}/cas/incidents/${id}/resolve`, { method: "POST", headers: AUTH_HEADERS }),
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
test("outbox status reports counts by state and the oldest pending item", async () => {
  const now = new Date();
  await db.insert(casIncidents).values({
    id: "status-inc",
    priority: "P1",
    status: "ACTIVE_UNACKED",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(casOutbox).values([
    { id: "status-queued", incidentId: "status-inc", transport: "SMS", state: "QUEUED", priority: "P1", createdAt: new Date(now.getTime() - 120_000) },
    { id: "status-failed", incidentId: "status-inc", transport: "XMPP", state: "FAILED", priority: "P1", attempts: 2, lastError: "provider 503", createdAt: new Date(now.getTime() - 60_000) },
    { id: "status-dead", incidentId: "status-inc", transport: "SMS", state: "DEAD_LETTER", priority: "P1", attempts: 8, lastError: "permanent rejection", createdAt: now },
    { id: "status-sent", incidentId: "status-inc", transport: "XMPP", state: "SENT", priority: "P1", createdAt: now },
  ]);

  const response = await fetch(`${baseUrl}/cas/outbox/status`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    counts: Record<string, number>;
    oldestPendingAt: string | null;
    lastDeliveryError: { transport: string; state: string; attempts: number; message: string } | null;
    worker: unknown;
  };

  // Dead-lettered deliveries must be countable without a database query.
  assert.equal(body.counts.QUEUED, 1);
  assert.equal(body.counts.FAILED, 1);
  assert.equal(body.counts.DEAD_LETTER, 1);
  assert.equal(body.counts.SENT, 1);
  assert.equal(body.counts.PROCESSING, 0);

  // The oldest still-pending item drives the console's "stuck" warning.
  assert.equal(body.oldestPendingAt, new Date(now.getTime() - 120_000).toISOString());

  // The most recent failure names the provider problem.
  assert.deepEqual(body.lastDeliveryError, {
    transport: "SMS",
    state: "DEAD_LETTER",
    attempts: 8,
    message: "permanent rejection",
  });
});

test("a dead-lettered delivery is reported by the status endpoint end-to-end", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  const send = async () => {
    throw new Error("provider permanently rejects recipient");
  };

  // Drive the SMS outbox item through real worker failures to the attempt
  // cap. Hold the sibling item back so the claim is deterministic (both rows
  // share one createdAt, so order alone cannot pick the target).
  const itemId = (
    await db.select({ id: casOutbox.id }).from(casOutbox).where(sql`${casOutbox.incidentId} = ${id} AND ${casOutbox.transport} = 'SMS'`).limit(1)
  )[0].id;
  await db
    .update(casOutbox)
    .set({ nextAttemptAt: new Date(Date.now() + 3_600_000) })
    .where(sql`${casOutbox.incidentId} = ${id} AND ${casOutbox.id} <> ${itemId}`);

  // Before the cap is reached the status endpoint must not cry dead letter.
  const before = await (await fetch(`${baseUrl}/cas/outbox/status`)).json() as { counts: Record<string, number> };
  assert.equal(before.counts.DEAD_LETTER, 0);

  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
    await db
      .update(casOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(casOutbox.id, itemId));
    await processCasOutbox({ workerId: "status-worker", maxItems: 1, send });
  }

  const response = await fetch(`${baseUrl}/cas/outbox/status`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    counts: Record<string, number>;
    lastDeliveryError: { transport: string; state: string; attempts: number; message: string } | null;
  };

  // The console's red "abandoned (dead letter)" alarm reads these two fields;
  // if either disappears the responder never hears about the lost alert.
  assert.equal(body.counts.DEAD_LETTER, 1);
  assert.deepEqual(body.lastDeliveryError, {
    transport: "SMS",
    state: "DEAD_LETTER",
    attempts: MAX_DELIVERY_ATTEMPTS,
    message: "provider permanently rejects recipient",
  });
});

test("outbox status reports an empty pipeline with no worker heartbeat", async () => {
  const response = await fetch(`${baseUrl}/cas/outbox/status`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    counts: Record<string, number>;
    oldestPendingAt: string | null;
    lastDeliveryError: unknown;
    worker: unknown;
  };

  assert.deepEqual(body.counts, {
    QUEUED: 0,
    PROCESSING: 0,
    FAILED: 0,
    SENT: 0,
    DEAD_LETTER: 0,
  });
  assert.equal(body.oldestPendingAt, null);
  assert.equal(body.lastDeliveryError, null);
  // The in-process test app never starts the delivery worker, so the
  // heartbeat must be reported as absent rather than invented.
  assert.equal(body.worker, null);
});

test("outbox status surfaces the worker heartbeat once ticks are recorded", async () => {
  resetCasOutboxWorkerHeartbeat();
  try {
    registerCasOutboxWorkerHeartbeat({
      workerId: "status-test-worker",
      intervalMs: 10_000,
      batchSize: 10,
    });
    recordCasOutboxTick({
      durationMs: 42,
      result: { claimed: 2, sent: 1, failed: 1, deadLettered: 0 },
    });
    recordCasOutboxTickError("database hiccup");

    const response = await fetch(`${baseUrl}/cas/outbox/status`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      worker: {
        workerId: string;
        intervalMs: number;
        batchSize: number;
        lastTickAt: string | null;
        ticksCompleted: number;
        lastTick: { claimed: number; sent: number; failed: number; deadLettered: number } | null;
        lastError: { message: string; at: string } | null;
        stoppedAt: string | null;
      } | null;
    };

    assert.ok(body.worker);
    assert.equal(body.worker.workerId, "status-test-worker");
    assert.equal(body.worker.intervalMs, 10_000);
    assert.equal(body.worker.batchSize, 10);
    assert.equal(body.worker.ticksCompleted, 1);
    assert.deepEqual(body.worker.lastTick, { claimed: 2, sent: 1, failed: 1, deadLettered: 0 });
    assert.ok(body.worker.lastTickAt);
    assert.equal(body.worker.lastError?.message, "database hiccup");
    assert.equal(body.worker.stoppedAt, null);
    assert.ok(getCasOutboxWorkerHeartbeat());
  } finally {
    resetCasOutboxWorkerHeartbeat();
  }
});

// ---- Device-direct SMS mode (CAS_SMS_DELIVERY_MODE=device) ----
// The alerting handset is the SMS delivery agent: the worker never claims SMS
// items, the handset reports outcomes via the sms-receipt endpoint, and
// re-queued items are picked up through the device-pending list.

// Handset endpoints require the shared device token; device-mode tests
// authenticate with this header.
const DEVICE_TOKEN = "contract-test-device-token";
const deviceAuth = { "X-CAS-Device-Token": DEVICE_TOKEN };

async function withSmsDeliveryMode<T>(mode: "device" | "gateway", fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CAS_SMS_DELIVERY_MODE;
  const previousToken = process.env.CAS_DEVICE_TOKEN;
  process.env.CAS_SMS_DELIVERY_MODE = mode;
  // Device mode fails closed without a token, so tests opt into one here;
  // the dedicated auth test covers the missing/wrong-token paths.
  if (mode === "device") process.env.CAS_DEVICE_TOKEN = DEVICE_TOKEN;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CAS_SMS_DELIVERY_MODE;
    else process.env.CAS_SMS_DELIVERY_MODE = previous;
    if (previousToken === undefined) delete process.env.CAS_DEVICE_TOKEN;
    else process.env.CAS_DEVICE_TOKEN = previousToken;
  }
}

test("device mode keeps the worker from claiming SMS items while XMPP still drains", async () => {
  await withSmsDeliveryMode("device", async () => {
    const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
    assert.equal(trigger.status, 201);
    const { id } = (await trigger.json()) as { id: string };

    const sent: string[] = [];
    const run = await processCasOutbox({
      workerId: "device-mode-worker",
      maxItems: 10,
      send: async (item) => {
        sent.push(item.transport);
        throw new Error("no XMPP provider configured in test");
      },
    });

    // The XMPP item is claimed as usual; the SMS item is the handset's job.
    assert.deepEqual(sent, ["XMPP"]);
    assert.equal(run.claimed, 1);

    const rows = await db.select().from(casOutbox).where(eq(casOutbox.incidentId, id));
    const sms = rows.find((row) => row.transport === "SMS");
    const xmpp = rows.find((row) => row.transport === "XMPP");
    assert.ok(sms && xmpp);
    assert.equal(sms.state, "QUEUED");
    assert.equal(sms.attempts, 0);
    assert.equal(xmpp.state, "FAILED");

    // The status endpoint tells the console who delivers SMS.
    const status = await (await fetch(`${baseUrl}/cas/outbox/status`)).json() as { smsDeliveryMode: string };
    assert.equal(status.smsDeliveryMode, "device");
  });
  const status = await (await fetch(`${baseUrl}/cas/outbox/status`)).json() as { smsDeliveryMode: string };
  assert.equal(status.smsDeliveryMode, "gateway");
});

test("device-pending lists only handset-awaiting SMS items and refuses gateway mode", async () => {
  const gatewayResponse = await fetch(`${baseUrl}/cas/outbox/device-pending`, { headers: deviceAuth });
  assert.equal(gatewayResponse.status, 409);

  await withSmsDeliveryMode("device", async () => {
    const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
    const { id } = (await trigger.json()) as { id: string };

    const response = await fetch(`${baseUrl}/cas/outbox/device-pending`, { headers: deviceAuth });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { items: Array<{ id: string; incidentId: string; cycleToken: string | null }> };
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].incidentId, id);
    assert.equal(body.items[0].id, `${id}-sms`);
    // The initial cycle has no token; one appears only after a re-queue.
    assert.equal(body.items[0].cycleToken, null);

    // A delivered item drops off the pickup list.
    const receipt = await fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceAuth },
      body: JSON.stringify({ results: [{ recipient: "+1555000111", ok: true }] }),
    });
    assert.equal(receipt.status, 200);
    const after = await (await fetch(`${baseUrl}/cas/outbox/device-pending`, { headers: deviceAuth })).json() as { items: unknown[] };
    assert.equal(after.items.length, 0);
  });
});

test("an all-ok device receipt marks the SMS item SENT, journals it, and replays safely", async () => {
  await withSmsDeliveryMode("device", async () => {
    const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
    const { id } = (await trigger.json()) as { id: string };

    const post = () =>
      fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deviceAuth },
        body: JSON.stringify({
          results: [
            { recipient: "+1555000111", ok: true },
            { recipient: "+1555000222", ok: true },
          ],
        }),
      });

    const first = await post();
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { id, state: "SENT" });

    const [row] = await db.select().from(casOutbox).where(eq(casOutbox.id, `${id}-sms`));
    assert.equal(row.state, "SENT");
    assert.ok(row.sentAt);
    assert.equal(row.lastError, null);

    const events = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, id));
    const reported = events.filter((event) => event.type === "DELIVERY_REPORTED");
    assert.equal(reported.length, 1);
    assert.match(reported[0].detail, /2 responder\(s\)/);

    // A retried receipt (handshake lost over a data outage) must not
    // re-journal or error out.
    const replay = await post();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { id, state: "SENT", replay: true });
    const eventsAfter = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, id));
    assert.equal(eventsAfter.filter((event) => event.type === "DELIVERY_REPORTED").length, 1);
  });
});

test("a failed device receipt dead-letters immediately and masks responder numbers", async () => {
  await withSmsDeliveryMode("device", async () => {
    const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
    const { id } = (await trigger.json()) as { id: string };

    const receipt = await fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceAuth },
      body: JSON.stringify({
        results: [
          { recipient: "+15557654321", ok: false, error: "RESULT_ERROR_NO_SERVICE" },
          { recipient: "+1555000222", ok: true },
        ],
      }),
    });
    assert.equal(receipt.status, 200);
    assert.deepEqual(await receipt.json(), { id, state: "DEAD_LETTER" });

    const [row] = await db.select().from(casOutbox).where(eq(casOutbox.id, `${id}-sms`));
    assert.equal(row.state, "DEAD_LETTER");
    assert.ok(row.lastError);

    const events = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, id));
    const abandoned = events.filter((event) => event.type === "DELIVERY_ABANDONED");
    assert.equal(abandoned.length, 1);
    assert.match(abandoned[0].detail, /1 of 2 responder\(s\)/);
    assert.match(abandoned[0].detail, /RESULT_ERROR_NO_SERVICE/);

    // The journal and lastError are broadly visible; a full responder number
    // must never appear in either, only the masked tail.
    for (const text of [abandoned[0].detail, row.lastError ?? ""]) {
      assert.ok(!text.includes("15557654321"), `unmasked recipient leaked into: ${text}`);
      assert.ok(!text.includes("1555000222"), `unmasked recipient leaked into: ${text}`);
      assert.match(text, /\u2022\u2022\u202221/);
    }
  });
});

test("device receipts reject unknown incidents, dead-lettered items, bad bodies, and gateway mode", async () => {
  await withSmsDeliveryMode("device", async () => {
    const unknown = await fetch(`${baseUrl}/cas/incidents/nope/sms-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceAuth },
      body: JSON.stringify({ results: [{ recipient: "+1555000111", ok: true }] }),
    });
    assert.equal(unknown.status, 404);

    const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
    const { id } = (await trigger.json()) as { id: string };

    const empty = await fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceAuth },
      body: JSON.stringify({ results: [] }),
    });
    assert.equal(empty.status, 400);

    const duplicates = await fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceAuth },
      body: JSON.stringify({
        results: [
          { recipient: "+1555000111", ok: true },
          { recipient: "+1555000111", ok: true },
        ],
      }),
    });
    assert.equal(duplicates.status, 400);

    // Dead-letter the item, then prove a late receipt cannot resurrect it.
    await fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceAuth },
      body: JSON.stringify({ results: [{ recipient: "+1555000111", ok: false, error: "RADIO_OFF" }] }),
    });
    const late = await fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceAuth },
      body: JSON.stringify({ results: [{ recipient: "+1555000111", ok: true }] }),
    });
    assert.equal(late.status, 409);
    const [row] = await db.select().from(casOutbox).where(eq(casOutbox.id, `${id}-sms`));
    assert.equal(row.state, "DEAD_LETTER");
  });

  // In gateway mode a device receipt must never mark an alert sent.
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
  const { id } = (await trigger.json()) as { id: string };
  const gatewayReceipt = await fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...deviceAuth },
    body: JSON.stringify({ results: [{ recipient: "+1555000111", ok: true }] }),
  });
  assert.equal(gatewayReceipt.status, 409);
});

test("the device-direct recovery loop: failed receipt, re-queue, handset pickup, delivered", async () => {
  await withSmsDeliveryMode("device", async () => {
    const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
    const { id } = (await trigger.json()) as { id: string };

    // 1. Misconfigured responder: the handset reports a permanent failure and
    //    the item dead-letters.
    const failed = await fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceAuth },
      body: JSON.stringify({ results: [{ recipient: "not-a-number", ok: false, error: "ILLEGAL_DESTINATION" }] }),
    });
    assert.equal(failed.status, 200);
    assert.deepEqual(await failed.json(), { id, state: "DEAD_LETTER" });
    const [dead] = await db.select().from(casOutbox).where(eq(casOutbox.id, `${id}-sms`));
    assert.equal(dead.state, "DEAD_LETTER");

    // 2. Operator fixes the handset's responder list and re-queues from the
    //    console; the item becomes visible to the handset again.
    const requeue = await fetch(`${baseUrl}/cas/outbox/${id}-sms/requeue`, {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Corrected the responder number on the handset." }),
    });
    assert.equal(requeue.status, 200);
    const pending = await (await fetch(`${baseUrl}/cas/outbox/device-pending`, { headers: deviceAuth })).json() as {
      items: Array<{ id: string; cycleToken: string | null }>;
    };
    assert.deepEqual(pending.items.map((item) => item.id), [`${id}-sms`]);
    // The re-queue minted a fresh delivery-cycle token; the handset persists
    // it with the replacement batch and echoes it in the receipt.
    const cycleToken = pending.items[0].cycleToken;
    assert.ok(cycleToken);

    // 3. The handset re-sends and reports success; the worker still never
    //    touches SMS items.
    const ok = await fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deviceAuth },
      body: JSON.stringify({ cycleToken, results: [{ recipient: "+1555000111", ok: true }] }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { id, state: "SENT" });

    const sent: string[] = [];
    await processCasOutbox({
      workerId: "device-loop-worker",
      maxItems: 10,
      send: async (item) => {
        sent.push(item.transport);
        throw new Error("no XMPP provider configured in test");
      },
    });
    assert.ok(!sent.includes("SMS"));

    const [row] = await db.select().from(casOutbox).where(eq(casOutbox.id, `${id}-sms`));
    assert.equal(row.state, "SENT");
    const events = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, id));
    const types = events.map((event) => event.type);
    assert.ok(types.includes("DELIVERY_ABANDONED"));
    assert.ok(types.includes("DELIVERY_REQUEUED"));
    assert.ok(types.includes("DELIVERY_REPORTED"));
  });
});

test("a stale receipt from before a re-queue cannot mark the re-queued item SENT", async () => {
  await withSmsDeliveryMode("device", async () => {
    const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
    const { id } = (await trigger.json()) as { id: string };
    const postReceipt = (body: Record<string, unknown>) =>
      fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deviceAuth },
        body: JSON.stringify(body),
      });
    const smsRow = async () =>
      (await db.select().from(casOutbox).where(eq(casOutbox.id, `${id}-sms`)))[0];
    const pendingToken = async () => {
      const pending = await (await fetch(`${baseUrl}/cas/outbox/device-pending`, { headers: deviceAuth })).json() as {
        items: Array<{ id: string; cycleToken: string | null }>;
      };
      return pending.items.find((item) => item.id === `${id}-sms`)?.cycleToken;
    };

    // 1. The handset's first batch fails on the radio; the console accepts
    //    the failure receipt and dead-letters the item, but the 200 is lost
    //    to a data outage, so the handset keeps its persisted receipt and
    //    will retry it. The initial cycle has no token (a locally triggered
    //    first send never sees the device-pending list), and legacy APK
    //    receipts without one are still accepted here.
    const failed = await postReceipt({
      results: [{ recipient: "not-a-number", ok: false, error: "ILLEGAL_DESTINATION" }],
    });
    assert.equal(failed.status, 200);
    assert.equal((await smsRow()).state, "DEAD_LETTER");
    assert.equal((await smsRow()).deviceCycleToken, null);
    assert.equal(await pendingToken(), undefined);

    // 2. The operator fixes the responder list and re-queues: a fresh
    //    delivery-cycle token is minted and handed to the handset via the
    //    device-pending list.
    const requeue = await fetch(`${baseUrl}/cas/outbox/${id}-sms/requeue`, { method: "POST", headers: AUTH_HEADERS });
    assert.equal(requeue.status, 200);
    assert.equal((await smsRow()).state, "QUEUED");
    const firstToken = (await smsRow()).deviceCycleToken;
    assert.ok(firstToken);
    assert.equal(await pendingToken(), firstToken);

    // 3a. The handset's retry of the pre-re-queue receipt (no token: its
    //     batch was the token-less initial cycle) is stale: rejected
    //     410 Gone — the permanent signal the handset drops instead of
    //     retrying forever — and the item stays QUEUED for the replacement
    //     send. No clock is compared anywhere, so handset/console clock skew
    //     cannot weaken this; a batch started before the re-queue but
    //     finalized after it carries the same old (absent) token and is
    //     rejected just the same.
    const staleInitial = await postReceipt({
      results: [{ recipient: "+1555000111", ok: true }],
    });
    assert.equal(staleInitial.status, 410);
    assert.equal((await smsRow()).state, "QUEUED");
    assert.equal((await smsRow()).sentAt, null);

    // 3b. Same for a receipt echoing an OLDER token: the replacement send
    //     under the first re-queue's token dead-letters, the 200 is lost,
    //     the operator re-queues again, and the retried old-token receipt
    //     lands while the new replacement send is still pending.
    const deadAgain = await postReceipt({
      cycleToken: firstToken,
      results: [{ recipient: "not-a-number", ok: false, error: "RADIO_OFF" }],
    });
    assert.equal(deadAgain.status, 200);
    assert.equal((await smsRow()).state, "DEAD_LETTER");
    const requeueAgain = await fetch(`${baseUrl}/cas/outbox/${id}-sms/requeue`, { method: "POST", headers: AUTH_HEADERS });
    assert.equal(requeueAgain.status, 200);
    const secondToken = (await smsRow()).deviceCycleToken;
    assert.ok(secondToken && secondToken !== firstToken);
    assert.equal(await pendingToken(), secondToken);

    const staleOldToken = await postReceipt({
      cycleToken: firstToken,
      results: [{ recipient: "+1555000111", ok: true }],
    });
    assert.equal(staleOldToken.status, 410);
    assert.equal((await smsRow()).state, "QUEUED");

    // A token that was never minted for this item is rejected identically.
    const bogus = await postReceipt({
      cycleToken: "forged-token",
      results: [{ recipient: "+1555000111", ok: true }],
    });
    assert.equal(bogus.status, 410);

    // No stale receipt may have journaled a delivery or an abandonment.
    const eventsSoFar = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, id));
    assert.equal(eventsSoFar.filter((event) => event.type === "DELIVERY_REPORTED").length, 0);
    assert.equal(eventsSoFar.filter((event) => event.type === "DELIVERY_ABANDONED").length, 2);

    // 4. The replacement send's receipt echoes the current token and is
    //    accepted; its retry after the item turned SENT stays a safe
    //    200 replay.
    const fresh = await postReceipt({
      cycleToken: secondToken,
      results: [{ recipient: "+1555000111", ok: true }],
    });
    assert.equal(fresh.status, 200);
    assert.deepEqual(await fresh.json(), { id, state: "SENT" });
    assert.equal((await smsRow()).state, "SENT");
    const replay = await postReceipt({
      cycleToken: secondToken,
      results: [{ recipient: "+1555000111", ok: true }],
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { id, state: "SENT", replay: true });
  });
});

// ---- Multi-channel outbox: WhatsApp device channel + EMAIL gateway ----

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key] as string;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key] as string;
    }
  }
}

test("trigger queues only channels that can deliver: no doomed rows for unconfigured providers", async () => {
  // Device mode with SMS+WHATSAPP on the handset and no XMPP configured
  // (suite placeholder unset): exactly the two deliverable rows, no XMPP row
  // that could only ever dead-letter.
  await withEnv(
    {
      CAS_SMS_DELIVERY_MODE: "device",
      CAS_DEVICE_CHANNELS: "SMS,WHATSAPP",
      CAS_DEVICE_TOKEN: DEVICE_TOKEN,
      CAS_XMPP_PROVIDER_URL: undefined,
      CAS_XMPP_RECIPIENTS: undefined,
    },
    async () => {
      const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
      assert.equal(trigger.status, 201);
      const { id } = (await trigger.json()) as { id: string };

      const outbox = await db.select().from(casOutbox).where(eq(casOutbox.incidentId, id));
      assert.deepEqual(outbox.map((item) => item.transport).sort(), ["SMS", "WHATSAPP"]);

      const queuedEvent = (await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, id)))
        .find((event) => event.type === "P1_QUEUED");
      assert.match(queuedEvent?.detail ?? "", /SMS, WHATSAPP/);
    },
  );
});

test("trigger queues XMPP and EMAIL items when their providers are configured", async () => {
  // The suite-wide XMPP placeholder config is active; this test adds EMAIL.
  await withEnv(
    {
      CAS_EMAIL_PROVIDER_URL: "http://127.0.0.1:9/cas-test-email",
      CAS_EMAIL_RECIPIENTS: "lead@example.org",
    },
    async () => {
      const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
      assert.equal(trigger.status, 201);
      const { id } = (await trigger.json()) as { id: string };

      const outbox = await db.select().from(casOutbox).where(eq(casOutbox.incidentId, id));
      assert.deepEqual(outbox.map((item) => item.transport).sort(), ["EMAIL", "SMS", "XMPP"]);
    },
  );
});

test("whatsapp device channel: pending lists it, worker never claims it, receipt drives it", async () => {
  await withEnv(
    { CAS_SMS_DELIVERY_MODE: "device", CAS_DEVICE_CHANNELS: "SMS,WHATSAPP" , CAS_DEVICE_TOKEN: DEVICE_TOKEN },
    async () => {
      const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
      assert.equal(trigger.status, 201);
      const { id } = (await trigger.json()) as { id: string };

      // device-pending lists both device channels with their transport.
      const pending = await (await fetch(`${baseUrl}/cas/outbox/device-pending`, { headers: deviceAuth })).json() as {
        items: Array<{ id: string; incidentId: string; transport: string }>;
      };
      assert.deepEqual(
        pending.items.filter((item) => item.incidentId === id).map((item) => item.transport).sort(),
        ["SMS", "WHATSAPP"],
      );

      // The worker claims neither device channel; only the gateway-delivered
      // XMPP item is claimed (send throws so nothing is delivered).
      const sent: string[] = [];
      await processCasOutbox({
        workerId: "whatsapp-worker",
        maxItems: 10,
        send: async (item) => {
          sent.push(item.transport);
          throw new Error("no provider in test");
        },
      });
      assert.deepEqual(sent, ["XMPP"]);
      const rows = await db.select().from(casOutbox).where(eq(casOutbox.incidentId, id));
      const whatsapp = rows.find((row) => row.transport === "WHATSAPP");
      assert.ok(whatsapp);
      assert.equal(whatsapp.state, "QUEUED");
      assert.equal(whatsapp.attempts, 0);

      // A WhatsApp failure receipt dead-letters with the responder masked.
      const badReceipt = await fetch(`${baseUrl}/cas/incidents/${id}/device-receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deviceAuth },
        body: JSON.stringify({
          channel: "WHATSAPP",
          results: [{ recipient: "+1555000222", ok: false, error: "WHATSAPP_NOT_INSTALLED" }],
        }),
      });
      assert.equal(badReceipt.status, 200);
      assert.deepEqual(await badReceipt.json(), { id, state: "DEAD_LETTER" });
      const deadRow = (await db.select().from(casOutbox)
        .where(sql`${casOutbox.incidentId} = ${id} AND ${casOutbox.transport} = 'WHATSAPP'`))[0];
      assert.match(deadRow.lastError ?? "", /WHATSAPP_NOT_INSTALLED/);
      assert.match(deadRow.lastError ?? "", /•••22/);
      assert.ok(!deadRow.lastError?.includes("+1555000222"));

      // Re-queue puts it back on the handset's pickup list.
      const requeue = await fetch(`${baseUrl}/cas/outbox/${id}-whatsapp/requeue`, {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(requeue.status, 200);
      const pendingAgain = await (await fetch(`${baseUrl}/cas/outbox/device-pending`, { headers: deviceAuth })).json() as {
        items: Array<{ id: string; transport: string; cycleToken: string | null }>;
      };
      const whatsappItem = pendingAgain.items.find((item) => item.id === `${id}-whatsapp`);
      assert.equal(whatsappItem?.transport, "WHATSAPP");
      // The re-queue minted a fresh delivery-cycle token; the handset echoes
      // it in the replacement send's receipt.
      const cycleToken = whatsappItem?.cycleToken;
      assert.ok(cycleToken);

      // A successful receipt marks it SENT; a replay is a cheap no-op.
      const okReceipt = await fetch(`${baseUrl}/cas/incidents/${id}/device-receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deviceAuth },
        body: JSON.stringify({ channel: "WHATSAPP", cycleToken, results: [{ recipient: "+1555000222", ok: true }] }),
      });
      assert.equal(okReceipt.status, 200);
      assert.deepEqual(await okReceipt.json(), { id, state: "SENT" });
      const replay = await fetch(`${baseUrl}/cas/incidents/${id}/device-receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deviceAuth },
        body: JSON.stringify({ channel: "WHATSAPP", cycleToken, results: [{ recipient: "+1555000222", ok: true }] }),
      });
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), { id, state: "SENT", replay: true });

      const events = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, id));
      const types = events.map((event) => event.type);
      assert.ok(types.includes("DELIVERY_ABANDONED"));
      assert.ok(types.includes("DELIVERY_REQUEUED"));
      assert.ok(types.includes("DELIVERY_REPORTED"));
      const reported = events.find((event) => event.type === "DELIVERY_REPORTED");
      assert.match(reported?.detail ?? "", /handed the WhatsApp alert/);
    },
  );
});

test("device receipt for a channel the console did not queue is refused", async () => {
  await withEnv(
    { CAS_SMS_DELIVERY_MODE: "device", CAS_DEVICE_CHANNELS: "SMS" , CAS_DEVICE_TOKEN: DEVICE_TOKEN },
    async () => {
      const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
      assert.equal(trigger.status, 201);
      const { id } = (await trigger.json()) as { id: string };

      const response = await fetch(`${baseUrl}/cas/incidents/${id}/device-receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deviceAuth },
        body: JSON.stringify({ channel: "WHATSAPP", results: [{ recipient: "+1555000222", ok: true }] }),
      });
      assert.equal(response.status, 409);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /not an enabled device channel/);

      // The legacy sms-receipt alias still forces the SMS channel even if the
      // body names a different one, so old APKs cannot cross channels.
      const alias = await fetch(`${baseUrl}/cas/incidents/${id}/sms-receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...deviceAuth },
        body: JSON.stringify({ channel: "WHATSAPP", results: [{ recipient: "+1555000111", ok: true }] }),
      });
      assert.equal(alias.status, 200);
      assert.deepEqual(await alias.json(), { id, state: "SENT" });
      const smsRow = (await db.select().from(casOutbox)
        .where(sql`${casOutbox.incidentId} = ${id} AND ${casOutbox.transport} = 'SMS'`))[0];
      assert.equal(smsRow.state, "SENT");
    },
  );
});

test("EMAIL adapter submits subject and body through its provider with outbox-ID idempotency keys", async () => {
  const provider = await startStubProvider(() => 200);
  try {
    const email = createEmailProvider({
      url: provider.url,
      token: "email-token",
      from: "cas@example.org",
      recipients: ["lead@example.org", "backup@example.org"],
    });
    await email.send(
      { incidentId: "inc-email-1", transport: "EMAIL", priority: "P1", body: "CAS P1 alert body" },
      "inc-email-1-email",
    );
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[0].authorization, "Bearer email-token");
    assert.equal(provider.requests[0].idempotencyKey, "inc-email-1-email:lead@example.org");
    assert.equal(provider.requests[0].payload.to, "lead@example.org");
    assert.equal(provider.requests[0].payload.from, "cas@example.org");
    assert.equal(provider.requests[0].payload.subject, "CAS P1 alert inc-email-1");
    assert.equal(provider.requests[0].payload.body, "CAS P1 alert body");
  } finally {
    await provider.close();
  }
});

// ---- Handset endpoint authentication (CAS_DEVICE_TOKEN) ----

test("handset endpoints require the device token and stay closed when none is configured", async () => {
  await withSmsDeliveryMode("device", async () => {
    const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
    assert.equal(trigger.status, 201);
    const { id } = (await trigger.json()) as { id: string };

    // Enumeration is closed without a token, and with a wrong one.
    const noHeader = await fetch(`${baseUrl}/cas/outbox/device-pending`);
    assert.equal(noHeader.status, 401);
    const wrongToken = await fetch(`${baseUrl}/cas/outbox/device-pending`, {
      headers: { "X-CAS-Device-Token": "not-the-token" },
    });
    assert.equal(wrongToken.status, 401);

    // State mutation is closed too: a forged all-success receipt must not
    // mark an unsent alert SENT.
    const forged = await fetch(`${baseUrl}/cas/incidents/${id}/device-receipt`, {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ results: [{ recipient: "+1555000111", ok: true }] }),
    });
    assert.equal(forged.status, 401);
    const [row] = await db.select().from(casOutbox).where(eq(casOutbox.id, `${id}-sms`));
    assert.equal(row.state, "QUEUED");

    // The real handset's token works.
    const authed = await fetch(`${baseUrl}/cas/outbox/device-pending`, { headers: deviceAuth });
    assert.equal(authed.status, 200);
  });

  // Fail closed: device mode without CAS_DEVICE_TOKEN configured refuses
  // every handset call rather than running unauthenticated.
  await withEnv({ CAS_SMS_DELIVERY_MODE: "device", CAS_DEVICE_TOKEN: undefined }, async () => {
    const closed = await fetch(`${baseUrl}/cas/outbox/device-pending`, { headers: deviceAuth });
    assert.equal(closed.status, 503);
  });
});

// ---- Trigger queues only channels that can deliver ----

test("trigger queues only the handset's requested device channels plus configured providers", async () => {
  await withEnv(
    {
      CAS_SMS_DELIVERY_MODE: "device",
      CAS_DEVICE_CHANNELS: "SMS,WHATSAPP",
      CAS_DEVICE_TOKEN: DEVICE_TOKEN,
    },
    async () => {
      // Handset with the WhatsApp checkbox off asks for SMS only; the
      // console must not queue a WHATSAPP row nobody will report against.
      const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ deviceChannels: ["SMS"] }),
      });
      assert.equal(trigger.status, 201);
      const { id } = (await trigger.json()) as { id: string };
      const rows = await db.select().from(casOutbox).where(eq(casOutbox.incidentId, id));
      assert.deepEqual(rows.map((row) => row.transport).sort(), ["SMS", "XMPP"]);

      // Requesting enabled channels again folds into the active incident.
      const folded = await fetch(`${baseUrl}/cas/incidents/trigger`, {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ deviceChannels: ["SMS", "WHATSAPP"] }),
      });
      assert.equal(folded.status, 200);
      assert.equal(((await folded.json()) as { reused: boolean }).reused, true);
    },
  );

  await withEnv(
    {
      CAS_SMS_DELIVERY_MODE: "device",
      CAS_DEVICE_CHANNELS: "SMS",
      CAS_DEVICE_TOKEN: DEVICE_TOKEN,
    },
    async () => {
      // A valid channel the console has not enabled is a loud 409.
      const conflict = await fetch(`${baseUrl}/cas/incidents/trigger`, {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ deviceChannels: ["WHATSAPP"] }),
      });
      assert.equal(conflict.status, 409);

      // Unknown channel names are rejected outright.
      const bad = await fetch(`${baseUrl}/cas/incidents/trigger`, {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ deviceChannels: ["PIGEON"] }),
      });
      assert.equal(bad.status, 400);
    },
  );
});

test("gateway mode without an SMS provider queues no undeliverable SMS row", async () => {
  await withEnv(
    {
      CAS_SMS_DELIVERY_MODE: "gateway",
      CAS_SMS_PROVIDER_URL: undefined,
      CAS_SMS_RECIPIENTS: undefined,
    },
    async () => {
      const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST", headers: AUTH_HEADERS });
      assert.equal(trigger.status, 201);
      const { id } = (await trigger.json()) as { id: string };
      const rows = await db.select().from(casOutbox).where(eq(casOutbox.incidentId, id));
      assert.deepEqual(rows.map((row) => row.transport), ["XMPP"]);
    },
  );
});

test("unauthenticated trigger and mutation requests are rejected with 401 and recorded", async () => {
  const rejections: CasAuthRejection[] = [];
  setCasAuthRejectionRecorder((rejection) => rejections.push(rejection));
  try {
    const attempts = [
      () => fetch(`${baseUrl}/cas/incidents/trigger`, { method: "POST" }),
      () => fetch(`${baseUrl}/cas/incidents/some-incident/ack`, { method: "POST" }),
      () => fetch(`${baseUrl}/cas/incidents/some-incident/resolve`, { method: "POST" }),
      () => fetch(`${baseUrl}/cas/outbox/some-item/requeue`, { method: "POST" }),
    ];
    for (const attempt of attempts) {
      const response = await attempt();
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="cas"');
      const body = (await response.json()) as { error?: string };
      assert.ok(body.error);
    }

    // A wrong credential is rejected exactly like a missing one.
    const wrongToken = await fetch(`${baseUrl}/cas/incidents/trigger`, {
      method: "POST",
      headers: { authorization: "Bearer not-the-alert-token" },
    });
    assert.equal(wrongToken.status, 401);

    // Nothing reached the durable journal.
    assert.equal((await db.select({ id: casIncidents.id }).from(casIncidents)).length, 0);
    assert.equal((await db.select({ id: casOutbox.id }).from(casOutbox)).length, 0);

    // Every rejection was recorded with its route and reason — and without
    // the presented credential.
    assert.equal(rejections.length, 5);
    assert.deepEqual(
      rejections.map(({ method, path, reason }) => ({ method, path, reason })),
      [
        { method: "POST", path: "/api/cas/incidents/trigger", reason: "missing-token" },
        { method: "POST", path: "/api/cas/incidents/some-incident/ack", reason: "missing-token" },
        { method: "POST", path: "/api/cas/incidents/some-incident/resolve", reason: "missing-token" },
        { method: "POST", path: "/api/cas/outbox/some-item/requeue", reason: "missing-token" },
        { method: "POST", path: "/api/cas/incidents/trigger", reason: "invalid-token" },
      ],
    );
    assert.ok(!JSON.stringify(rejections).includes("not-the-alert-token"));
  } finally {
    setCasAuthRejectionRecorder();
  }
});

test("unauthenticated console write endpoints (bootstrap, test incident, setup/gate edits, import) are rejected with 401 and recorded", async () => {
  const rejections: CasAuthRejection[] = [];
  setCasAuthRejectionRecorder((rejection) => rejections.push(rejection));
  try {
    const jsonHeaders = { "Content-Type": "application/json" };
    const attempts: { make: () => Promise<Response>; method: string; path: string }[] = [
      {
        make: () => fetch(`${baseUrl}/cas/bootstrap`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ gates: [], setup: [] }) }),
        method: "POST", path: "/api/cas/bootstrap",
      },
      {
        make: () => fetch(`${baseUrl}/cas/incidents/test`, { method: "POST" }),
        method: "POST", path: "/api/cas/incidents/test",
      },
      {
        make: () => fetch(`${baseUrl}/cas/setup/sim-entry`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ status: "verified" }) }),
        method: "PATCH", path: "/api/cas/setup/sim-entry",
      },
      {
        make: () => fetch(`${baseUrl}/cas/gates/proxy-launch`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ status: "verified" }) }),
        method: "PATCH", path: "/api/cas/gates/proxy-launch",
      },
      {
        make: () => fetch(`${baseUrl}/cas/gate0a/import`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({}) }),
        method: "POST", path: "/api/cas/gate0a/import",
      },
    ];

    const setupCountBefore = (await db.select({ id: casSetupReadiness.id }).from(casSetupReadiness)).length;
    const gatesCountBefore = (await db.select({ id: casGateEvidence.id }).from(casGateEvidence)).length;

    for (const attempt of attempts) {
      const response = await attempt.make();
      assert.equal(response.status, 401, `${attempt.method} ${attempt.path}`);
      assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="cas"');
      const body = (await response.json()) as { error?: string };
      assert.ok(body.error);
    }

    // A wrong credential is rejected exactly like a missing one.
    const wrongToken = await fetch(`${baseUrl}/cas/incidents/test`, {
      method: "POST",
      headers: { authorization: "Bearer not-the-alert-token" },
    });
    assert.equal(wrongToken.status, 401);

    // Nothing reached durable state: no test incident, no readiness writes.
    assert.equal((await db.select({ id: casIncidents.id }).from(casIncidents)).length, 0);
    assert.equal((await db.select({ id: casSetupReadiness.id }).from(casSetupReadiness)).length, setupCountBefore);
    assert.equal((await db.select({ id: casGateEvidence.id }).from(casGateEvidence)).length, gatesCountBefore);

    // Every rejection was recorded with its route and reason — and without
    // the presented credential.
    assert.equal(rejections.length, 6);
    assert.deepEqual(
      rejections.map(({ method, path, reason }) => ({ method, path, reason })),
      [
        { method: "POST", path: "/api/cas/bootstrap", reason: "missing-token" },
        { method: "POST", path: "/api/cas/incidents/test", reason: "missing-token" },
        { method: "PATCH", path: "/api/cas/setup/sim-entry", reason: "missing-token" },
        { method: "PATCH", path: "/api/cas/gates/proxy-launch", reason: "missing-token" },
        { method: "POST", path: "/api/cas/gate0a/import", reason: "missing-token" },
        { method: "POST", path: "/api/cas/incidents/test", reason: "invalid-token" },
      ],
    );
    assert.ok(!JSON.stringify(rejections).includes("not-the-alert-token"));
  } finally {
    setCasAuthRejectionRecorder();
  }
});

test("the enrolled-device credential authorizes the console write endpoints", async () => {
  // Every newly guarded endpoint lets the credentialed console through the
  // gate; downstream validation (404 for unknown rows, 400 for malformed
  // reports) still applies as before.
  const testIncident = await fetch(`${baseUrl}/cas/incidents/test`, { method: "POST", headers: AUTH_HEADERS });
  assert.notEqual(testIncident.status, 401);

  const gateEdit = await fetch(`${baseUrl}/cas/gates/no-such-gate`, {
    method: "PATCH",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "verified" }),
  });
  assert.equal(gateEdit.status, 404);

  const setupEdit = await fetch(`${baseUrl}/cas/setup/no-such-entry`, {
    method: "PATCH",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "verified" }),
  });
  assert.notEqual(setupEdit.status, 401);

  const bootstrap = await fetch(`${baseUrl}/cas/bootstrap`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ gates: [], setup: [] }),
  });
  assert.notEqual(bootstrap.status, 401);

  const importReport = await fetch(`${baseUrl}/cas/gate0a/import`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ not: "a report" }),
  });
  assert.equal(importReport.status, 400);
});

test("bootstrap seeds both readiness tables from the console's { gates, setup } payload", async () => {
  // The exact shapes the console posts from use-field-test (initialGates /
  // initialSetup) when it finds both tables empty.
  const setup = [
    { id: "cover-app", label: "Cover app selected", detail: "Choose the benign app that will host the entry path on the managed Pixel.", group: "Device surface", complete: true, mode: "owner" },
    { id: "sim", label: "Test SIM present", detail: "Confirm the Pixel has the intended SIM, service, and enough balance for SMS tests.", group: "Connectivity", complete: false, mode: "owner" },
  ];
  const gates = [
    { id: "proxy-launch", index: "01", name: "Proxy Launch", short: "Cover app → alert surface", status: "partial", criterion: "A hardware shortcut or approved entry path must reach the alert surface on the stock Pixel without an observable dead end.", evidence: ["Pixel 11 is the approved physical target; no physical launch has been recorded yet."], nextAction: "Exercise the chosen shortcut three times while the device is locked.", owner: "Operator" },
  ];

  const first = await fetch(`${baseUrl}/cas/bootstrap`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ gates, setup }),
  });
  assert.equal(first.status, 201);
  assert.deepEqual((await first.json()) as { seeded: boolean }, { seeded: true });

  const setupRows = await db.select().from(casSetupReadiness).orderBy(asc(casSetupReadiness.id));
  assert.deepEqual(
    setupRows.map(({ id, label, group, complete, mode }) => ({ id, label, group, complete, mode })),
    [
      { id: "cover-app", label: "Cover app selected", group: "Device surface", complete: true, mode: "owner" },
      { id: "sim", label: "Test SIM present", group: "Connectivity", complete: false, mode: "owner" },
    ],
  );
  const gateRows = await db.select().from(casGateEvidence);
  assert.equal(gateRows.length, 1);
  assert.equal(gateRows[0].id, "proxy-launch");
  assert.equal(gateRows[0].status, "partial");
  assert.deepEqual(gateRows[0].evidence, ["Pixel 11 is the approved physical target; no physical launch has been recorded yet."]);

  // A second bootstrap must not overwrite or duplicate the seeded catalog.
  const repeat = await fetch(`${baseUrl}/cas/bootstrap`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ gates: [], setup: [{ ...setup[0], complete: false }] }),
  });
  assert.equal(repeat.status, 201);
  assert.deepEqual((await repeat.json()) as { seeded: boolean }, { seeded: false });
  const afterRepeat = await db.select().from(casSetupReadiness).where(eq(casSetupReadiness.id, "cover-app"));
  assert.equal(afterRepeat[0].complete, true);
  assert.equal((await db.select({ id: casSetupReadiness.id }).from(casSetupReadiness)).length, 2);

  // A malformed payload is a 400, never a half-applied seed.
  const malformed = await fetch(`${baseUrl}/cas/bootstrap`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "verified" }),
  });
  assert.equal(malformed.status, 400);
});

test("PATCH /cas/setup/:id toggles cas_setup_readiness.complete from the console's { complete } payload", async () => {
  const before = await db.select().from(casSetupReadiness).where(eq(casSetupReadiness.id, "sim"));
  assert.equal(before[0].complete, false);
  const gateStatusesBefore = (await db.select({ id: casGateEvidence.id, status: casGateEvidence.status }).from(casGateEvidence))
    .map((row) => `${row.id}:${row.status}`)
    .sort();

  const response = await fetch(`${baseUrl}/cas/setup/sim`, {
    method: "PATCH",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ complete: true }),
  });
  assert.equal(response.status, 200);
  const row = (await response.json()) as { id: string; label?: string; complete: boolean };
  assert.equal(row.id, "sim");
  // The response is a setup-readiness row (label/group), not gate evidence.
  assert.equal(row.label, "Test SIM present");

  const after = await db.select().from(casSetupReadiness).where(eq(casSetupReadiness.id, "sim"));
  assert.equal(after[0].complete, true);

  // Gate evidence is a different table and must be untouched by a setup toggle.
  const gateStatusesAfter = (await db.select({ id: casGateEvidence.id, status: casGateEvidence.status }).from(casGateEvidence))
    .map((gateRow) => `${gateRow.id}:${gateRow.status}`)
    .sort();
  assert.deepEqual(gateStatusesAfter, gateStatusesBefore);

  const unknown = await fetch(`${baseUrl}/cas/setup/no-such-entry`, {
    method: "PATCH",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ complete: false }),
  });
  assert.equal(unknown.status, 404);

  const wrongShape = await fetch(`${baseUrl}/cas/setup/sim`, {
    method: "PATCH",
    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "verified" }),
  });
  assert.equal(wrongShape.status, 400);
});

test("POST /cas/incidents/test mints its own id and journals the local test record", async () => {
  const response = await fetch(`${baseUrl}/cas/incidents/test`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(response.status, 201);
  const { id } = (await response.json()) as { id: string };
  assert.ok(id.length > 0);

  const incidents = await db.select().from(casIncidents).where(eq(casIncidents.id, id));
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].status, "RESOLVED");
  assert.equal(incidents[0].priority, "P3");
  const events = await db.select().from(casIncidentEvents).where(eq(casIncidentEvents.incidentId, id));
  assert.deepEqual(events.map((event) => event.type), ["TEST_RECORDED"]);

  // A second test incident gets a distinct server-minted id.
  const again = await fetch(`${baseUrl}/cas/incidents/test`, { method: "POST", headers: AUTH_HEADERS });
  assert.equal(again.status, 201);
  const second = (await again.json()) as { id: string };
  assert.notEqual(second.id, id);
});

test("the enrolled-device credential authorizes trigger, ack, and resolve", async () => {
  const trigger = await fetch(`${baseUrl}/cas/incidents/trigger`, {
    method: "POST",
    headers: AUTH_HEADERS,
  });
  assert.equal(trigger.status, 201);
  const { id } = (await trigger.json()) as { id: string };

  const ack = await fetch(`${baseUrl}/cas/incidents/${id}/ack`, {
    method: "POST",
    headers: AUTH_HEADERS,
  });
  assert.equal(ack.status, 200);

  const resolve = await fetch(`${baseUrl}/cas/incidents/${id}/resolve`, {
    method: "POST",
    headers: AUTH_HEADERS,
  });
  assert.equal(resolve.status, 200);
});
