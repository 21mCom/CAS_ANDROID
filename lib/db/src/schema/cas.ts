import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const casIncidents = pgTable("cas_incidents", {
  id: text("id").primaryKey(),
  priority: text("priority").notNull(),
  status: text("status").notNull(),
  triggerCount: integer("trigger_count").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casIncidentEvents = pgTable("cas_incident_events", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull().references(() => casIncidents.id),
  type: text("type").notNull(),
  priority: text("priority").notNull(),
  detail: text("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casOutbox = pgTable("cas_outbox", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull().references(() => casIncidents.id),
  transport: text("transport").notNull(),
  state: text("state").notNull(),
  priority: text("priority").notNull(),
  attempts: integer("attempts").notNull().default(0),
  claimedBy: text("claimed_by"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casSetupReadiness = pgTable("cas_setup_readiness", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  detail: text("detail").notNull(),
  group: text("group").notNull(),
  complete: boolean("complete").notNull().default(false),
  mode: text("mode").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casGateEvidence = pgTable("cas_gate_evidence", {
  id: text("id").primaryKey(),
  index: text("index").notNull(),
  name: text("name").notNull(),
  short: text("short").notNull(),
  status: text("status").notNull(),
  criterion: text("criterion").notNull(),
  evidence: jsonb("evidence").$type<string[]>().notNull().default([]),
  nextAction: text("next_action").notNull(),
  owner: text("owner").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCasIncidentSchema = createInsertSchema(casIncidents);
export const insertCasIncidentEventSchema = createInsertSchema(casIncidentEvents);
export const insertCasOutboxSchema = createInsertSchema(casOutbox);
export const insertCasSetupReadinessSchema = createInsertSchema(casSetupReadiness);
export const insertCasGateEvidenceSchema = createInsertSchema(casGateEvidence);

export type CasIncident = typeof casIncidents.$inferSelect;
export type CasIncidentEvent = typeof casIncidentEvents.$inferSelect;
export type CasOutbox = typeof casOutbox.$inferSelect;
export type CasSetupReadiness = typeof casSetupReadiness.$inferSelect;
export type CasGateEvidence = typeof casGateEvidence.$inferSelect;