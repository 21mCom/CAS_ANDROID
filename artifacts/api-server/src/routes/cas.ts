import { Router, type IRouter, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  casGateEvidence,
  casIncidentEvents,
  casIncidents,
  casOutbox,
  casSetupReadiness,
} from "@workspace/db/schema";
import { z } from "zod";

const router: IRouter = Router();

const gate0aEventTypes = [
  "BACK_OBSERVED",
  "COVER_CONFIGURED",
  "COVER_LAUNCH_OUTCOME",
  "OBSERVER_SCREEN_OPENED",
  "PROXY_TRIGGER",
  "REPORT_COPIED",
  "SHORTCUT_OUTCOME",
] as const;

const gate0aEventSchema = z.object({
  type: z.enum(gate0aEventTypes),
  wallClockMs: z.number().int().nonnegative().safe(),
  elapsedRealtimeMs: z.number().int().nonnegative().safe(),
  outcome: z.string().max(64).optional(),
  reason: z.string().max(512).optional(),
  coverPackage: z.string().max(255).optional(),
}).passthrough();

export const gate0aReportSchema = z.object({
  schema: z.literal("cas-gate0a-report-v1"),
  runPurpose: z.literal("Disposable proxy-launch hardware measurement only"),
  target: z.object({
    model: z.literal("Pixel 8a"),
    androidApi: z.literal(35),
    stockAndroid: z.literal(true),
  }).strict(),
  safety: z.object({
    liveMessagingEnabled: z.literal(false),
    evidenceCaptureEnabled: z.literal(false),
    covertProductionBehaviorEnabled: z.literal(false),
  }).strict(),
  coverPackage: z.string().max(255),
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
  events: z.array(gate0aEventSchema).max(10_000),
}).strict();

type Gate0aReport = z.infer<typeof gate0aReportSchema>;

function hasUnsafeJsonContent(value: unknown, depth = 0): boolean {
  if (depth > 20 || value === null || typeof value !== "object") {
    return depth > 20;
  }
  if (Array.isArray(value)) return value.some((entry) => hasUnsafeJsonContent(entry, depth + 1));
  return Object.entries(value).some(([key, entry]) =>
    key === "__proto__" || key === "prototype" || key === "constructor" ||
    (typeof entry === "string" && /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(entry)) ||
    hasUnsafeJsonContent(entry, depth + 1));
}

function formatGate0aNotes(report: Gate0aReport): string {
  const timestampLines = report.events.map((event, index) =>
    `${index + 1}. ${event.type}: wallClockMs=${event.wallClockMs}; elapsedRealtimeMs=${event.elapsedRealtimeMs}`);
  const outcomes = report.events
    .filter((event) => event.type === "COVER_LAUNCH_OUTCOME")
    .map((event) => {
      const details = [
        `outcome=${event.outcome ?? "not reported"}`,
        `wallClockMs=${event.wallClockMs}`,
        `elapsedRealtimeMs=${event.elapsedRealtimeMs}`,
        event.reason ? `reason=${event.reason}` : null,
        event.coverPackage ? `coverPackage=${event.coverPackage}` : null,
      ].filter((value): value is string => value !== null);
      return details.join("; ");
    });

  return [
    "Imported native Gate 0A report (cas-gate0a-report-v1).",
    "This import is physical evidence for review only; it is recorded INCONCLUSIVE and never establishes Pass or production readiness.",
    `Cover package reported: ${report.coverPackage || "(none)"}.`,
    `Cover-launch outcomes (raw): ${outcomes.length > 0 ? outcomes.join(" | ") : "none recorded"}.`,
    "Report event timestamps (raw device values):",
    timestampLines.length > 0 ? timestampLines.join("\n") : "none recorded",
  ].join("\n");
}

router.post("/cas/gate0a/import", async (req, res, next) => {
  try {
    if (hasUnsafeJsonContent(req.body)) {
      return res.status(400).json({ error: "Gate 0A report contains unsafe JSON content" });
    }
    const parsed = gate0aReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid cas-gate0a-report-v1 report" });
    }
    const report = parsed.data;
    const observation = {
      result: "inconclusive" as const,
      notes: formatGate0aNotes(report),
      recordedAt: new Date().toISOString(),
    };
    return res.status(200).json({
      accepted: true,
      schema: report.schema,
      observation,
      summary: {
        eventCount: report.events.length,
        coverLaunchOutcomeCount: report.events.filter((event) => event.type === "COVER_LAUNCH_OUTCOME").length,
      },
    });
  } catch (error) { return next(error); }
});

function shapeIncident(incident: typeof casIncidents.$inferSelect, events: typeof casIncidentEvents.$inferSelect[], outbox: typeof casOutbox.$inferSelect[]) {
  return {
    id: incident.id, status: incident.status, priority: incident.priority,
    triggerCount: incident.triggerCount, createdAt: incident.createdAt.toISOString(),
    events: events.map((event) => ({ id: event.id, type: event.type, priority: event.priority, time: event.createdAt.toISOString(), detail: event.detail })),
    outbox: outbox.map((item) => ({ id: item.id, transport: item.transport, state: item.state, priority: item.priority })),
  };
}

router.get("/cas/state", async (_req, res, next) => {
  try {
    const [incidents, events, outbox, setup, gates] = await Promise.all([
      db.select().from(casIncidents).orderBy(desc(casIncidents.createdAt)),
      db.select().from(casIncidentEvents).orderBy(asc(casIncidentEvents.createdAt)),
      db.select().from(casOutbox).orderBy(asc(casOutbox.createdAt)),
      db.select().from(casSetupReadiness).orderBy(asc(casSetupReadiness.id)),
      db.select().from(casGateEvidence).orderBy(asc(casGateEvidence.index)),
    ]);
    // Keep the most recent incident selected even after resolution so responders
    // can inspect the complete append-only journal after a reload.
    const active = incidents[0];
    const incidentRows = incidents.map((incident) => ({
      id: incident.id, priority: incident.priority, time: incident.createdAt.toISOString().slice(11, 19),
      title: incident.status === "RESOLVED" ? "Incident resolved" : "Kernel simulation activated",
      detail: `${incident.triggerCount} trigger${incident.triggerCount === 1 ? "" : "s"} recorded in the durable journal.`,
      state: incident.status === "RESOLVED" ? "Resolved" : "Simulated", source: "Kernel API", sample: false,
    }));
    return res.json({
      incidents: incidentRows,
      activeIncident: active ? shapeIncident(active, events.filter((event) => event.incidentId === active.id), outbox.filter((item) => item.incidentId === active.id)) : null,
      setup: setup.map(({ id, label, detail, group, complete, mode }) => ({ id, label, detail, group, complete, mode })),
      gates: gates.map(({ id, index, name, short, status, criterion, evidence, nextAction, owner }) => ({ id, index, name, short, status, criterion, evidence, nextAction, owner })),
    });
  } catch (error) { return next(error); }
});

router.post("/cas/bootstrap", async (req, res, next) => {
  try {
    const body = z.object({
      setup: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string(), group: z.string(), complete: z.boolean(), mode: z.string() })),
      gates: z.array(z.object({ id: z.string(), index: z.string(), name: z.string(), short: z.string(), status: z.string(), criterion: z.string(), evidence: z.array(z.string()), nextAction: z.string(), owner: z.string() })),
    }).parse(req.body);
    const existing = await db.select({ id: casSetupReadiness.id }).from(casSetupReadiness).limit(1);
    if (existing.length === 0) {
      await db.transaction(async (tx) => {
        await tx.insert(casSetupReadiness).values(body.setup);
        await tx.insert(casGateEvidence).values(body.gates);
      });
    }
    res.status(201).json({ seeded: existing.length === 0 });
  } catch (error) { return next(error); }
});

router.post("/cas/incidents/test", async (req, res, next) => {
  try {
    const now = new Date(); const id = `test-${now.getTime()}`;
    await db.insert(casIncidents).values({ id, priority: "P3", status: "RESOLVED", triggerCount: 1, createdAt: now, updatedAt: now });
    await db.insert(casIncidentEvents).values({ id: `${id}-recorded`, incidentId: id, type: "TEST_RECORDED", priority: "P3", detail: "Local test action completed. No message was sent and no device action was triggered.", createdAt: now });
    return res.status(201).json({ id });
  } catch (error) { return next(error); }
});

router.post("/cas/incidents/trigger", async (_req, res, next) => {
  try {
    const result = await db.transaction(async (tx) => {
      // Serialize the active-incident check with its insert/update. A regular
      // transaction does not prevent two READ COMMITTED transactions from
      // both observing no active incident before either one inserts.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('cas:active-incident', 0))`);
      const active = await tx.select().from(casIncidents)
        .where(sql`${casIncidents.status} <> 'RESOLVED'`)
        .orderBy(desc(casIncidents.createdAt))
        .limit(1);
      const now = new Date();

      if (active[0]) {
        const incident = active[0];
        await tx.update(casIncidents).set({ triggerCount: incident.triggerCount + 1, updatedAt: now }).where(eq(casIncidents.id, incident.id));
        await tx.insert(casIncidentEvents).values({ id: `${incident.id}-retrigger-${randomUUID()}`, incidentId: incident.id, type: "TRIGGER_REUSED", priority: "P1", detail: "Repeat trigger folded into the existing active incident; timers and outbox were not reset.", createdAt: now });
        return { id: incident.id, reused: true };
      }

      const id = `sim-${now.getTime()}-${randomUUID()}`;
      await tx.insert(casIncidents).values({ id, priority: "P1", status: "ACTIVE_UNACKED", createdAt: now, updatedAt: now });
      await tx.insert(casIncidentEvents).values([
        { id: `${id}-received`, incidentId: id, type: "TRIGGER_RECEIVED", priority: "P1", detail: "Durable trigger received and incident identity committed.", createdAt: now },
        { id: `${id}-queued`, incidentId: id, type: "P1_QUEUED", priority: "P1", detail: "SMS and XMPP outbox items queued independently.", createdAt: now },
      ]);
      await tx.insert(casOutbox).values([
        { id: `${id}-sms`, incidentId: id, transport: "SMS", state: "QUEUED", priority: "P1", createdAt: now },
        { id: `${id}-xmpp`, incidentId: id, transport: "XMPP", state: "QUEUED", priority: "P1", createdAt: now },
      ]);
      return { id, reused: false };
    });
    return res.status(result.reused ? 200 : 201).json(result);
  } catch (error) { return next(error); }
});

async function appendTransition(id: string, from: string, to: string, type: string, detail: string, res: Response, _next: NextFunction) {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    // Lock the incident before checking its state. Without this, concurrent
    // responders can both read the same status and append duplicate events.
    await tx.execute(sql`SELECT id FROM cas_incidents WHERE id = ${id} FOR UPDATE`);
    const rows = await tx.select().from(casIncidents).where(eq(casIncidents.id, id)).limit(1);
    if (!rows[0] || rows[0].status !== from) return false;
    await tx.update(casIncidents).set({ status: to, updatedAt: now }).where(eq(casIncidents.id, id));
    await tx.insert(casIncidentEvents).values({ id: `${id}-${type.toLowerCase()}-${now.getTime()}`, incidentId: id, type, priority: "P1", detail, createdAt: now });
    return true;
  });
  if (!result) return res.status(409).json({ error: `Incident is not ${from}` });
  return res.json({ id, status: to });
}

router.post("/cas/incidents/:id/ack", (req, res, next) => appendTransition(req.params.id, "ACTIVE_UNACKED", "ACTIVE_ACKED", "RESPONDER_ACK", "Responder acknowledgement accepted; location would continue.", res, next).catch(next));
router.post("/cas/incidents/:id/resolve", (req, res, next) => appendTransition(req.params.id, "ACTIVE_ACKED", "RESOLVED", "RESPONDER_RESOLVE", "Authenticated resolution appended to the journal.", res, next).catch(next));

router.patch("/cas/setup/:id", async (req, res, next) => {
  try {
    const body = z.object({ complete: z.boolean() }).parse(req.body);
    const [row] = await db.update(casSetupReadiness).set({ complete: body.complete, updatedAt: new Date() }).where(eq(casSetupReadiness.id, req.params.id)).returning();
    if (!row) return res.status(404).json({ error: "Setup item not found" });
    return res.json(row);
  } catch (error) { return next(error); }
});

router.patch("/cas/gates/:id", async (req, res, next) => {
  try {
    const body = z.object({ status: z.enum(["verified", "partial", "blocked", "not-started"]) }).parse(req.body);
    const [row] = await db.update(casGateEvidence).set({ status: body.status, updatedAt: new Date() }).where(eq(casGateEvidence.id, req.params.id)).returning();
    if (!row) return res.status(404).json({ error: "Gate not found" });
    return res.json(row);
  } catch (error) { return next(error); }
});

export default router;