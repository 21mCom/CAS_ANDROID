import { z } from "zod";

/**
 * Readiness payload validation, shared between the CAS routes
 * (POST /api/cas/bootstrap, PATCH /api/cas/setup/:id, PATCH /api/cas/gates/:id)
 * and the console parity test (cas-readiness-schema.test.ts).
 *
 * The console's Gate/SetupItem types and its initialGates/initialSetup seed
 * fixtures (artifacts/covert-alert-system/src/hooks/use-field-test.tsx) must
 * drift together with these schemas: the parity test reads the console source
 * and fails CI when the field sets, enum values, seed fixtures, or PATCH
 * payload keys disagree with what these routes accept — the same lockstep
 * precedent as gate0a-report.ts for the harness/app report contract.
 *
 * updatedAt is server-managed, and unknown keys are stripped rather than
 * rejected so a newer console can still seed an older API.
 */
export const bootstrapGateSchema = z.object({
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

export const bootstrapSetupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string(),
  group: z.string(),
  complete: z.boolean().default(false),
  mode: z.enum(["owner", "measured"]),
});

export const bootstrapSchema = z.object({
  gates: z.array(bootstrapGateSchema),
  setup: z.array(bootstrapSetupSchema),
});

/** PATCH /cas/setup/:id — the console's toggleSetupItem payload. */
export const setupPatchSchema = z.object({
  complete: z.boolean(),
});

/** PATCH /cas/gates/:id — the console's updateGateStatus payload. */
export const gatePatchSchema = z.object({
  status: z.enum(["verified", "partial", "blocked", "not-started"]),
});

/**
 * GET /api/cas/state response contract — the read direction of the
 * console/API parity guard. The console blind-casts this response
 * (`await response.json() as Omit<FieldTestState, 'fieldRun'>` in the
 * load()/reload() functions of use-field-test.tsx), so a renamed field or
 * changed enum value would render garbage instead of failing loudly.
 *
 * These schemas mirror the console's Incident/ActiveIncident/KernelEvent/
 * OutboxItem/IncidentLocation types; the parity test
 * (cas-readiness-schema.test.ts) compares them against the console's type
 * declarations, and the route contract test (routes/cas.test.ts) validates
 * the live JSON of a seeded incident against casStateResponseSchema.
 * Changing either side without the other produces a red check.
 *
 * Gates and setup entries are serialized by the route with exactly the
 * bootstrap seed fields, so the response reuses those schemas. Every object
 * is strict so an added-but-unmirrored field is as red as a renamed one.
 */
export const casPrioritySchema = z.enum(["P1", "P2", "P3"]);

export const kernelStatusSchema = z.enum(["INACTIVE", "ACTIVE_UNACKED", "ACTIVE_ACKED", "RESOLVED"]);

export const stateGateSchema = bootstrapGateSchema.strict();

export const stateSetupSchema = bootstrapSetupSchema.strict();

/** One row of the state's incident list (the console's Incident type). */
export const stateIncidentRowSchema = z.object({
  id: z.string(),
  priority: casPrioritySchema,
  time: z.string(),
  title: z.string(),
  detail: z.string(),
  state: z.string(),
  source: z.string(),
  sample: z.boolean(),
}).strict();

export const kernelEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  priority: casPrioritySchema,
  time: z.string(),
  detail: z.string(),
}).strict();

export const outboxItemSchema = z.object({
  id: z.string(),
  transport: z.enum(["SMS", "XMPP", "WHATSAPP", "EMAIL"]),
  // LOST is only an ephemeral worker-result label, never a persisted outbox
  // state, so it is deliberately absent here and in the console union.
  state: z.enum(["QUEUED", "PROCESSING", "FAILED", "SENT", "DEAD_LETTER"]),
  priority: z.enum(["P1", "P2"]),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  terminal: z.boolean(),
}).strict();

export const incidentLocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  accuracyM: z.number(),
  capturedAt: z.string(),
}).strict();

export const activeIncidentSchema = z.object({
  id: z.string(),
  status: kernelStatusSchema,
  priority: casPrioritySchema,
  triggerCount: z.number().int(),
  createdAt: z.string(),
  location: incidentLocationSchema.nullable(),
  events: z.array(kernelEventSchema),
  outbox: z.array(outboxItemSchema),
}).strict();

export const casStateResponseSchema = z.object({
  gates: z.array(stateGateSchema),
  setup: z.array(stateSetupSchema),
  incidents: z.array(stateIncidentRowSchema),
  activeIncident: activeIncidentSchema.nullable(),
}).strict();
