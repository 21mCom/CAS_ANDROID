/**
 * In-process heartbeat for the CAS outbox delivery worker.
 *
 * The worker (lib/cas-outbox-worker.ts) records every tick here; the
 * /api/cas/outbox/status route (routes/cas.ts) reads it. Keeping the registry
 * in its own module avoids a circular import between the worker and the
 * router, which already depend on each other's exports.
 *
 * This is process-local on purpose: it reports the health of the worker loop
 * running inside this server process, which is exactly what responders need
 * to know ("is the pipeline in this deployment still draining?").
 */

export interface CasOutboxTickSummary {
  claimed: number;
  sent: number;
  failed: number;
  deadLettered: number;
}

export interface CasOutboxWorkerHeartbeat {
  workerId: string;
  /** Configured drain interval in milliseconds. */
  intervalMs: number;
  /** Configured per-tick batch cap. */
  batchSize: number;
  /** ISO timestamps — serialized ready for the status endpoint. */
  startedAt: string;
  lastTickAt: string | null;
  lastTickDurationMs: number | null;
  ticksCompleted: number;
  lastTick: CasOutboxTickSummary | null;
  /** Most recent tick-level failure (adapter/DB error caught by the loop). */
  lastError: { message: string; at: string } | null;
  stoppedAt: string | null;
}

let heartbeat: CasOutboxWorkerHeartbeat | null = null;

export function registerCasOutboxWorkerHeartbeat(init: {
  workerId: string;
  intervalMs: number;
  batchSize: number;
}): void {
  heartbeat = {
    workerId: init.workerId,
    intervalMs: init.intervalMs,
    batchSize: init.batchSize,
    startedAt: new Date().toISOString(),
    lastTickAt: null,
    lastTickDurationMs: null,
    ticksCompleted: 0,
    lastTick: null,
    lastError: null,
    stoppedAt: null,
  };
}

export function recordCasOutboxTick(tick: {
  durationMs: number;
  result: CasOutboxTickSummary;
}): void {
  if (!heartbeat) return;
  heartbeat.lastTickAt = new Date().toISOString();
  heartbeat.lastTickDurationMs = tick.durationMs;
  heartbeat.ticksCompleted += 1;
  heartbeat.lastTick = tick.result;
}

export function recordCasOutboxTickError(message: string): void {
  if (!heartbeat) return;
  heartbeat.lastTickAt = new Date().toISOString();
  heartbeat.lastError = { message, at: heartbeat.lastTickAt };
}

export function markCasOutboxWorkerStopped(): void {
  if (!heartbeat) return;
  heartbeat.stoppedAt = new Date().toISOString();
}

export function getCasOutboxWorkerHeartbeat(): CasOutboxWorkerHeartbeat | null {
  return heartbeat ? { ...heartbeat } : null;
}

/** Test-only: clears the registry so worker tests do not leak state. */
export function resetCasOutboxWorkerHeartbeat(): void {
  heartbeat = null;
}
