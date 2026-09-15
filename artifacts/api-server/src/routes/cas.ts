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
  casTransportCooldowns,
} from "@workspace/db/schema";
import { z } from "zod";
import { validateGate0aImport, type Gate0aReport } from "../lib/gate0a-report";
import {
  CasProviderError,
  createCasDeliverySender,
  formatProviderError,
  loadConfiguredProviders,
} from "../lib/delivery-providers";
import { getCasOutboxWorkerHeartbeat } from "../lib/cas-outbox-status";

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

router.post("/cas/gate0a/import", async (req, res, next) => {
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
      worker: getCasOutboxWorkerHeartbeat(),
    });
  } catch (error) { return next(error); }
});

router.post("/cas/bootstrap", async (req, res, next) => {
  try {
    const body = z.object({
      setup: z.array(z.object({
        id: z.string(),
        label: z.string(),
        detail: z.string(),
        group: z.string(),
        complete: z.boolean(),
        mode: z.string(),
      })),
      gates: z.array(z.object({
        id: z.string(),
        index: z.string(),
        name: z.string(),
        short: z.string(),
        status: z.string(),
        criterion: z.string(),
        evidence: z.array(z.string()),
        nextAction: z.string(),
        owner: z.string(),
      })),
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

/**
 * Operator recovery for an abandoned delivery: moves a DEAD_LETTER item back
 * to QUEUED with attempts reset and the lease cleared so the worker claims it
 * on its next pass, and journals the manual recovery so the timeline shows
 * abandonment followed by re-queue. Only DEAD_LETTER items may be re-queued;
 * anything else still has the regular retry path (or is already delivered).
 */
router.post("/cas/outbox/:id/requeue", async (req, res, next) => {
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

router.patch("/cas/setup/:id", async (req, res, next) => {
  try {
    const body = z.object({ status: z.enum(["verified", "partial", "blocked", "not-started"]) }).parse(req.body);
    const [row] = await db.update(casGateEvidence).set({ status: body.status, updatedAt: new Date() }).where(eq(casGateEvidence.id, req.params.id)).returning();
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
