import { z } from 'zod';
import { casResponseShapeError } from '@/lib/cas-state-schema';
import type { OutboxStatus } from '@/hooks/use-outbox-status';

/**
 * Console-side mirror of the API's GET /api/cas/outbox/status response
 * contract (artifacts/api-server/src/routes/cas.ts — the route assembles
 * counts, oldestPendingAt, lastDeliveryError, smsDeliveryMode,
 * deviceChannels, deviceAuthConfigured, and the worker heartbeat). The
 * polling hook used to blind-cast the body (`await response.json() as
 * OutboxStatus`), so a drifted server (stale deployment, mixed
 * environments) silently rendered wrong pipeline health — the exact signal
 * responders rely on to know whether alerts are draining.
 * useOutboxStatus parses every poll through casOutboxStatusResponseSchema
 * and surfaces the mismatch as a visible panel/banner warning instead.
 *
 * The compile-time assertions at the bottom pin the inferred payload type
 * to the hook's OutboxStatus declaration in both directions, so editing
 * one side without the other is a typecheck failure.
 */

const transportSchema = z.enum(['SMS', 'XMPP', 'WHATSAPP', 'EMAIL']);

const outboxStateCountsSchema = z.object({
  QUEUED: z.number().int(),
  PROCESSING: z.number().int(),
  FAILED: z.number().int(),
  SENT: z.number().int(),
  DEAD_LETTER: z.number().int(),
}).strict();

const workerHeartbeatSchema = z.object({
  workerId: z.string(),
  intervalMs: z.number(),
  batchSize: z.number(),
  startedAt: z.string(),
  lastTickAt: z.string().nullable(),
  lastTickDurationMs: z.number().nullable(),
  ticksCompleted: z.number().int(),
  lastTick: z.object({
    claimed: z.number().int(),
    sent: z.number().int(),
    failed: z.number().int(),
    deadLettered: z.number().int(),
  }).strict().nullable(),
  lastError: z.object({
    message: z.string(),
    at: z.string(),
  }).strict().nullable(),
  stoppedAt: z.string().nullable(),
}).strict();

export const casOutboxStatusResponseSchema = z.object({
  counts: outboxStateCountsSchema,
  oldestPendingAt: z.string().nullable(),
  lastDeliveryError: z.object({
    transport: z.string(),
    state: z.string(),
    attempts: z.number().int(),
    message: z.string(),
  }).strict().nullable(),
  smsDeliveryMode: z.enum(['gateway', 'device']),
  // Mirrors the server's DeviceChannel type ("SMS" only, today).
  deviceChannels: z.array(z.literal('SMS')),
  deviceAuthConfigured: z.boolean(),
  worker: workerHeartbeatSchema.nullable(),
}).strict();

export type CasOutboxStatusRemote = z.infer<typeof casOutboxStatusResponseSchema>;

/**
 * Parses a GET /api/cas/outbox/status JSON body. Throws CasStateShapeError
 * — with the first offending path — when the server speaks a shape this
 * console was not built against, so the polling hook can flag the mismatch
 * instead of rendering partial/garbage pipeline health.
 */
export function parseCasOutboxStatusResponse(body: unknown): CasOutboxStatusRemote {
  const result = casOutboxStatusResponseSchema.safeParse(body);
  if (!result.success) throw casResponseShapeError('outbox status', result.error);
  return result.data;
}

// Compile-time lockstep with the hook's OutboxStatus type: assigning in
// both directions fails typecheck the moment the mirror schema and the
// hook's declaration disagree.
const _schemaMatchesHook: OutboxStatus = null as unknown as CasOutboxStatusRemote;
const _hookMatchesSchema: CasOutboxStatusRemote = null as unknown as OutboxStatus;
void _schemaMatchesHook;
void _hookMatchesSchema;
