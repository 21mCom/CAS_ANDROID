import { z } from "zod";

/**
 * Gate 0A report validation, shared between the import route
 * (POST /api/cas/gate0a/import) and the CI validator script
 * (artifacts/api-server/scripts/validate-gate0a-report.ts).
 *
 * The harness (measure-gate0a.sh) and this schema must drift together: CI runs
 * the harness self-test report through validateGate0aImport so a report the
 * web app would reject fails before field use.
 */

const gate0aEventTypes = [
  "BACK_OBSERVED",
  "COVER_CONFIGURED",
  "COVER_LAUNCH_OUTCOME",
  "HARNESS_CHECK",
  "LAUNCH_SAMPLE",
  "NAVIGATION_OBSERVATION",
  "OBSERVER_SCREEN_OPENED",
  "PROCESS_INTERRUPTION",
  "PROXY_TRIGGER",
  "REPORT_COPIED",
  "REBOOT_RECOVERY",
  "REPEAT_BOUNDARY",
  "SHORTCUT_OUTCOME",
] as const;

const gate0aEventSchema = z.object({
  type: z.enum(gate0aEventTypes),
  wallClockMs: z.number().int().nonnegative().safe(),
  elapsedRealtimeMs: z.number().int().nonnegative().safe(),
  recordedAtUtc: z.string().datetime({ offset: true }).optional(),
  status: z.enum(["pass", "fail", "inconclusive", "blocked"]).optional(),
  message: z.string().max(1024).optional(),
  outcome: z.string().max(64).optional(),
  reason: z.string().max(512).optional(),
  coverPackage: z.string().max(255).optional(),
}).passthrough();

const gate0aPreflightCheckSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(255),
  status: z.enum(["PASS", "WARN", "BLOCKED", "SKIPPED"]),
  required: z.boolean(),
  observed: z.string().max(1024),
  expected: z.string().max(1024),
  nextSteps: z.array(z.string().max(512)).max(20),
}).strict();

export const gate0aReportSchema = z.object({
  schema: z.literal("cas-gate0a-report-v2"),
  reportType: z.literal("gate0a-run"),
  runPurpose: z.literal("Disposable proxy-launch hardware measurement only"),
  evidenceClass: z.enum(["physical-device-observation", "simulated-emulator", "sample"]),
  status: z.enum(["blocked", "complete", "complete-with-failures", "complete-with-inconclusive"]),
  startedAtUtc: z.string().datetime({ offset: true }),
  finishedAtUtc: z.string().datetime({ offset: true }),
  startedAtMs: z.number().int().nonnegative().safe().optional(),
  finishedAtMs: z.number().int().nonnegative().safe().optional(),
  gate0aPassed: z.literal(false),
  physicalReadinessProof: z.enum(["requires-managed-Pixel-observer-review", "simulated-emulator-not-proof", "sample-not-proof"]),
  target: z.object({
    model: z.string().min(1).max(128),
    serial: z.string().min(1).max(255),
    device: z.string().min(1).max(255),
    androidVersion: z.string().min(1).max(128),
    build: z.string().min(1).max(255),
    androidApi: z.number().int().min(35).max(100),
    stockAndroid: z.literal(true),
    isEmulator: z.boolean(),
    usbState: z.enum(["device", "not-observed"]),
    usbDebuggingEnabled: z.boolean(),
  }).strict(),
  preflight: z.object({
    status: z.enum(["PASS", "WARN", "BLOCKED"]),
    checks: z.array(gate0aPreflightCheckSchema).min(1).max(100),
    unresolvedWarnings: z.array(z.string().max(1024)).max(100),
  }).strict(),
  safety: z.object({
    liveMessagingEnabled: z.literal(false),
    networkEnabled: z.literal(false),
    evidenceCaptureEnabled: z.literal(false),
    covertProductionBehaviorEnabled: z.literal(false),
    deviceOwnerPolicyChanged: z.literal(false),
    applicationDataCleared: z.literal(false),
    factoryResetPerformed: z.literal(false),
  }).strict(),
  coverPackage: z.string().min(1).max(255),
  deviceOwner: z.object({
    isCasDeviceOwner: z.boolean(),
    adminReceiverRegistered: z.boolean(),
    reportedOnly: z.literal(true),
  }).strict(),
  permissions: z.object({
    "android.permission.SEND_SMS": z.boolean(),
    "android.permission.ACCESS_FINE_LOCATION": z.boolean(),
    "android.permission.RECORD_AUDIO": z.boolean(),
    "android.permission.CAMERA": z.boolean(),
    "android.permission.INTERNET": z.boolean(),
  }).strict(),
  shortcut: z.object({
    pinSupported: z.boolean(),
    pinned: z.boolean(),
    launcherControlsPinnedState: z.literal(true),
  }).strict(),
  tasks: z.array(z.object({
    taskId: z.number().int().nonnegative().safe(),
    baseActivity: z.string().max(512).nullable(),
    topActivity: z.string().max(512).nullable(),
  }).strict()).max(10_000),
  recents: z.object({
    proxyExcludedFromRecents: z.boolean(),
    observedTaskCount: z.number().int().nonnegative().safe(),
  }).strict(),
  back: z.object({
    mainActivityCallbackRecorded: z.literal(true),
    predictiveBack: z.literal("observe_on_device"),
  }).strict(),
  observer: z.object({
    settingsAppInfoReviewRequired: z.literal(true),
    quickSettingsReviewRequired: z.literal(true),
    notificationsReviewRequired: z.literal(true),
    coverAppBackHomeRecentsReviewRequired: z.literal(true),
  }).strict(),
  package: z.object({
    applicationId: z.string().min(1).max(255),
    apkPath: z.string().max(512).nullable(),
    apkSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    installedPath: z.string().max(512).nullable(),
  }).strict().optional(),
  artifacts: z.record(z.string().max(512)).optional(),
  evidence: z.object({
    // A default hardware run (200 repeats) captures one logcat file per launch,
    // so a real report references ~205 logs; the bound leaves headroom for
    // larger --repeat series while staying finite.
    logs: z.array(z.string().max(512)).max(1000),
    screenshots: z.array(z.string().max(512)).max(200),
    rawReferences: z.array(z.string().max(512)).max(500),
  }).strict(),
  warnings: z.array(z.string().max(1024)).max(100),
  runSequence: z.array(z.string().max(128)).max(100).optional(),
  repeatCount: z.number().int().nonnegative().safe().optional(),
  summary: z.object({
    eventCounts: z.record(z.number().int().nonnegative().safe()),
    eventCount: z.number().int().nonnegative().safe(),
  }).strict().optional(),
  observations: z.array(z.record(z.unknown())).max(10_000).optional(),
  notes: z.array(z.string().max(1024)).max(100).optional(),
  events: z.array(gate0aEventSchema).max(10_000),
}).strict().superRefine((report, context) => {
  const shouldBeEmulator = report.evidenceClass === "simulated-emulator";
  if (report.target.isEmulator !== shouldBeEmulator) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target", "isEmulator"],
      message: "Evidence class does not match target emulator identity",
    });
  }
  if (report.evidenceClass !== "sample" && report.preflight.status === "PASS" && report.target.usbState !== "device") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target", "usbState"],
      message: "A runnable hardware or emulator report must include authorized adb state",
    });
  }
  if (report.evidenceClass === "simulated-emulator" &&
      (report.target.model !== "Pixel 8a" || report.target.androidApi !== 35)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target"],
      message: "Emulator evidence must come from the pinned Pixel 8a/API 35 baseline",
    });
  }
  if (report.evidenceClass === "physical-device-observation" &&
      report.target.model !== "Pixel 11") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target", "model"],
      message: "Physical evidence must come from the approved Pixel 11 target",
    });
  }
});

export type Gate0aReport = z.infer<typeof gate0aReportSchema>;

export function hasUnsafeJsonContent(value: unknown, depth = 0): boolean {
  if (depth > 20 || value === null || typeof value !== "object") {
    return depth > 20;
  }
  if (Array.isArray(value)) return value.some((entry) => hasUnsafeJsonContent(entry, depth + 1));
  return Object.entries(value).some(([key, entry]) =>
    key === "__proto__" || key === "prototype" || key === "constructor" ||
    (typeof entry === "string" && /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(entry)) ||
    hasUnsafeJsonContent(entry, depth + 1));
}

export type Gate0aValidationIssue = {
  /** Dotted path to the offending report field, e.g. "target.model" ("" for the report root). */
  path: string;
  /** Human-readable validation message for that field. */
  message: string;
};
export type Gate0aValidationResult =
  | { ok: true; report: Gate0aReport }
  | { ok: false; error: string; issues?: Gate0aValidationIssue[] };

/**
 * The structured issue list carries up to this many entries so an operator
 * importing a badly truncated or schema-drifted report can see every failing
 * field, while staying bounded for a 10k-event report where every event is
 * invalid. The plain-text error summary stays short (MAX_SUMMARY_ISSUES) and
 * points at the full list for the remainder.
 */
const MAX_REPORTED_ISSUES = 50;
const MAX_SUMMARY_ISSUES = 3;
/**
 * Applies the exact accept/reject rules of POST /api/cas/gate0a/import to an
 * already-parsed JSON value. Both the route and the CI validator call this so
 * a report the web app would reject fails the same way everywhere.
 */
export function validateGate0aImport(body: unknown): Gate0aValidationResult {
  if (hasUnsafeJsonContent(body)) {
    return { ok: false, error: "Gate 0A report contains unsafe JSON content" };
  }
  const parsed = gate0aReportSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, ...describeSchemaIssues(parsed.error) };
  }
  const report = parsed.data;
  if (report.status === "blocked" || report.preflight.status === "BLOCKED") {
    return {
      ok: false,
      error: "Gate 0A report is blocked; resolve the preflight blockers and import the completed report.",
    };
  }
  return { ok: true, report };
}

/**
 * Summarizes the top zod issues into a short message a field operator can act
 * on (which field failed and why) plus a structured issue list for clients.
 * The list carries up to MAX_REPORTED_ISSUES entries so the gates panel can
 * show every failing field; the message embeds only the first
 * MAX_SUMMARY_ISSUES and counts the rest.
 */
function describeSchemaIssues(error: z.ZodError): { error: string; issues: Gate0aValidationIssue[] } {
  const issues = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
  const detail = issues
    .slice(0, MAX_SUMMARY_ISSUES)
    .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    .join("; ");
  const overflowCount = error.issues.length - Math.min(error.issues.length, MAX_SUMMARY_ISSUES);
  const overflow = error.issues.length > MAX_SUMMARY_ISSUES
    ? ` (and ${overflowCount} more issue${overflowCount === 1 ? "" : "s"})`
    : "";
  return {
    error: `Invalid cas-gate0a-report-v2 report — ${detail}${overflow}`,
    issues,
  };
}

function formatIssuePath(path: PropertyKey[]): string {
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : String(segment)))
    .join(".")
    .replace(/\.\[/g, "[");
}
