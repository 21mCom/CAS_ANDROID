import { boolean, customType, doublePrecision, integer, jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// Drizzle has no built-in bytea column; the evidence blob rides the pg driver
// as a Buffer.
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

export const casEmailAccounts = pgTable("cas_email_accounts", {
  // Console-managed SMTP accounts for the email alert channel: a primary
  // mailbox and an optional fallback for redundancy. When a primary row
  // exists it takes precedence over the CAS_EMAIL_SMTP_* environment
  // secrets (the console shows which source is live); deleting it reverts
  // to the environment. The app password is stored here so the server can
  // authenticate — it is write-only over the API and never returned by
  // reads. Two fixed slots, not a list: primary + one fallback.
  slot: text("slot").primaryKey(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  smtpUser: text("smtp_user").notNull(),
  password: text("password").notNull(),
  fromAddress: text("from_address"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casIncidentEvents = pgTable("cas_incident_events", {
  id: text("id").primaryKey(),
  // Cascade: app code never deletes incidents (the journal is append-only),
  // but test suites and disposable review databases do — the journal must
  // not make an incident undeletable.
  incidentId: text("incident_id").notNull().references(() => casIncidents.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  priority: text("priority").notNull(),
  detail: text("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casOutbox = pgTable("cas_outbox", {
  id: text("id").primaryKey(),
  // Cascade: same test-cleanup rationale as cas_incident_events.
  incidentId: text("incident_id").notNull().references(() => casIncidents.id, { onDelete: "cascade" }),
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
  // Where a gateway delivery was actually accepted, recorded at the SENT
  // transition: "dev-sink" for the built-in dev provider sink (simulated
  // delivery — no real provider was contacted), otherwise the provider's
  // identity (e.g. "graph.facebook.com", "smtp:mail.example.com"). Null for
  // device-direct deliveries (the handset's own SIM) and unsent items, so
  // the console can never present a test-inbox acceptance as real delivery.
  deliveredTo: text("delivered_to"),
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
  // Cascade: same test-cleanup rationale as cas_incident_events.
  incidentId: text("incident_id").notNull().references(() => casIncidents.id, { onDelete: "cascade" }),
  recipientMasked: text("recipient_masked").notNull(),
  // Where this acceptance happened ("dev-sink" or the provider identity).
  // A retry that skips every recipient makes no HTTP request, so this is the
  // only place the sink-vs-real distinction survives — without it a skipped
  // retry would mislabel a test-inbox delivery as real. Null on rows written
  // before provenance was recorded.
  deliveredTo: text("delivered_to"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casTransportCooldowns = pgTable("cas_transport_cooldowns", {
  transport: text("transport").primaryKey(),
  nextAllowedAt: timestamp("next_allowed_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const casResponders = pgTable("cas_responders", {
  // The console-managed responder circle: who gets alerted and on which
  // channels. A non-null channel address means this responder is on that
  // channel; `enabled = false` suspends every channel without losing the
  // record. Rows seeded from the CAS_*_RECIPIENTS environment lists get
  // deterministic "seed-<channel>-<n>" ids so a concurrent first run cannot
  // double-seed, and seeding only ever happens into a completely empty table
  // (an operator's edits are never overwritten).
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  smsNumber: text("sms_number"),
  whatsappNumber: text("whatsapp_number"),
  emailAddress: text("email_address"),
  xmppAddress: text("xmpp_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
/**
 * Per-device enrolled alert credentials. The shared CAS_ALERT_TOKEN secret
 * only authorizes enrolling/revoking these; every mutation endpoint
 * (trigger, ack/resolve, re-queue, readiness writes) requires one of these
 * per-device tokens instead, so a lost phone or leaked console session is
 * containable by revoking a single row. Only the SHA-256 hash of the token
 * is stored — the plaintext token is returned once at enrollment and never
 * persisted, so neither the database nor a journal dump can leak a usable
 * credential. Revocation takes effect on the very next request: the auth
 * gate reads this table per request and never caches.
 */
export const casDeviceCredentials = pgTable("cas_device_credentials", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
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

/**
 * Evidence-capture policy, set from the console and fetched by the handset on
 * every trigger and server contact so toggles take effect with no app
 * reinstall. Exactly one row (id "current"). Each capture type is independent:
 * "off" | "trigger" (start when the alert triggers) | "responder" (only when
 * a responder asks from the console). timing is "immediate" (capture begins
 * at trigger, catching the first-~60-seconds window) or "screen-off"
 * (capture begins when the screen next turns off after the trigger — the
 * stealth-first option) and applies to every enabled type.
 */
export const casCapturePolicy = pgTable("cas_capture_policy", {
  id: text("id").primaryKey(),
  audio: text("audio").notNull().default("off"),
  photo: text("photo").notNull().default("off"),
  video: text("video").notNull().default("off"),
  timing: text("timing").notNull().default("immediate"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertCasIncidentSchema = createInsertSchema(casIncidents);
export const insertCasIncidentEventSchema = createInsertSchema(casIncidentEvents);
export const insertCasOutboxSchema = createInsertSchema(casOutbox);
export const insertCasSetupReadinessSchema = createInsertSchema(casSetupReadiness);
export const insertCasGateEvidenceSchema = createInsertSchema(casGateEvidence);

export type CasResponder = typeof casResponders.$inferSelect;
export type CasIncident = typeof casIncidents.$inferSelect;
export type CasIncidentEvent = typeof casIncidentEvents.$inferSelect;
export type CasOutbox = typeof casOutbox.$inferSelect;
export type CasDeviceCredential = typeof casDeviceCredentials.$inferSelect;
export type CasSetupReadiness = typeof casSetupReadiness.$inferSelect;
export type CasGateEvidence = typeof casGateEvidence.$inferSelect;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const casMessageTemplates = pgTable("cas_message_templates", {
  // Per-channel alert wording, editable from the console. Channels without a
  // row fall back to the built-in default body, so a fresh deployment (or a
  // reset) behaves exactly as before templates existed.
  channel: text("channel").primaryKey(),
  body: text("body").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CasMessageTemplate = typeof casMessageTemplates.$inferSelect;

/**
 * A responder's request for on-demand capture on the alerting handset,
 * created from the console incident view. Stays PENDING until the handset
 * picks it up on its next server contact and acks it (STARTED, or FAILED
 * with the measured reason — e.g. Android's background mic/camera start
 * restriction), then COMPLETED when the resulting evidence lands.
 */
export const casCaptureRequests = pgTable("cas_capture_requests", {
  id: text("id").primaryKey(),
  // Same cascade rationale as cas_evidence: cleanup deletes incidents.
  incidentId: text("incident_id").notNull().references(() => casIncidents.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  state: text("state").notNull().default("PENDING"),
  detail: text("detail"),
  // Which wake path honored the request: "push" (high-priority FCM wake) or
  // "poll" (the handset's next server contact). Null until the handset acks.
  via: text("via"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * FCM registration tokens for the responder-requested capture wake. The
 * handset registers (and rotates) its token against its own enrolled device
 * credential, so a revoked credential's registration stops receiving pushes
 * the moment revocation lands — the dispatcher joins this table against
 * cas_device_credentials and skips revoked rows, and the cascade keeps a
 * deleted credential from leaving a stale token behind. Only the handset's
 * own credential may write its row; tokens are opaque FCM identifiers, not
 * credentials, but are never returned by any read endpoint.
 */
export const casPushRegistrations = pgTable("cas_push_registrations", {
  id: text("id").primaryKey(),
  deviceCredentialId: text("device_credential_id").notNull().unique()
    .references(() => casDeviceCredentials.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One bounded evidence artifact (audio clip, still photo, or video clip)
 * captured on the handset and uploaded with the device credential, attached
 * to its incident with the device-reported capture time. Bytes live in the
 * row: clips are short and bounded by design, and database storage keeps the
 * evidence journal inspectable in one place with no extra file service.
 * Metadata is always selected with explicit columns so listing never drags
 * the blob along.
 */
export const casEvidence = pgTable("cas_evidence", {
  id: text("id").primaryKey(),
  // Cascade: app code never deletes incidents, but test suites and disposable
  // review databases do — evidence must not make an incident undeletable.
  incidentId: text("incident_id").notNull().references(() => casIncidents.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  requestId: text("request_id"),
  sequence: integer("sequence").notNull().default(1),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
