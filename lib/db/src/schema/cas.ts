import { boolean, doublePrecision, integer, jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const casIncidents = pgTable("cas_incidents", {
  id: text("id").primaryKey(),
  priority: text("priority").notNull(),
  status: text("status").notNull(),
  triggerCount: integer("trigger_count").notNull().default(1),
  // One position fix per alert, captured by the handset under a bounded wait
  // and carried with its accuracy and capture time so a stale or coarse fix
  // is never presented as current truth. All four stay null when the alert
  // went out with no fix (permission denied, no provider, wait expired).
  locationLatitude: doublePrecision("location_latitude"),
  locationLongitude: doublePrecision("location_longitude"),
  locationAccuracyM: real("location_accuracy_m"),
  locationCapturedAt: timestamp("location_captured_at", { withTimezone: true }),
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
  // Correlation for device-direct receipts: a server-generated token
  // identifying the current delivery cycle. Null for the initial cycle
  // (the handset's first send is triggered locally and never learns one);
  // minted fresh on every operator re-queue and handed to the handset via
  // the device-pending list, which echoes it back in the receipt. A receipt
  // echoing an older token belongs to a superseded batch and is rejected
  // (410) so it cannot mark the re-queued item SENT. Deliberately NOT a
  // timestamp: handset and console wall clocks are not guaranteed to agree.
  deviceCycleToken: text("device_cycle_token"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casProviderDeliveries = pgTable("cas_provider_deliveries", {
  // Durable per-recipient acceptance ledger for providers that cannot honor
  // the Idempotency-Key replay contract (the WhatsApp Business Cloud API has
  // no idempotency). Keyed by a SHA-256 hash of "<outbox-id>:<recipient>"
  // because the privacy invariant forbids persisting full responder numbers;
  // the masked form is stored only so an operator can read the ledger. A
  // retried send skips recipients whose acceptance is already recorded, so a
  // worker crash after partial acceptance cannot duplicate those messages.
  keyHash: text("key_hash").primaryKey(),
  transport: text("transport").notNull(),
  incidentId: text("incident_id").notNull().references(() => casIncidents.id),
  recipientMasked: text("recipient_masked").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casTransportCooldowns = pgTable("cas_transport_cooldowns", {
  transport: text("transport").primaryKey(),
  nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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