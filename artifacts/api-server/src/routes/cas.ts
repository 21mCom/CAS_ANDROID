import { Router, type IRouter, type Response, type NextFunction } from "express";
import { and, asc, desc, eq, ne } from "drizzle-orm";
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
    const active = await db.select().from(casIncidents).where(ne(casIncidents.status, "RESOLVED")).orderBy(desc(casIncidents.createdAt)).limit(1);
    const now = new Date();
    if (active[0]) {
      const incident = active[0];
      await db.transaction(async (tx) => {
        await tx.update(casIncidents).set({ triggerCount: incident.triggerCount + 1, updatedAt: now }).where(eq(casIncidents.id, incident.id));
        await tx.insert(casIncidentEvents).values({ id: `${incident.id}-retrigger-${now.getTime()}`, incidentId: incident.id, type: "TRIGGER_REUSED", priority: "P1", detail: "Repeat trigger folded into the existing active incident; timers and outbox were not reset.", createdAt: now });
      });
      return res.json({ id: incident.id, reused: true });
    }
    const id = `sim-${now.getTime()}`;
    await db.transaction(async (tx) => {
      await tx.insert(casIncidents).values({ id, priority: "P1", status: "ACTIVE_UNACKED", createdAt: now, updatedAt: now });
      await tx.insert(casIncidentEvents).values([
        { id: `${id}-received`, incidentId: id, type: "TRIGGER_RECEIVED", priority: "P1", detail: "Durable trigger received and incident identity committed.", createdAt: now },
        { id: `${id}-queued`, incidentId: id, type: "P1_QUEUED", priority: "P1", detail: "SMS and XMPP outbox items queued independently.", createdAt: now },
      ]);
      await tx.insert(casOutbox).values([
        { id: `${id}-sms`, incidentId: id, transport: "SMS", state: "QUEUED", priority: "P1", createdAt: now },
        { id: `${id}-xmpp`, incidentId: id, transport: "XMPP", state: "QUEUED", priority: "P1", createdAt: now },
      ]);
    });
    return res.status(201).json({ id, reused: false });
  } catch (error) { return next(error); }
});

async function appendTransition(id: string, from: string, to: string, type: string, detail: string, res: Response, _next: NextFunction) {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
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