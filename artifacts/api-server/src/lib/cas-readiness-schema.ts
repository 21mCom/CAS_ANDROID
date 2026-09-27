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
