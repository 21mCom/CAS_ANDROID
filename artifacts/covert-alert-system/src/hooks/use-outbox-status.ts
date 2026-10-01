import { useEffect, useState } from 'react';
import { CasStateShapeError } from '@/lib/cas-state-schema';
import { parseCasOutboxStatusResponse } from '@/lib/cas-outbox-status-schema';
import { casStoredDeviceToken } from './use-field-test';

export type OutboxStateCounts = {
  QUEUED: number;
  PROCESSING: number;
  FAILED: number;
  SENT: number;
  DEAD_LETTER: number;
  WITHDRAWN: number;
};

export type OutboxWorkerHeartbeat = {
  workerId: string;
  intervalMs: number;
  batchSize: number;
  startedAt: string;
  lastTickAt: string | null;
  lastTickDurationMs: number | null;
  ticksCompleted: number;
  lastTick: { claimed: number; sent: number; failed: number; deadLettered: number } | null;
  lastError: { message: string; at: string } | null;
  stoppedAt: string | null;
};

/**
 * The email channel's mailbox probe health. The mailbox app password can
 * silently rot; the server probes it (AUTH only, nothing sent) on a slow
 * schedule and this is the last outcome. Null when the server's probe
 * worker has not started.
 */
export type EmailChannelHealth = {
  probeIntervalMs: number;
  startedAt: string;
  state: 'pending' | 'ok' | 'failed' | 'skipped';
  target: 'console' | 'environment' | 'none';
  lastProbeAt: string | null;
  lastOkAt: string | null;
  lastFailure: { classification: string; message: string; at: string } | null;
  note: string | null;
  stoppedAt: string | null;
};

export type OutboxStatus = {
  counts: OutboxStateCounts;
  oldestPendingAt: string | null;
  lastDeliveryError: { transport: string; state: string; attempts: number; message: string } | null;
  /** Who delivers SMS: the worker ("gateway") or the alerting handset ("device"). */
  smsDeliveryMode: 'gateway' | 'device';
  /** Transports the handset delivers itself in device mode. */
  deviceChannels: Array<'SMS'>;
  /** False while the handset endpoints are closed (CAS_DEVICE_TOKEN unset). */
  deviceAuthConfigured: boolean;
  worker: OutboxWorkerHeartbeat | null;
  email: EmailChannelHealth | null;
};

/**
 * One poll of the status endpoint, validated against the console's mirror
 * of the server contract before any of it is applied: a drifted server
 * (stale deployment, mixed environments) throws CasStateShapeError instead
 * of letting the console render partial/garbage pipeline health.
 */
export async function requestOutboxStatus(fetchImpl: typeof fetch, token: string): Promise<OutboxStatus> {
  const response = await fetchImpl('/api/cas/outbox/status', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error('Unable to load outbox status');
  // A 200 whose body is not even JSON is drift, not an outage.
  const body: unknown = await response.json().catch(() => {
    throw new CasStateShapeError("The server's outbox status response is not valid JSON. The server may be running a different version than this console; refresh once, and if it persists redeploy the matching server build.");
  });
  return parseCasOutboxStatusResponse(body);
}

/**
 * Routes a failed poll: a drifted response is a version mismatch (the
 * server answered, but in a shape this console was not built against);
 * anything else means the console lost sight of the pipeline entirely.
 */
export function outboxPollFailure(error: unknown): { unreachable: boolean; mismatch: string | null } {
  if (error instanceof CasStateShapeError) return { unreachable: false, mismatch: error.message };
  return { unreachable: true, mismatch: null };
}

/**
 * Polls the outbox pipeline health endpoint so responders can see whether
 * queued alerts are actually draining, without opening server logs.
 * Polls slightly slower than the worker's default 10s drain interval.
 */
export function useOutboxStatus(pollMs = 12_000): { status: OutboxStatus | null; unreachable: boolean; mismatch: string | null } {
  const [status, setStatus] = useState<OutboxStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [mismatch, setMismatch] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // The status endpoint is credential-gated like every other incident
        // read. Until this browser has enrolled (the state load opens the
        // enrollment dialog), skip the tick quietly instead of prompting
        // twice or flagging a false outage; the next poll picks the
        // credential up from this browser's credential storage.
        const token = casStoredDeviceToken();
        if (!token) return;
        const parsed = await requestOutboxStatus(fetch, token);
        if (!cancelled) {
          setStatus(parsed);
          setUnreachable(false);
          setMismatch(null);
        }
      } catch (error) {
        if (cancelled) return;
        const failure = outboxPollFailure(error);
        setUnreachable(failure.unreachable);
        setMismatch(failure.mismatch);
        if (failure.mismatch) {
          // Never render pipeline health from a drifted contract — drop the
          // last snapshot so only the mismatch warning is shown. For a plain
          // outage, keep the last good snapshot but flag that the console
          // lost sight of the pipeline — that itself is a
          // delivery-visibility problem.
          setStatus(null);
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  return { status, unreachable, mismatch };
}
