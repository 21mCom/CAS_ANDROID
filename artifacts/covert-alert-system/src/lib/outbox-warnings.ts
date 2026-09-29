import type { OutboxStatus } from '@/hooks/use-outbox-status';

// A P1 alert is expected to reach a provider within seconds; anything still
// pending after five minutes means the pipeline is stuck, not just retrying.
export const STUCK_PENDING_MS = 5 * 60 * 1000;

export type OutboxWarning = { severity: 'danger' | 'caution'; message: string };

export function outboxAgeLabel(iso: string, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - new Date(iso).getTime());
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes >= 1) return `${minutes} min ago`;
  return `${Math.floor(ageMs / 1000)}s ago`;
}

/**
 * Single source of truth for "is the delivery pipeline in trouble?" — used by
 * both the full status panel on /incidents and the compact overview banner so
 * the two surfaces can never disagree about what counts as a stalled pipeline.
 */
export function deriveOutboxWarnings({ status, unreachable, mismatch, nowMs }: {
  status: OutboxStatus | null;
  unreachable: boolean;
  mismatch: string | null;
  nowMs: number;
}): OutboxWarning[] {
  // A drifted status response outranks every other signal: any counts or
  // heartbeat the console might still hold predate a contract the server
  // no longer speaks, so the only honest message is the mismatch itself.
  if (mismatch) {
    return [{ severity: 'danger', message: mismatch }];
  }
  if (unreachable) {
    return [{ severity: 'caution', message: 'The console cannot reach the delivery status endpoint — pipeline health is unknown.' }];
  }
  if (!status) return [];

  const warnings: OutboxWarning[] = [];
  const { counts, oldestPendingAt, worker, lastDeliveryError, email } = status;
  const pending = counts.QUEUED + counts.PROCESSING + counts.FAILED;

  if (counts.DEAD_LETTER > 0) {
    warnings.push({
      severity: 'danger',
      message: `${counts.DEAD_LETTER} ${counts.DEAD_LETTER === 1 ? 'delivery has' : 'deliveries have'} been abandoned (dead letter) — the provider kept rejecting ${counts.DEAD_LETTER === 1 ? 'it' : 'them'} and no further retries will be made.${lastDeliveryError ? ` Last error (${lastDeliveryError.transport}): ${lastDeliveryError.message}` : ''}`,
    });
  }
  if (pending > 0 && oldestPendingAt && nowMs - new Date(oldestPendingAt).getTime() > STUCK_PENDING_MS) {
    warnings.push({
      severity: 'danger',
      message: `${pending} ${pending === 1 ? 'alert is' : 'alerts are'} still waiting; the oldest has been pending for over ${Math.floor((nowMs - new Date(oldestPendingAt).getTime()) / 60_000)} minutes.`,
    });
  }
  if (!worker) {
    warnings.push({ severity: 'caution', message: 'The delivery worker has not reported a heartbeat from this server — queued alerts may never be sent.' });
  } else if (worker.stoppedAt) {
    warnings.push({ severity: 'danger', message: `The delivery worker stopped ${outboxAgeLabel(worker.stoppedAt, nowMs)}; queued alerts will not be delivered.` });
  } else {
    const lastActivity = worker.lastTickAt ?? worker.startedAt;
    const staleMs = Math.max(worker.intervalMs * 3, 30_000);
    if (nowMs - new Date(lastActivity).getTime() > staleMs) {
      warnings.push({ severity: 'caution', message: `No delivery tick for over ${Math.floor((nowMs - new Date(lastActivity).getTime()) / 1000)}s (expected every ${Math.round(worker.intervalMs / 1000)}s).` });
    }
    if (worker.lastError) {
      warnings.push({ severity: 'caution', message: `Last worker tick error ${outboxAgeLabel(worker.lastError.at, nowMs)}: ${worker.lastError.message}` });
    }
  }

  // Email channel: the mailbox app password can silently rot, so the server
  // probes it (AUTH only — nothing is sent) on a slow schedule. A failed
  // probe is the early warning that would otherwise arrive as a
  // dead-lettered alert during a real incident.
  if (email) {
    if (email.state === 'failed') {
      const failure = email.lastFailure;
      const when = email.lastProbeAt ? ` ${outboxAgeLabel(email.lastProbeAt, nowMs)}` : '';
      // Authentication/not-configured/rejected mean the mailbox itself is
      // refusing — no retry will fix those; the rest may be transient.
      const permanent =
        failure !== null &&
        (failure.classification === 'authentication' ||
          failure.classification === 'not-configured' ||
          failure.classification === 'rejected');
      warnings.push(
        permanent
          ? {
              severity: 'danger',
              message: `The email alert mailbox failed its scheduled login check${when}: ${failure?.message ?? 'credentials refused'}. Email alerts will not go out until the mailbox is fixed — check the Email delivery page or the CAS_EMAIL_SMTP_* settings.`,
            }
          : {
              severity: 'caution',
              message: `The email alert mailbox could not be reached for its scheduled login check${when}: ${failure?.message ?? 'probe failed'}. If this persists, email alerts may not go out.`,
            },
      );
    } else if (email.stoppedAt) {
      warnings.push({ severity: 'caution', message: `The email mailbox probe stopped ${outboxAgeLabel(email.stoppedAt, nowMs)}; a dead mailbox would go unnoticed until an alert fails.` });
    } else if (email.state !== 'pending') {
      const lastProbe = email.lastProbeAt ?? email.startedAt;
      if (nowMs - new Date(lastProbe).getTime() > email.probeIntervalMs * 1.5) {
        warnings.push({ severity: 'caution', message: `The email mailbox login check is overdue (last ran ${outboxAgeLabel(lastProbe, nowMs)}); a dead mailbox would go unnoticed.` });
      }
    }
  }
  return warnings;
}
