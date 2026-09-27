import { AlertTriangle, ArrowRight, CheckCircle2, RadioTower } from 'lucide-react';
import { Link } from 'wouter';
import { useOutboxStatus } from '@/hooks/use-outbox-status';
import { SectionKicker } from '@/components/field-ui';
import { deriveOutboxWarnings, outboxAgeLabel as ageLabel } from '@/lib/outbox-warnings';

type StatusSnapshot = ReturnType<typeof useOutboxStatus>['status'];

/**
 * Compact stalled-pipeline warning for pages other than /incidents (e.g. the
 * overview). Renders nothing while the pipeline is healthy so a quiet overview
 * stays quiet; the moment the outbox dead-letters or gets stuck, a responder
 * landing anywhere sees it and can jump straight to the incidents panel.
 */
export function OutboxStatusBanner() {
  const { status, unreachable } = useOutboxStatus();
  const nowMs = Date.now();
  const warnings = deriveOutboxWarnings({ status, unreachable, nowMs });

  if (warnings.length === 0) return null;

  const worst = warnings.some((warning) => warning.severity === 'danger') ? 'danger' : 'caution';
  return (
    <section
      className={`fade-up mt-5 border px-4 py-3 ${
        worst === 'danger' ? 'border-[#e7b8af] bg-[#f8e0db]' : 'border-[#e8c880] bg-[#fff8e7]'
      }`}
      data-testid="outbox-status-banner"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          {warnings.map((warning) => (
            <p
              key={warning.message}
              className={`flex items-start gap-2 text-xs leading-5 ${
                warning.severity === 'danger' ? 'font-bold text-[#914136]' : 'text-[#765013]'
              }`}
              data-testid={`outbox-banner-warning-${warning.severity}`}
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{warning.message}</span>
            </p>
          ))}
        </div>
        <Link
          href="/incidents"
          className={`inline-flex shrink-0 items-center gap-1 text-xs font-bold ${
            worst === 'danger' ? 'text-[#914136]' : 'text-[#a06712]'
          }`}
          data-testid="link-outbox-banner-incidents"
        >
          Open delivery pipeline <ArrowRight size={13} />
        </Link>
      </div>
    </section>
  );
}

/**
 * Operator-visible delivery pipeline health. Counts come from the durable
 * outbox (not logs), so dead-lettered deliveries are visible at a glance and
 * a stalled worker shows up as a warning banner instead of a silent queue.
 */
export function OutboxStatusPanel() {
  const { status, unreachable } = useOutboxStatus();
  return <OutboxStatusView status={status} unreachable={unreachable} nowMs={Date.now()} />;
}

/**
 * Pure presentational half of the panel, split out so the warning banners
 * (especially the red dead-letter alarm) can be render-tested without the
 * polling hook.
 */
export function OutboxStatusView({ status, unreachable, nowMs }: {
  status: StatusSnapshot;
  unreachable: boolean;
  nowMs: number;
}) {
  const warnings = deriveOutboxWarnings({ status, unreachable, nowMs });

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
