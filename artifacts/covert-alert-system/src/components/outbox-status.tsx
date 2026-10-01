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
  const { status, unreachable, mismatch } = useOutboxStatus();
  const nowMs = Date.now();
  const warnings = deriveOutboxWarnings({ status, unreachable, mismatch, nowMs });

  if (warnings.length === 0) return null;

  const worst = warnings.some((warning) => warning.severity === 'danger') ? 'danger' : 'caution';
  return (
    <section
      className={`fade-up mt-5 rounded-xl border px-4 py-3 ${
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
          Open alert delivery <ArrowRight size={13} />
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
  const { status, unreachable, mismatch } = useOutboxStatus();
  return <OutboxStatusView status={status} unreachable={unreachable} mismatch={mismatch} nowMs={Date.now()} />;
}

/**
 * Pure presentational half of the panel, split out so the warning banners
 * (especially the red dead-letter alarm) can be render-tested without the
 * polling hook.
 */
export function OutboxStatusView({ status, unreachable, mismatch, nowMs }: {
  status: StatusSnapshot;
  unreachable: boolean;
  mismatch: string | null;
  nowMs: number;
}) {
  const warnings = deriveOutboxWarnings({ status, unreachable, mismatch, nowMs });

  if (!status && !unreachable && !mismatch) return null;

  const counts = status?.counts;
  const worker = status?.worker;
  const stateCells: { key: keyof NonNullable<typeof counts>; label: string; tone: string }[] = [
    { key: 'QUEUED', label: 'Waiting', tone: 'text-[#687271]' },
    { key: 'PROCESSING', label: 'Sending', tone: 'text-[#687271]' },
    { key: 'FAILED', label: 'Retrying', tone: 'text-[#a06712]' },
    { key: 'SENT', label: 'Sent', tone: 'text-[#236047]' },
    { key: 'DEAD_LETTER', label: 'Couldn’t be delivered', tone: counts && counts.DEAD_LETTER > 0 ? 'font-bold text-[#914136]' : 'text-[#687271]' },
    { key: 'WITHDRAWN', label: 'Cancelled', tone: 'text-[#687271]' },
  ];

  return (
    <section className="fade-up mt-5 rounded-xl border border-[#d7d8d0] bg-[#fbfbf7]" data-testid="outbox-status-panel">
      <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <RadioTower size={15} className="text-[#203c49]" />
            <SectionKicker testId="kicker-alert-delivery-pipeline">Alert delivery</SectionKicker>
          </div>
          {counts && (
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2" data-testid="outbox-status-counts">
              {stateCells.map((cell) => (
                <span key={cell.key} className={`text-[12px] font-medium ${cell.tone}`}>
                  {cell.label}: <strong data-testid={`outbox-count-${cell.key.toLowerCase().replace('_', '-')}`}>{counts[cell.key]}</strong>
                </span>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs leading-5 text-[#687271]">
            {worker
              ? `Delivery checks run every ${Math.round(worker.intervalMs / 1000)}s, up to ${worker.batchSize} alerts each · ${worker.ticksCompleted} completed so far${worker.lastTickAt ? ` · last one ${ageLabel(worker.lastTickAt, nowMs)}` : ' · none run yet'}`
              : mismatch
                ? 'The server’s delivery status is in a format this console doesn’t recognize — delivery health is hidden until that’s resolved.'
                : unreachable
                  ? 'The console can’t reach the delivery status right now.'
                  : 'This server hasn’t reported any delivery activity yet.'}
          </p>
          {status?.email && (
            <p className="mt-1 text-xs leading-5 text-[#687271]" data-testid="outbox-email-health">
              {status.email.state === 'ok' && status.email.lastProbeAt
                ? `Email mailbox login checked ${ageLabel(status.email.lastProbeAt, nowMs)} — healthy · re-checks every ${Math.max(1, Math.round(status.email.probeIntervalMs / 86_400_000))}d`
                : status.email.state === 'failed' && status.email.lastProbeAt
                  ? `Email mailbox login check failed ${ageLabel(status.email.lastProbeAt, nowMs)}`
                  : status.email.state === 'skipped'
                    ? `Email mailbox check: ${status.email.note ?? 'not applicable'}`
                    : 'Email mailbox check scheduled — the first login check hasn’t run yet.'}
            </p>
          )}
        </div>
        <div className="w-full max-w-xl space-y-2" data-testid="outbox-status-warnings">
          {warnings.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-[#b9d8c5] bg-[#e1efe5] px-3 py-2 text-xs font-bold text-[#236047]" data-testid="outbox-status-healthy">
              <CheckCircle2 size={14} /> Alerts are going out normally
            </div>
          ) : (
            warnings.map((warning) => (
              <div
                key={warning.message}
                className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5 ${
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
