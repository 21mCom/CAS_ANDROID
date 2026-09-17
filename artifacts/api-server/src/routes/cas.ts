import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  casGateEvidence,
  casIncidentEvents,
  casIncidents,
  casOutbox,
  casSetupReadiness,
  casTransportCooldowns,
} from "@workspace/db/schema";
import { z } from "zod";
import { validateGate0aImport, type Gate0aReport } from "../lib/gate0a-report";
import {
  CasProviderError,
  configuredProviderTransports,
  createCasDeliverySender,
  formatProviderError,
  loadConfiguredProviders,
} from "../lib/delivery-providers";
import { getCasOutboxWorkerHeartbeat } from "../lib/cas-outbox-status";
import { deviceAccessToken, deviceChannels, maskRecipient, smsDeliveryMode, type DeviceChannel } from "../lib/cas-device-delivery";
import { requireCasCredential } from "../lib/cas-auth";
import { detectSecretInNote } from "../lib/note-secrets";

const router: IRouter = Router();

export const DELIVERY_LEASE_MS = 30_000;
// A delivery that keeps being rejected after this many attempts is abandoned
// (DEAD_LETTER) so a permanently failing provider cannot cycle an alert
// QUEUED -> FAILED forever.
export const MAX_DELIVERY_ATTEMPTS = 8;

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
    `Imported Gate 0A report (${report.schema}).`,
    `Evidence class: ${report.evidenceClass}. Run status: ${report.status}.`,
    `Target: ${report.target.model}; Android ${report.target.androidVersion}; API ${report.target.androidApi}; build ${report.target.build}.`,
    report.evidenceClass === "physical-device-observation"
      ? "This import is hardware evidence for review only; it is recorded INCONCLUSIVE and never establishes Pass or production readiness."
      : report.evidenceClass === "simulated-emulator"
        ? "This import is emulator evidence; it is recorded INCONCLUSIVE and cannot establish physical Gate 0A readiness."
        : "This import is sample evidence; it is recorded INCONCLUSIVE and cannot establish Gate 0A readiness.",
    `Preflight status: ${report.preflight.status}.`,
    `Cover package reported: ${report.coverPackage || "(none)"}.`,
    `Cover-launch outcomes (raw): ${outcomes.length > 0 ? outcomes.join(" | ") : "none recorded"}.`,
    report.warnings.length > 0 ? `Unresolved warnings: ${report.warnings.join(" | ")}.` : "Unresolved warnings: none.",
    report.evidence.rawReferences.length > 0
      ? `Raw evidence references: ${report.evidence.rawReferences.join(", ")}.`
      : "Raw evidence references: none.",
    "Report event timestamps (raw device values):",
    timestampLines.length > 0 ? timestampLines.join("\n") : "none recorded",
  ].join("\n");
}

// Gated like every other console mutation: no harness host posts reports over
// HTTP (CI validates them offline via scripts/validate-gate0a-report.ts), so
// the only caller is the operator console, which holds the credential.
router.post("/cas/gate0a/import", requireCasCredential, async (req, res, next) => {
  try {
    const validation = validateGate0aImport(req.body);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error, issues: validation.issues ?? [] });
    }
    const report = validation.report;
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
      evidenceClass: report.evidenceClass,
      runStatus: report.status,
      preflightStatus: report.preflight.status,
      warningCount: report.warnings.length + report.preflight.unresolvedWarnings.length,
      },
    });
  } catch (error) { return next(error); }
});

function shapeIncident(incident: typeof casIncidents.$inferSelect, events: typeof casIncidentEvents.$inferSelect[], outbox: typeof casOutbox.$inferSelect[]) {
  return {
    id: incident.id, status: incident.status, priority: incident.priority,
    triggerCount: incident.triggerCount, createdAt: incident.createdAt.toISOString(),
    events: events.map((event) => ({ id: event.id, type: event.type, priority: event.priority, time: event.createdAt.toISOString(), detail: event.detail })),
    outbox: outbox.map((item) => ({
      id: item.id,
      transport: item.transport,
      state: item.state,
      priority: item.priority,
      attempts: item.attempts,
      lastError: item.lastError,
      terminal: item.state === "SENT" || item.state === "DEAD_LETTER",
    })),
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

/**
 * Operator-visible pipeline health: outbox counts by state plus the delivery
 * worker's heartbeat. Responders use this to spot a stalled or dead-lettering
 * pipeline without reading server logs or querying the database.
 */
router.get("/cas/outbox/status", async (_req, res, next) => {
  try {
    const [countRows, oldestPending, lastErrorRows] = await Promise.all([
      db
        .select({ state: casOutbox.state, count: sql<number>`count(*)::int` })
        .from(casOutbox)
        .groupBy(casOutbox.state),
      // Age of the oldest item still waiting on a provider — the "stuck"
      // signal the console warns about.
      db
        .select({ createdAt: casOutbox.createdAt })
        .from(casOutbox)
        .where(sql`${casOutbox.state} IN ('QUEUED', 'PROCESSING', 'FAILED')`)
        .orderBy(asc(casOutbox.createdAt))
        .limit(1),
      // Most recent delivery failure, retryable or abandoned, so the console
      // can name the provider problem.
      db
        .select({
          transport: casOutbox.transport,
          state: casOutbox.state,
          attempts: casOutbox.attempts,
          lastError: casOutbox.lastError,
        })
        .from(casOutbox)
        .where(sql`${casOutbox.lastError} IS NOT NULL`)
        .orderBy(desc(casOutbox.createdAt))
        .limit(1),
    ]);

    const counts: Record<string, number> = {
      QUEUED: 0,
      PROCESSING: 0,
      FAILED: 0,
      SENT: 0,
      DEAD_LETTER: 0,
    };
    for (const row of countRows) {
      counts[row.state] = (counts[row.state] ?? 0) + row.count;
    }

    const lastError = lastErrorRows[0];
    return res.json({
      counts,
      oldestPendingAt: oldestPending[0]?.createdAt.toISOString() ?? null,
      lastDeliveryError: lastError
        ? {
            transport: lastError.transport,
            state: lastError.state,
            attempts: lastError.attempts,
            message: lastError.lastError,
          }
        : null,
      // Tells the console who delivers SMS: the worker ("gateway") or the
      // alerting handset ("device"), so a QUEUED SMS item in device mode is
      // read as "waiting for the handset's receipt", not a stalled worker.
      // deviceChannels lists which transports the handset delivers itself in
      // device mode (CAS_DEVICE_CHANNELS).
      smsDeliveryMode: smsDeliveryMode(),
      deviceChannels: deviceChannels(),
      // False means the handset endpoints are closed (503): receipts cannot
      // arrive until CAS_DEVICE_TOKEN is set and entered on the handset.
      deviceAuthConfigured: deviceAccessToken() !== undefined,
      worker: getCasOutboxWorkerHeartbeat(),
    });
  } catch (error) { return next(error); }
});

/**
 * The handset endpoints (device-pending, device-receipt) enumerate and
 * mutate delivery state, so they require the shared device token. In device
 * mode the token is mandatory: with CAS_DEVICE_TOKEN unset they stay closed
 * (503) rather than let any network client mark an unsent alert SENT.
 * Returns true when the request may proceed.
 */
function requireDeviceToken(req: Request, res: Response): boolean {
  const expected = deviceAccessToken();
  if (!expected) {
    res.status(503).json({
      error: "Device access is not configured on this console (CAS_DEVICE_TOKEN unset); handset endpoints stay closed until it is set.",
    });
    return false;
  }
  const presented = Buffer.from(req.get("x-cas-device-token") ?? "");
  const expectedBuffer = Buffer.from(expected);
  if (presented.length !== expectedBuffer.length || !timingSafeEqual(presented, expectedBuffer)) {
    res.status(401).json({ error: "Missing or invalid device token" });
    return false;
  }
  return true;
}

/**
 * Device-direct pickup list for the alerting handset. In device mode the
 * worker never claims the handset-delivered channels (CAS_DEVICE_CHANNELS),
 * so after an operator re-queues an abandoned delivery the handset learns
 * about it here, re-sends it itself, and reports the outcome to the receipt
 * endpoint. Read-only: the receipt call is the state transition, so polling
 * can never claim or mutate anything.
 */
router.get("/cas/outbox/device-pending", async (req, res, next) => {
  try {
    const channels = deviceChannels();
    if (channels.length === 0) {
      return res.status(409).json({
        error: "Device pickup is only available when CAS_SMS_DELIVERY_MODE=device; items are delivered by the server-side provider worker.",
      });
    }
    if (!requireDeviceToken(req, res)) return;
    const now = new Date();
    const items = await db
      .select({
        id: casOutbox.id,
        incidentId: casOutbox.incidentId,
        transport: casOutbox.transport,
        priority: casOutbox.priority,
        createdAt: casOutbox.createdAt,
        deviceCycleToken: casOutbox.deviceCycleToken,
      })
      .from(casOutbox)
      .where(
        sql`${casOutbox.transport} IN (${sql.join(channels.map((channel) => sql`${channel}`), sql`, `)})
          AND (
            ${casOutbox.state} = 'QUEUED'
            OR (${casOutbox.state} = 'FAILED' AND ${casOutbox.nextAttemptAt} <= ${now})
          )`,
      )
      .orderBy(asc(casOutbox.createdAt))
      .limit(20);
    return res.json({
      items: items.map((item) => ({
        id: item.id,
        incidentId: item.incidentId,
        transport: item.transport,
        priority: item.priority,
        createdAt: item.createdAt.toISOString(),
        // The current delivery-cycle token; the handset must persist it with
        // the batch and echo it in the receipt. Null while the item is in
        // its initial cycle (never re-queued).
        cycleToken: item.deviceCycleToken,
      })),
    });
  } catch (error) { return next(error); }
});

const deviceReceiptSchema = z.object({
  channel: z.enum(["SMS", "WHATSAPP"]).default("SMS"),
  // The current delivery-cycle token, which the handset picked up from the
  // device-pending list with the re-queued item and echoes back here.
  // Absent from initial-cycle sends (the handset triggers those locally,
  // possibly offline, and never sees the list) and from the first
  // device-direct APKs.
  cycleToken: z.string().trim().min(1).max(120).optional(),
  results: z
    .array(
      z.object({
        recipient: z.string().trim().min(1).max(40),
        ok: z.boolean(),
        error: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .min(1)
    .max(20),
});

/**
 * Device-direct receipt: the alerting handset reports the outcome of a
 * channel it delivered itself (SMS over its own SIM, or WhatsApp via a
 * tap-to-send handoff). All recipients OK transitions the outbox item to
 * SENT; any failure dead-letters it immediately — the handset is the only
 * delivery agent for these channels, so there is no server-side retry, and
 * the recovery path is the operator fixing the responder configuration and
 * re-queuing.
 *
 * Replay-safe: a duplicate receipt for an already-SENT item returns 200
 * without re-journaling, because the handset may retry its report after a
 * data outage.
 *
 * Stale-receipt guard: the handset persists receipts and retries them, so a
 * receipt can outlive the batch it belongs to — e.g. the console accepted a
 * failure receipt and dead-lettered the item, but the 200 was lost in a data
 * outage, the operator re-queued, and the handset's retry lands while the
 * replacement send is still pending. Correlation is by delivery-cycle token,
 * never by comparing handset and console wall clocks (they are not
 * guaranteed to agree): every re-queue mints a fresh token on the outbox
 * item, the device-pending list hands it to the handset, and the handset
 * persists it with the batch and echoes it in the receipt.
 *   - Item in its initial cycle (token null, never re-queued): any receipt
 *     is accepted — only one batch lineage can exist, and a locally
 *     triggered first send never learned a token.
 *   - Item re-queued at least once (token set): the receipt must echo the
 *     current token. A receipt with an older token — or none, from a
 *     first-generation APK or a pre-re-queue batch — belongs to a
 *     superseded send and is rejected 410 Gone, a permanent rejection the
 *     handset drops instead of retrying forever (409 stays reserved for
 *     transient conflicts the handset should retry). It can never
 *     transition the re-queued item, no matter when its batch was
 *     finalized.
 */
async function handleDeviceReceipt(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
  channelOverride?: "SMS",
) {
  try {
    const channels = deviceChannels();
    if (channels.length === 0) {
      return res.status(409).json({
        error: "Device receipts are only accepted when CAS_SMS_DELIVERY_MODE=device; in gateway mode the server-side provider delivers and a device receipt could falsely mark an alert sent.",
      });
    }
    if (!requireDeviceToken(req, res)) return;
    const body = deviceReceiptSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json({ error: "Invalid device receipt", issues: body.error.issues });
    }
    const channel = channelOverride ?? body.data.channel;
    if (!channels.includes(channel)) {
      return res.status(409).json({
        error: `${channel} is not an enabled device channel (CAS_DEVICE_CHANNELS=${channels.join(",")}); the handset must not report receipts for channels the console did not queue.`,
      });
    }
    const recipients = body.data.results.map((result) => result.recipient);
    if (new Set(recipients).size !== recipients.length) {
      return res.status(400).json({ error: "Invalid device receipt: duplicate recipient entries" });
    }

    const incidentId = req.params.id;
    const now = new Date();
    const failed = body.data.results.filter((result) => !result.ok);
    const failureSummary = failed
      .map((result) => `${result.error ?? "unknown error"} (${maskRecipient(result.recipient)})`)
      .join("; ");
    const total = body.data.results.length;

    const result = await db.transaction(async (tx) => {
      // Lock the incident's channel row before reading its state so a
      // concurrent receipt (or a re-queue landing mid-report) cannot
      // double-transition it.
      const rows = await tx.execute(sql`
        SELECT ${casOutbox.id} AS id, ${casOutbox.state} AS state,
          ${casOutbox.deviceCycleToken} AS device_cycle_token
        FROM cas_outbox
        WHERE ${casOutbox.incidentId} = ${incidentId} AND ${casOutbox.transport} = ${channel}
        FOR UPDATE
      `);
      const item = rows.rows[0] as
        | { id?: string; state?: string; device_cycle_token?: string | null }
        | undefined;
      if (!item?.id || !item.state) return "missing" as const;
      if (item.state === "SENT") return "already-sent" as const;
      if (item.state !== "QUEUED" && item.state !== "FAILED") {
        return "conflict" as const;
      }

      // Cycle-token check: once the item has been re-queued, only a receipt
      // echoing the current cycle's token can transition it. A receipt with
      // an older token — or none, from a pre-re-queue batch or a
      // first-generation APK — reports a superseded send: rejected
      // permanently (410) so the handset drops it instead of retrying it on
      // every resume and it can never mark the re-queued item SENT before
      // the replacement send has even gone out.
      if (item.device_cycle_token != null && body.data.cycleToken !== item.device_cycle_token) {
        return "stale" as const;
      }

      if (failed.length === 0) {
        await tx
          .update(casOutbox)
          .set({ state: "SENT", claimedBy: null, claimedAt: null, lastError: null, sentAt: now })
          .where(eq(casOutbox.id, item.id));
        await tx.insert(casIncidentEvents).values({
          id: `${item.id}-device-delivered-${now.getTime()}`,
          incidentId,
          type: "DELIVERY_REPORTED",
          priority: "P1",
          detail:
            channel === "SMS"
              ? `Handset confirmed it sent the SMS alert directly to ${total} responder(s) over its own SIM (device-direct mode; no gateway involved).`
              : `Handset confirmed it handed the WhatsApp alert to WhatsApp for ${total} responder(s) (tap-to-send handoff; the free WhatsApp app has no unattended-send API, so SENT means handed to WhatsApp, not delivery-confirmed).`,
          createdAt: now,
        });
        return "sent" as const;
      }

      await tx
        .update(casOutbox)
        .set({
          state: "DEAD_LETTER",
          claimedBy: null,
          claimedAt: null,
          lastError: `device-reported failure: ${failureSummary}`,
        })
        .where(eq(casOutbox.id, item.id));
      await tx.insert(casIncidentEvents).values({
        id: `${item.id}-device-failed-${now.getTime()}`,
        incidentId,
        type: "DELIVERY_ABANDONED",
        priority: "P1",
        detail:
          channel === "SMS"
            ? `Handset reported it could not send the SMS alert to ${failed.length} of ${total} responder(s): ${failureSummary}. Fix the responder configuration on the handset and re-queue this delivery; the handset picks re-queued items up from the device-pending list.`
            : `Handset reported it could not hand the WhatsApp alert to WhatsApp for ${failed.length} of ${total} responder(s): ${failureSummary}. Check WhatsApp is installed and the responder numbers are correct on the handset, then re-queue this delivery.`,
        createdAt: now,
      });
      return "dead-lettered" as const;
    });

    if (result === "missing") {
      return res.status(404).json({ error: `No ${channel} outbox item for this incident` });
    }
    if (result === "already-sent") {
      return res.json({ id: incidentId, state: "SENT", replay: true });
    }
    if (result === "stale") {
      // 410 (not 409) is the handset's signal to drop the persisted receipt:
      // this batch was superseded by an operator re-queue and the console
      // will never accept its receipt, however often it is retried.
      return res.status(410).json({
        error: `This receipt's batch predates the latest re-queue of the ${channel} item; the console will never accept it. The handset must drop it and report the replacement send instead.`,
      });
    }
    if (result === "conflict") {
      return res.status(409).json({ error: `${channel} outbox item is being delivered or was abandoned; re-queue it before the handset retries` });
    }
    return res.json({ id: incidentId, state: result === "sent" ? "SENT" : "DEAD_LETTER" });
  } catch (error) { return next(error); }
}

// Kept as a fixed-SMS alias of the device receipt endpoint: the first
// device-direct APKs only know this route, and SMS is their only channel.
router.post("/cas/incidents/:id/sms-receipt", (req, res, next) =>
  handleDeviceReceipt(req, res, next, "SMS"));

router.post("/cas/incidents/:id/device-receipt", (req, res, next) =>
  handleDeviceReceipt(req, res, next));

// The console posts its built-in readiness catalog — { gates, setup }, the
// same shapes use-field-test seeds from — the first time it finds both
// tables empty. Seed exactly that payload, and only into empty tables, so a
// later console cannot overwrite an operator's curated readiness state.
// Mirrors the console's Gate/SetupItem shapes (use-field-test.tsx); updatedAt
// is server-managed, and unknown keys are stripped rather than rejected so a
// newer console can still seed an older API.
const bootstrapGateSchema = z.object({
  id: z.string().min(1),
  index: z.string(),
  name: z.string(),
  short: z.string(),
  status: z.enum(["verified", "partial", "blocked", "not-started"]),
  criterion: z.string(),
  evidence: z.array(z.string()).default([]),
  nextAction: z.string(),
  owner: z.string(),
});
const bootstrapSetupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string(),
  group: z.string(),
  complete: z.boolean().default(false),
  mode: z.enum(["owner", "measured"]),
});
const bootstrapSchema = z.object({
  gates: z.array(bootstrapGateSchema),
  setup: z.array(bootstrapSetupSchema),
});

router.post("/cas/bootstrap", requireCasCredential, async (req, res, next) => {
  try {
    const parsed = bootstrapSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid bootstrap payload", issues: parsed.error.issues });
    }
    const existing = await db.select({ id: casSetupReadiness.id }).from(casSetupReadiness).limit(1);
    if (existing.length === 0) {
      await db.transaction(async (tx) => {
        if (parsed.data.setup.length > 0) {
          await tx.insert(casSetupReadiness).values(parsed.data.setup);
        }
        if (parsed.data.gates.length > 0) {
          await tx.insert(casGateEvidence).values(parsed.data.gates);
        }
      });
    }
    res.status(201).json({ seeded: existing.length === 0 });
  } catch (error) { return next(error); }
});

// A test incident is a local feasibility record the console creates on
// demand: no message is sent and no device action is triggered. The route
// takes no id — the server mints one — so the console's bare POST cannot
// collide with a real incident's identity.
router.post("/cas/incidents/test", requireCasCredential, async (req, res, next) => {
  try {
    const now = new Date();
    const id = `test-${now.getTime()}-${randomUUID()}`;
    await db.insert(casIncidents).values({ id, priority: "P3", status: "RESOLVED", triggerCount: 1, createdAt: now, updatedAt: now });
    await db.insert(casIncidentEvents).values({ id: `${id}-recorded`, incidentId: id, type: "TEST_RECORDED", priority: "P3", detail: "Local test action completed. No message was sent and no device action was triggered.", createdAt: now });
    return res.status(201).json({ id });
  } catch (error) { return next(error); }
});

// The handset declares which device channels it will actually deliver for
// this alert (e.g. the WhatsApp checkbox); the console queues the
// intersection with the channels it has enabled, so a channel nobody will
// deliver never creates an outbox row that can only dead-letter. An omitted
// list means "every enabled device channel" (API drills and older APKs).
const triggerSchema = z.object({
  deviceChannels: z.array(z.enum(["SMS", "WHATSAPP"])).max(4).optional(),
});

// Every CAS mutation — trigger, incident/outbox transitions, readiness
// bootstrap, test incident, setup/gate edits, and the Gate 0A import —
// requires the enrolled-device credential; an unauthenticated request is
// rejected with 401 and recorded.
router.post("/cas/incidents/trigger", requireCasCredential, async (req, res, next) => {
  try {
    const parsed = triggerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid trigger request", issues: parsed.error.issues });
    }
    const enabledDevice = deviceChannels();
    const requested = parsed.data.deviceChannels;
    const notEnabled = (requested ?? []).filter((channel) => !enabledDevice.includes(channel));
    if (notEnabled.length > 0) {
      // Loud mismatch, not a silent drop: the handset learns the console did
      // not queue that channel, still sends its alert directly, and journals
      // the outcome without an outbox row to report against.
      return res.status(409).json({
        error: `Requested device channel(s) not enabled on this console: ${notEnabled.join(", ")} (enabled: ${enabledDevice.join(", ") || "none"}). The handset should still send its alert directly and journal the mismatch.`,
      });
    }
    const deviceTransports: DeviceChannel[] = requested === undefined
      ? enabledDevice
      : enabledDevice.filter((channel) => requested.includes(channel));
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
      // Queue one outbox item per channel that can actually deliver this
      // alert: the handset's requested∩enabled device channels, plus every
      // provider-configured gateway channel that is not device-delivered.
      // A channel nobody can deliver must not create a row that can only
      // dead-letter — that noise trains responders to ignore the alarm.
      const transports: string[] = [
        ...deviceTransports,
        ...configuredProviderTransports().filter(
          (transport) => !(enabledDevice as string[]).includes(transport),
        ),
      ];
      await tx.insert(casIncidentEvents).values([
        { id: `${id}-received`, incidentId: id, type: "TRIGGER_RECEIVED", priority: "P1", detail: "Durable trigger received and incident identity committed.", createdAt: now },
        { id: `${id}-queued`, incidentId: id, type: "P1_QUEUED", priority: "P1", detail: transports.length > 0 ? `${transports.join(", ")} outbox items queued independently.` : "No outbox items queued: no deliverable channel was requested/enabled on the handset or provider-configured on the console.", createdAt: now },
      ]);
      if (transports.length > 0) {
        await tx.insert(casOutbox).values(
          transports.map((transport) => ({
            id: `${id}-${transport.toLowerCase()}`,
            incidentId: id,
            transport,
            state: "QUEUED",
            priority: "P1",
            createdAt: now,
          })),
        );
      }
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

// Handlers annotate req explicitly: with the auth middleware in the chain,
// Express's path-param inference widens req.params.id to string | string[].
router.post("/cas/incidents/:id/ack", requireCasCredential, (req: Request<{ id: string }>, res, next) => appendTransition(req.params.id, "ACTIVE_UNACKED", "ACTIVE_ACKED", "RESPONDER_ACK", "Responder acknowledgement accepted; location would continue.", res, next).catch(next));
router.post("/cas/incidents/:id/resolve", requireCasCredential, (req: Request<{ id: string }>, res, next) => appendTransition(req.params.id, "ACTIVE_ACKED", "RESOLVED", "RESPONDER_RESOLVE", "Authenticated resolution appended to the journal.", res, next).catch(next));

// NOTE_SECRET_PATTERNS and detectSecretInNote live in ../lib/note-secrets so
// the one-off journal audit (scripts/audit-journal-secrets.ts) scans pre-guard
// entries with the exact shapes this guard rejects.

/**
 * Operator recovery for an abandoned delivery: moves a DEAD_LETTER item back
 * to QUEUED with attempts reset and the lease cleared so the worker claims it
 * on its next pass, and journals the manual recovery so the timeline shows
 * abandonment followed by re-queue. Only DEAD_LETTER items may be re-queued;
 * anything else still has the regular retry path (or is already delivered).
 */
router.post("/cas/outbox/:id/requeue", requireCasCredential, async (req: Request<{ id: string }>, res, next) => {
  try {
    // Optional responder note recording what was fixed before re-queuing, so
    // the incident journal shows the manual recovery was deliberate. A bare
    // POST with no body still re-queues exactly as before.
    const body = z
      .object({ reason: z.string().trim().min(1).max(500).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return res.status(400).json({ error: "Invalid re-queue note", issues: body.error.issues });
    }
    // Reject before any state change or journal entry: a note carrying an
    // actual credential must never be persisted.
    if (body.data.reason) {
      const leaked = detectSecretInNote(body.data.reason);
      if (leaked) {
        return res.status(400).json({
          error: `Re-queue note appears to contain ${leaked}. Never paste credentials into the incident journal — it is append-only and broadly visible. Describe the fix instead (e.g. "rotated the provider API key").`,
        });
      }
    }
    const id = req.params.id;
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      // Lock the row before checking its state so a concurrent worker cannot
      // complete or re-claim the item between the check and the update.
      await tx.execute(sql`SELECT id FROM cas_outbox WHERE id = ${id} FOR UPDATE`);
      const rows = await tx.select().from(casOutbox).where(eq(casOutbox.id, id)).limit(1);
      const item = rows[0];
      if (!item) return "missing" as const;
      if (item.state !== "DEAD_LETTER") return "conflict" as const;
      await tx.update(casOutbox).set({
        state: "QUEUED",
        attempts: 0,
        claimedBy: null,
        claimedAt: null,
        nextAttemptAt: now,
        // Starts a new delivery cycle for device channels: the receipt
        // endpoint only accepts receipts echoing this token afterwards, so a
        // stale retried receipt from the superseded batch (rejected 410, and
        // dropped by the handset) can never mark the re-queued item SENT
        // before the replacement send goes out. Server-generated, not a
        // timestamp: handset and console clocks are not guaranteed to agree.
        deviceCycleToken: randomUUID(),
      }).where(eq(casOutbox.id, id));
      await tx.insert(casIncidentEvents).values({
        id: `${id}-requeued-${now.getTime()}`,
        incidentId: item.incidentId,
        type: "DELIVERY_REQUEUED",
        priority: item.priority,
        detail: `Responder re-queued the abandoned ${item.transport} delivery after fixing the provider problem (previously abandoned after ${item.attempts} attempts; last error: ${item.lastError ?? "none recorded"}). The delivery worker will attempt it again.${body.data.reason ? ` Responder note: ${body.data.reason}` : ""}`,
        createdAt: now,
      });
      return "requeued" as const;
    });
    if (result === "missing") return res.status(404).json({ error: "Outbox item not found" });
    if (result === "conflict") return res.status(409).json({ error: "Only a DEAD_LETTER delivery can be re-queued" });
    return res.json({ id, state: "QUEUED" });
  } catch (error) { return next(error); }
});

router.patch("/cas/setup/:id", requireCasCredential, async (req: Request<{ id: string }>, res, next) => {
  try {
    // Setup readiness items are toggled complete/incomplete from the console;
    // this is cas_setup_readiness, not gate evidence.
    const parsed = z.object({ complete: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid setup update", issues: parsed.error.issues });
    }
    const [row] = await db.update(casSetupReadiness).set({ complete: parsed.data.complete, updatedAt: new Date() }).where(eq(casSetupReadiness.id, req.params.id)).returning();
    if (!row) return res.status(404).json({ error: "Setup item not found" });
    return res.json(row);
  } catch (error) { return next(error); }
});

router.patch("/cas/gates/:id", requireCasCredential, async (req: Request<{ id: string }>, res, next) => {
  try {
    const body = z.object({ status: z.enum(["verified", "partial", "blocked", "not-started"]) }).parse(req.body);
    const [row] = await db.update(casGateEvidence).set({ status: body.status, updatedAt: new Date() }).where(eq(casGateEvidence.id, req.params.id)).returning();
    if (!row) return res.status(404).json({ error: "Gate not found" });
    return res.json(row);
  } catch (error) { return next(error); }
});

export default router;

export type CasDeliverySender = (
  item: typeof casOutbox.$inferSelect,
  idempotencyKey: string,
) => Promise<void>;

/**
 * Claims and delivers durable outbox records.
 *
 * The outbox ID is the delivery's idempotency key. A transport adapter must
 * pass that key to its provider so a worker crash after provider acceptance
 * cannot cause a duplicate when the lease is reclaimed.
 */
export async function processCasOutbox(options: {
  workerId?: string;
  maxItems?: number;
  send?: CasDeliverySender;
} = {}): Promise<CasOutboxWorkerResult> {
  const workerId = options.workerId ?? `cas-worker-${randomUUID()}`;
  const maxItems = options.maxItems ?? 10;
  const send = options.send ?? defaultCasDeliverySender;
  const result: CasOutboxWorkerResult = {
    workerId,
    claimed: 0,
    sent: 0,
    failed: 0,
    deadLettered: 0,
    deliveries: [],
  };

  for (let index = 0; index < maxItems; index += 1) {
    const claimed = await claimCasOutboxItem(workerId, new Date());
    if (!claimed) break;
    result.claimed += 1;

    try {
      await send(claimed, claimed.id);
      const completed = await completeCasOutboxItem(
        claimed,
        workerId,
        "SENT",
        new Date(),
      );
      if (completed) {
        result.sent += 1;
        result.deliveries.push({
          id: claimed.id,
          transport: claimed.transport,
          state: "SENT",
          attempts: claimed.attempts,
        });
      } else {
        result.deliveries.push({
          id: claimed.id,
          transport: claimed.transport,
          state: "LOST",
          attempts: claimed.attempts,
        });
      }
    } catch (error) {
      const message = formatProviderError(error);
      const retryAfterMs =
        error instanceof CasProviderError ? error.retryAfterMs : undefined;
      const rateLimited =
        error instanceof CasProviderError &&
        error.classification === "rate-limited";
      const failedAt = new Date();
      const exhausted = claimed.attempts >= MAX_DELIVERY_ATTEMPTS;
      const completed = exhausted
        ? await deadLetterCasOutboxItem(claimed, workerId, failedAt, message)
        : await completeCasOutboxItem(
            claimed,
            workerId,
            "FAILED",
            failedAt,
            message,
            retryAfterMs,
          );
      if (rateLimited || retryAfterMs !== undefined) {
        // Persist a per-transport cooldown so no worker tick or API process
        // claims this transport again until the backoff window (the
        // provider's Retry-After hint whenever one is honored) has elapsed.
        // Without this, a deep queue behind a throttling or hinted-outage
        // provider would be hammered on every tick and could starve the
        // other transport.
        const nextAllowedAt = new Date(
          failedAt.getTime() + retryDelayMs(claimed.attempts, retryAfterMs),
        );
        await db
          .insert(casTransportCooldowns)
          .values({
            transport: claimed.transport,
            nextAllowedAt,
            updatedAt: failedAt,
          })
          .onConflictDoUpdate({
            target: casTransportCooldowns.transport,
            set: {
              // Concurrent workers may race to record the cooldown; keep the
              // furthest-out window so a shorter backoff cannot erase a
              // longer provider hint.
              nextAllowedAt: sql`greatest(${casTransportCooldowns.nextAllowedAt}, excluded.next_allowed_at)`,
              updatedAt: failedAt,
            },
          });
      }
      if (completed && exhausted) {
        result.deadLettered += 1;
        result.deliveries.push({
          id: claimed.id,
          transport: claimed.transport,
          state: "DEAD_LETTER",
          attempts: claimed.attempts,
        });
      } else if (completed) {
        result.failed += 1;
        result.deliveries.push({
          id: claimed.id,
          transport: claimed.transport,
          state: "FAILED",
          attempts: claimed.attempts,
        });
      } else {
        result.deliveries.push({
          id: claimed.id,
          transport: claimed.transport,
          state: "LOST",
          attempts: claimed.attempts,
        });
      }
    }
  }

  return result;
}

// The default sender dispatches to the SMS/XMPP provider adapters configured
// through CAS_* environment variables. A transport without a configured
// provider fails explicitly ("not-configured") so the outbox record is kept
// for the retrying worker instead of being silently dropped.
const defaultCasDeliverySender: CasDeliverySender = createCasDeliverySender(
  loadConfiguredProviders(),
);

const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Moves an exhausted delivery to the terminal DEAD_LETTER state and journals
 * the abandonment on the incident in the same transaction, so responders can
 * see that no further delivery attempts will be made. The claim query never
 * selects DEAD_LETTER rows, so the item stops being retried immediately.
 */
async function deadLetterCasOutboxItem(
  item: typeof casOutbox.$inferSelect,
  workerId: string,
  now: Date,
  error: string,
) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(casOutbox)
      .set({
        state: "DEAD_LETTER",
        claimedBy: null,
        claimedAt: null,
        lastError: error,
      })
      .where(
        sql`${casOutbox.id} = ${item.id}
          AND ${casOutbox.state} = 'PROCESSING'
          AND ${casOutbox.claimedBy} = ${workerId}`,
      )
      .returning({ id: casOutbox.id });
    if (!updated) return undefined;

    await tx.insert(casIncidentEvents).values({
      id: `${item.id}-dead-letter-${now.getTime()}`,
      incidentId: item.incidentId,
      type: "DELIVERY_ABANDONED",
      priority: item.priority,
      detail: `${item.transport} delivery abandoned after ${item.attempts} attempts; provider kept rejecting it (last error: ${error}). No further retries will be made.`,
      createdAt: now,
    });
    return updated;
  });
}

async function completeCasOutboxItem(
  item: typeof casOutbox.$inferSelect,
  workerId: string,
  state: "SENT" | "FAILED",
  now: Date,
  error?: string,
  retryAfterMs?: number,
) {
  const values =
    state === "SENT"
      ? {
          state,
          claimedBy: null,
          claimedAt: null,
          lastError: null,
          sentAt: now,
        }
      : {
          state,
          claimedBy: null,
          claimedAt: null,
          lastError: error ?? "Delivery failed",
          nextAttemptAt: new Date(
            now.getTime() + retryDelayMs(item.attempts, retryAfterMs),
          ),
        };

  const [updated] = await db
    .update(casOutbox)
    .set(values)
    .where(
      sql`${casOutbox.id} = ${item.id}
        AND ${casOutbox.state} = 'PROCESSING'
        AND ${casOutbox.claimedBy} = ${workerId}`,
    )
    .returning({ id: casOutbox.id });
  return updated;
}

// Bounded jitter on top of the backoff spreads retries out: without it, every
// alert that failed during a provider outage becomes claimable at the exact
// same moment and the recovering provider gets hit by a synchronized burst.
const RETRY_JITTER_FRACTION = 0.2;

export function retryDelayMs(
  attempts: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
) {
  const backoff = Math.min(
    MAX_RETRY_DELAY_MS,
    1_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 6),
  );
  // Uniform jitter in [1 - f, 1 + f] * backoff, rounded to whole ms.
  const jittered = Math.round(
    backoff * (1 + (random() * 2 - 1) * RETRY_JITTER_FRACTION),
  );
  // A provider's Retry-After hint is a lower bound on the next attempt, not
  // a replacement for our own backoff: never retry sooner than either one,
  // and jitter must not dip below the hint either.
  return retryAfterMs === undefined
    ? jittered
    : Math.max(jittered, retryAfterMs);
}

export type CasOutboxWorkerResult = {
  workerId: string;
  claimed: number;
  sent: number;
  failed: number;
  deadLettered: number;
  deliveries: Array<{
    id: string;
    transport: string;
    state: "SENT" | "FAILED" | "DEAD_LETTER" | "LOST";
    attempts: number;
  }>;
};

// Exported so crash-recovery tests can drive a worker up to the exact point
// between provider acceptance and the SENT mark.
export async function claimCasOutboxItem(workerId: string, now: Date) {
  const staleBefore = new Date(now.getTime() - DELIVERY_LEASE_MS);
  // In device mode the alerting handset is the delivery agent for the
  // CAS_DEVICE_CHANNELS transports (it reports back through the device
  // receipt endpoint), so the worker must never claim them — there is no
  // server-side provider to send them through, and every claim would fail as
  // "not-configured" while racing the handset's receipt.
  const deviceOnly = deviceChannels();
  return db.transaction(async (tx) => {
    const candidates = await tx.execute(sql`
      SELECT id
      FROM cas_outbox
      WHERE (
        (
          state IN ('QUEUED', 'FAILED')
          AND next_attempt_at <= ${now}
        ) OR (
          state = 'PROCESSING'
          AND claimed_at < ${staleBefore}
        )
      )
      AND transport NOT IN (
        SELECT transport
        FROM cas_transport_cooldowns
        WHERE next_allowed_at > ${now}
      )
      ${deviceOnly.length > 0 ? sql`AND transport NOT IN (${sql.join(deviceOnly.map((transport) => sql`${transport}`), sql`, `)})` : sql``}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);
    const id = (candidates.rows[0] as { id?: string } | undefined)?.id;
    if (!id) return undefined;

    const [claimed] = await tx
      .update(casOutbox)
      .set({
        state: "PROCESSING",
        attempts: sql`${casOutbox.attempts} + 1`,
        claimedBy: workerId,
        claimedAt: now,
      })
      .where(eq(casOutbox.id, id))
      .returning();
    return claimed;
  });
}
