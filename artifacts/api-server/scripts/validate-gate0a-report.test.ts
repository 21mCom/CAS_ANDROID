/**
 * Regression test for the CI Gate 0A validator script: a rejection must print
 * every structured issue (path + message) under the REJECTED summary, not just
 * the first few embedded in the error text, and exit codes must stay 1 on
 * rejection / 0 on acceptance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const apiServerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const validReport = {
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
  ],
};

async function writeTempReport(report: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gate0a-validate-"));
  const file = path.join(dir, "report.json");
  await writeFile(file, JSON.stringify(report));
  return file;
}

async function runValidator(reportPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "pnpm",
      ["exec", "tsx", "scripts/validate-gate0a-report.ts", reportPath],
      { cwd: apiServerRoot },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

test("validator prints every failing field on rejection and exits 1", async () => {
  // Break five fields — more than the three the error summary embeds — so the
  // test proves the full per-field list reaches the CI log.
  const broken = {
    ...validReport,
    evidenceClass: "not-a-class",
    preflight: { ...validReport.preflight, status: "BOGUS" },
    safety: { ...validReport.safety, liveMessagingEnabled: true },
    target: { ...validReport.target, serial: "", androidApi: 12 },
  };
  const reportPath = await writeTempReport(broken);
  const { code, stderr } = await runValidator(reportPath);

  assert.equal(code, 1, "rejected report must exit 1");
  assert.match(stderr, /^REJECTED:/m);
  assert.match(stderr, /Failing fields \(5\):/);
  for (const expected of [
    "evidenceClass:",
    "target.serial:",
    "target.androidApi:",
    "preflight.status:",
    "safety.liveMessagingEnabled:",
  ]) {
    assert.ok(
      stderr.includes(`  - ${expected}`),
      `CI log must list failing field ${expected}; got:\n${stderr}`,
    );
  }
});

test("validator accepts a valid report and exits 0", async () => {
  const reportPath = await writeTempReport(validReport);
  const { code, stdout } = await runValidator(reportPath);

  assert.equal(code, 0, "accepted report must exit 0");
  assert.match(stdout, /^ACCEPTED: cas-gate0a-report-v2/m);
});
