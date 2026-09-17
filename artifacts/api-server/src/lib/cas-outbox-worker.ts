import { randomUUID } from "node:crypto";
import {
  processCasOutbox,
  type CasOutboxWorkerResult,
} from "../routes/cas";
import { logger } from "./logger";
import {
  markCasOutboxWorkerStopped,
  recordCasOutboxTick,
  recordCasOutboxTickError,
  registerCasOutboxWorkerHeartbeat,
} from "./cas-outbox-status";

export const DEFAULT_CAS_OUTBOX_INTERVAL_MS = 10_000;
export const DEFAULT_CAS_OUTBOX_BATCH_SIZE = 10;

type CasOutboxLogger = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export interface CasOutboxWorkerOptions {
  /** Milliseconds between drain attempts. Defaults to CAS_OUTBOX_INTERVAL_MS or 10s. */
  intervalMs?: number;
  /** Maximum outbox items claimed per tick. Defaults to CAS_OUTBOX_BATCH_SIZE or 10. */
  maxItemsPerTick?: number;
  workerId?: string;
  log?: CasOutboxLogger;
  /** Overridable tick body, for tests. Defaults to processCasOutbox. */
  runTick?: (opts: {
    workerId: string;
    maxItems: number;
  }) => Promise<CasOutboxWorkerResult>;
}

export interface CasOutboxWorkerHandle {
  /** Clears the interval and waits for any in-flight tick to settle. */
  stop: () => Promise<void>;
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} value: "${raw}" (expected a positive integer)`);
  }
  return value;
}

/**
 * Runs the CAS outbox drain on a bounded interval so queued alerts actually
 * reach the configured SMS/XMPP providers in the deployed server — not just
 * in tests. The loop is supervised:
 *
 * - Ticks never overlap: a tick still in flight when the interval fires is
 *   skipped rather than stacked.
 * - A tick that throws (DB hiccup, adapter crash) is logged and the loop
 *   continues; the processCasOutbox lease reclaims abandoned claims.
 * - stop() clears the interval and awaits the in-flight tick, so server
 *   shutdown leaves no dangling timers or half-written deliveries.
 *
 * The interval defaults to 10s — well under the 30s delivery lease — and the
 * per-tick batch is capped, so a single tick has a bounded blast radius.
 */
export function startCasOutboxWorker(
  options: CasOutboxWorkerOptions = {},
): CasOutboxWorkerHandle {
  const intervalMs =
    options.intervalMs ??
    readPositiveIntEnv("CAS_OUTBOX_INTERVAL_MS") ??
    DEFAULT_CAS_OUTBOX_INTERVAL_MS;
  const maxItemsPerTick =
    options.maxItemsPerTick ??
    readPositiveIntEnv("CAS_OUTBOX_BATCH_SIZE") ??
    DEFAULT_CAS_OUTBOX_BATCH_SIZE;
  const workerId = options.workerId ?? `cas-outbox-loop-${randomUUID()}`;
  const log = options.log ?? logger;
  const runTick = options.runTick ?? processCasOutbox;

  let running = false;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  // Publish the worker's configuration immediately so the status endpoint can
  // report the drain interval and batch size even before the first tick.
  registerCasOutboxWorkerHeartbeat({
    workerId,
    intervalMs,
    batchSize: maxItemsPerTick,
  });

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    const tickStartedAt = Date.now();
    try {
      const result = await runTick({ workerId, maxItems: maxItemsPerTick });
      recordCasOutboxTick({
        durationMs: Date.now() - tickStartedAt,
        result: {
          claimed: result.claimed,
          sent: result.sent,
          failed: result.failed,
          deadLettered: result.deadLettered,
        },
      });
      if (result.claimed > 0) {
        log.info(
          {
            workerId: result.workerId,
            claimed: result.claimed,
            sent: result.sent,
            failed: result.failed,
            deadLettered: result.deadLettered,
          },
          "CAS outbox tick completed",
        );
      }
    } catch (error) {
      // Never let an adapter/DB error kill the loop or the server.
      recordCasOutboxTickError(
        error instanceof Error ? error.message : String(error),
      );
      log.error({ err: error, workerId }, "CAS outbox tick failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    if (!inFlight) {
      inFlight = tick().finally(() => {
        inFlight = null;
      });
    }
  }, intervalMs);
  // The worker must never keep the process alive on its own.
  timer.unref();

  log.info(
    { workerId, intervalMs, maxItemsPerTick },
    "CAS outbox delivery worker started",
  );

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (inFlight) {
        await inFlight.catch(() => {
          /* tick errors are already logged inside tick() */
        });
      }
      markCasOutboxWorkerStopped();
      log.info({ workerId }, "CAS outbox delivery worker stopped");
    },
  };
}
