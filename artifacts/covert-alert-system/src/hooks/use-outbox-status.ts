import { useEffect, useState } from 'react';
import { casStoredDeviceToken } from './use-field-test';

export type OutboxStateCounts = {
  QUEUED: number;
  PROCESSING: number;
  FAILED: number;
  SENT: number;
  DEAD_LETTER: number;
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

export type OutboxStatus = {
  counts: OutboxStateCounts;
  oldestPendingAt: string | null;
  lastDeliveryError: { transport: string; state: string; attempts: number; message: string } | null;
  worker: OutboxWorkerHeartbeat | null;
};

/**
 * Polls the outbox pipeline health endpoint so responders can see whether
 * queued alerts are actually draining, without opening server logs.
 * Polls slightly slower than the worker's default 10s drain interval.
 */
export function useOutboxStatus(pollMs = 12_000): { status: OutboxStatus | null; unreachable: boolean } {
  const [status, setStatus] = useState<OutboxStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // The status endpoint is credential-gated like every other incident
        // read. Until this browser has enrolled (the state load prompts), skip
        // the tick quietly instead of prompting twice or flagging a false
        // outage; the next poll picks the credential up from sessionStorage.
        const token = casStoredDeviceToken();
        if (!token) return;
        const response = await fetch('/api/cas/outbox/status', {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error('Unable to load outbox status');
        const body = (await response.json()) as OutboxStatus;
        if (!cancelled) {
          setStatus(body);
          setUnreachable(false);
        }
      } catch {
        // Keep the last good snapshot but flag that the console lost sight of
        // the pipeline — that itself is a delivery-visibility problem.
        if (!cancelled) setUnreachable(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  return { status, unreachable };
}
