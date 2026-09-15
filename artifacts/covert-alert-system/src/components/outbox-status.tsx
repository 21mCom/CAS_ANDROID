import { AlertTriangle, CheckCircle2, RadioTower } from 'lucide-react';
import { useOutboxStatus } from '@/hooks/use-outbox-status';
import { SectionKicker } from '@/components/field-ui';

// A P1 alert is expected to reach a provider within seconds; anything still
// pending after five minutes means the pipeline is stuck, not just retrying.
const STUCK_PENDING_MS = 5 * 60 * 1000;

function ageLabel(iso: string, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - new Date(iso).getTime());
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes >= 1) return `${minutes} min ago`;
  return `${Math.floor(ageMs / 1000)}s ago`;
}

type Warning = { severity: 'danger' | 'caution'; message: string };

function deriveWarnings({ status, unreachable, nowMs }: {
  status: ReturnType<typeof useOutboxStatus>['status'];
  unreachable: boolean;
  nowMs: number;
}): Warning[] {
  if (unreachable) {
    return [{ severity: 'caution', message: 'The console cannot reach the delivery status endpoint — pipeline health is unknown.' }];
  }
  if (!status) return [];

  const warnings: Warning[] = [];
  const { counts, oldestPendingAt, worker, lastDeliveryError } = status;
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
    warnings.push({ severity: 'danger', message: `The delivery worker stopped ${ageLabel(worker.stoppedAt, nowMs)}; queued alerts will not be delivered.` });
  } else {
    const lastActivity = worker.lastTickAt ?? worker.startedAt;
    const staleMs = Math.max(worker.intervalMs * 3, 30_000);
    if (nowMs - new Date(lastActivity).getTime() > staleMs) {
      warnings.push({ severity: 'caution', message: `No delivery tick for over ${Math.floor((nowMs - new Date(lastActivity).getTime()) / 1000)}s (expected every ${Math.round(worker.intervalMs / 1000)}s).` });
    }
    if (worker.lastError) {
      warnings.push({ severity: 'caution', message: `Last worker tick error ${ageLabel(worker.lastError.at, nowMs)}: ${worker.lastError.message}` });
    }
  }
  return warnings;
}

/**
 * Operator-visible delivery pipeline health. Counts come from the durable
 * outbox (not logs), so dead-lettered deliveries are visible at a glance and
 * a stalled worker shows up as a warning banner instead of a silent queue.
 */
export function OutboxStatusPanel() {
  const { status, unreachable } = useOutboxStatus();
  const nowMs = Date.now();
  const warnings = deriveWarnings({ status, unreachable, nowMs });

  if (!status && !unreachable) return null;

  const counts = status?.counts;
  const worker = status?.worker;
  const stateCells: { key: keyof NonNullable<typeof counts>; label: string; tone: string }[] = [
    { key: 'QUEUED', label: 'Queued', tone: 'text-[#687271]' },
    { key: 'PROCESSING', label: 'Sending', tone: 'text-[#687271]' },
    { key: 'FAILED', label: 'Retrying', tone: 'text-[#a06712]' },
    { key: 'SENT', label: 'Sent', tone: 'text-[#236047]' },
    { key: 'DEAD_LETTER', label: 'Dead letter', tone: counts && counts.DEAD_LETTER > 0 ? 'font-bold text-[#914136]' : 'text-[#687271]' },
  ];

  return (
    <section className="fade-up mt-5 border border-[#d7d8d0] bg-[#fbfbf7]" data-testid="outbox-status-panel">
      <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <RadioTower size={15} className="text-[#203c49]" />
            <SectionKicker>Alert delivery pipeline</SectionKicker>
          </div>
          {counts && (
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2" data-testid="outbox-status-counts">
              {stateCells.map((cell) => (
                <span key={cell.key} className={`font-mono-ui text-[11px] uppercase tracking-[0.1em] ${cell.tone}`}>
                  {cell.label}: <strong data-testid={`outbox-count-${cell.key.toLowerCase().replace('_', '-')}`}>{counts[cell.key]}</strong>
                </span>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs leading-5 text-[#687271]">
            {worker
              ? `Worker ${worker.workerId.slice(0, 18)}… drains every ${Math.round(worker.intervalMs / 1000)}s, up to ${worker.batchSize} per tick · ${worker.ticksCompleted} tick${worker.ticksCompleted === 1 ? '' : 's'} completed${worker.lastTickAt ? ` · last tick ${ageLabel(worker.lastTickAt, nowMs)}` : ' · no tick yet'}`
              : unreachable
                ? 'Delivery status endpoint unreachable.'
                : 'No worker heartbeat recorded by this server yet.'}
          </p>
        </div>
        <div className="w-full max-w-xl space-y-2" data-testid="outbox-status-warnings">
          {warnings.length === 0 ? (
            <div className="flex items-center gap-2 border border-[#b9d8c5] bg-[#e1efe5] px-3 py-2 text-xs font-bold text-[#236047]" data-testid="outbox-status-healthy">
              <CheckCircle2 size={14} /> Pipeline draining normally
            </div>
          ) : (
            warnings.map((warning) => (
              <div
                key={warning.message}
                className={`flex items-start gap-2 border px-3 py-2 text-xs leading-5 ${
                  warning.severity === 'danger'
                    ? 'border-[#e7b8af] bg-[#f8e0db] font-bold text-[#914136]'
                    : 'border-[#e8c880] bg-[#fff8e7] text-[#765013]'
                }`}
                data-testid={`outbox-status-warning-${warning.severity}`}
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{warning.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
