import { z } from 'zod';
import type { ActiveIncident, Gate, Incident, SetupItem } from '@/hooks/use-field-test';

/**
 * Console-side mirror of the API's GET /api/cas/state response contract
 * (artifacts/api-server/src/lib/cas-readiness-schema.ts —
 * casStateResponseSchema). The console used to blind-cast the response
 * (`await response.json() as Omit<FieldTestState, 'fieldRun'>`), so a
 * console talking to an older/newer server (stale deployment, mixed
 * environments) silently rendered garbage or dropped readiness data.
 * load()/reload() in use-field-test.tsx parse every state response through
 * casStateResponseSchema instead and surface CasStateShapeError visibly.
 *
 * Drift guards, in both directions:
 *  - compile time: the assertions at the bottom of this file pin the
 *    inferred payload type to the console's Gate/SetupItem/Incident/
 *    ActiveIncident types, so editing one side without the other is a
 *    typecheck failure;
 *  - CI: the api-server parity test (cas-readiness-schema.test.ts) compares
 *    those console types against the server-side schemas, so this mirror
 *    and the server schema cannot drift apart without a red check.
 */

/** Thrown when the server's state response does not match this console's contract. */
export class CasStateShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CasStateShapeError';
  }
}

const prioritySchema = z.enum(['P1', 'P2', 'P3']);

const gateSchema = z.object({
  id: z.string(),
  index: z.string(),
  name: z.string(),
  short: z.string(),
  status: z.enum(['verified', 'partial', 'blocked', 'not-started']),
  criterion: z.string(),
  evidence: z.array(z.string()),
  nextAction: z.string(),
  owner: z.string(),
}).strict();

const setupSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  group: z.string(),
  complete: z.boolean(),
  mode: z.enum(['owner', 'measured']),
}).strict();

const incidentRowSchema = z.object({
  id: z.string(),
  priority: prioritySchema,
  time: z.string(),
  title: z.string(),
  detail: z.string(),
  state: z.string(),
  source: z.string(),
  sample: z.boolean(),
}).strict();

const kernelEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  priority: prioritySchema,
  time: z.string(),
  detail: z.string(),
}).strict();

const outboxItemSchema = z.object({
  id: z.string(),
  transport: z.enum(['SMS', 'XMPP', 'WHATSAPP', 'EMAIL']),
  state: z.enum(['QUEUED', 'PROCESSING', 'FAILED', 'SENT', 'DEAD_LETTER']),
  priority: z.enum(['P1', 'P2']),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  deliveredTo: z.string().nullable(),
  terminal: z.boolean(),
}).strict();

const incidentLocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  accuracyM: z.number(),
  capturedAt: z.string(),
}).strict();

const evidenceItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['audio', 'photo', 'video']),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  sequence: z.number().int(),
  capturedAt: z.string().nullable(),
  uploadedAt: z.string(),
  requestId: z.string().nullable(),
}).strict();

const captureRequestItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['audio', 'photo', 'video']),
  state: z.enum(['PENDING', 'STARTED', 'COMPLETED', 'FAILED']),
  detail: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

const activeIncidentSchema = z.object({
  id: z.string(),
  status: z.enum(['INACTIVE', 'ACTIVE_UNACKED', 'ACTIVE_ACKED', 'RESOLVED']),
  priority: prioritySchema,
  triggerCount: z.number().int(),
  createdAt: z.string(),
  location: incidentLocationSchema.nullable(),
  events: z.array(kernelEventSchema),
  outbox: z.array(outboxItemSchema),
  evidence: z.array(evidenceItemSchema),
  captureRequests: z.array(captureRequestItemSchema),
}).strict();

export const casStateResponseSchema = z.object({
  gates: z.array(gateSchema),
  setup: z.array(setupSchema),
  incidents: z.array(incidentRowSchema),
  activeIncident: activeIncidentSchema.nullable(),
}).strict();

export type CasRemoteState = z.infer<typeof casStateResponseSchema>;

/**
 * Builds the drift error every server-response parser throws, naming the
 * endpoint family and the first offending path, so a stale or mismatched
 * server build always produces the same clear, actionable message — whether
 * the drifted payload was the state mirror, the outbox status, or config.
 */
export function casResponseShapeError(label: string, error: z.ZodError): CasStateShapeError {
  const issue = error.issues[0];
  const path = issue && issue.path.length > 0 ? issue.path.join('.') : '(top level)';
  const detail = issue ? `${path}: ${issue.message}` : 'unknown validation failure';
  return new CasStateShapeError(
    `The server's ${label} response does not match what this console expects (${detail}). The server may be running a different version than this console; refresh once, and if it persists redeploy the matching server build.`,
  );
}

/**
 * Parses a GET /api/cas/state JSON body. Throws CasStateShapeError — with
 * the first offending path — when the server speaks a shape this console
 * was not built against, so the caller can show the mismatch surface
 * instead of rendering partial/garbage data.
 */
export function parseCasStateResponse(body: unknown): CasRemoteState {
  const result = casStateResponseSchema.safeParse(body);
  if (!result.success) throw casResponseShapeError('state', result.error);
  return result.data;
}

// Compile-time lockstep with the console's state types: assigning in both
// directions fails typecheck the moment the mirror schema and the hook's
// Gate/SetupItem/Incident/ActiveIncident declarations disagree.
type ConsoleRemoteState = {
  gates: Gate[];
  setup: SetupItem[];
  incidents: Incident[];
  activeIncident: ActiveIncident | null;
};
const _schemaMatchesConsole: ConsoleRemoteState = null as unknown as CasRemoteState;
const _consoleMatchesSchema: CasRemoteState = null as unknown as ConsoleRemoteState;
void _schemaMatchesConsole;
void _consoleMatchesSchema;
