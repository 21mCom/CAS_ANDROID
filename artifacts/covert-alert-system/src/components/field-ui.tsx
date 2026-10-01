import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, CircleAlert, CircleDot, Clock3, Minus, RotateCcw, ShieldCheck } from 'lucide-react';
import type { GateStatus, Priority } from '@/hooks/use-field-test';
import { friendlyError } from '@/lib/friendly-errors';

const statusCopy: Record<GateStatus, string> = {
  verified: 'Verified',
  partial: 'Partial',
  blocked: 'Blocked',
  'not-started': 'Not started',
};

const statusStyles: Record<GateStatus, string> = {
  verified: 'bg-[#e1efe5] text-[#236047] border-[#b9d8c5]',
  partial: 'bg-[#fff1cf] text-[#8a5a09] border-[#f1cf7b]',
  blocked: 'bg-[#f8e0db] text-[#914136] border-[#e7b8af]',
  'not-started': 'bg-[#e8e9e4] text-[#5e6867] border-[#d0d4cc]',
};

export function StatusPill({ status }: { status: GateStatus }) {
  const Icon = status === 'verified' ? Check : status === 'partial' ? Clock3 : status === 'blocked' ? CircleAlert : Minus;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusStyles[status]}`} data-testid={`status-gate-${status}`}>
      <Icon size={12} strokeWidth={2.4} />
      {statusCopy[status]}
    </span>
  );
}

export function PriorityPill({ priority }: { priority: Priority }) {
  const styles = {
    P1: 'bg-[#203c49] text-[#ffd067] border-[#355866]',
    P2: 'bg-[#fff1cf] text-[#8a5a09] border-[#f1cf7b]',
    P3: 'bg-[#e8e9e4] text-[#5e6867] border-[#d0d4cc]',
  };
  return <span className={`inline-flex items-center rounded-md border px-2 py-1 font-mono-ui text-[11px] font-medium tracking-[0.08em] ${styles[priority]}`} data-testid={`priority-${priority}`}>{priority}</span>;
}

export function EvidenceLabel({ children = 'Sample data' }: { children?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#eadfbe] bg-[#fbf6e6] px-2.5 py-1 text-[11px] font-semibold text-[#8a5a09]" data-testid="label-sample-evidence">
      <CircleDot size={10} className="status-pulse" />
      {children}
    </span>
  );
}

/**
 * Small section label. `testId` pins the selector so the visible wording can
 * change without breaking tests; without it the testid is derived from the
 * text for backwards compatibility (only possible for plain-string labels).
 */
export function SectionKicker({ children, testId }: { children: ReactNode; testId?: string }) {
  const derived = typeof children === 'string' ? `kicker-${children.toLowerCase().replaceAll(' ', '-')}` : 'section-kicker';
  return <p className="text-[11px] font-bold tracking-[0.01em] text-[#a06712]" data-testid={testId ?? derived}>{children}</p>;
}

export function Meter({ value, total, color = 'bg-[#e8a629]' }: { value: number; total: number; color?: string }) {
  return (
    <div className="flex gap-1.5" aria-label={`${value} of ${total}`} data-testid="meter-readiness">
      {Array.from({ length: total }).map((_, index) => <span key={index} className={`h-2 flex-1 rounded-full ${index < value ? color : 'bg-[#dfe1d9]'}`} />)}
    </div>
  );
}

export function MetricTile({ label, value, detail, tone = 'default', testId }: { label: string; value: string; detail: string; tone?: 'default' | 'warn' | 'danger'; testId?: string }) {
  const border = tone === 'danger' ? 'border-l-[#b95042]' : tone === 'warn' ? 'border-l-[#e8a629]' : 'border-l-[#9eb7ad]';
  return (
    <div className={`rounded-xl border border-[#d7d8d0] border-l-4 ${border} bg-[#fbfbf7] px-4 py-3`} data-testid={testId ?? `metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
      <p className="text-[11px] font-semibold text-[#687271]">{label}</p>
      <p className="mt-1 font-display text-2xl font-extrabold tracking-[-0.04em] text-[#203c49]">{value}</p>
      <p className="mt-1 text-xs text-[#687271]">{detail}</p>
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[#c6cbc3] bg-[#f6f6f0] px-6 py-12 text-center" data-testid="empty-state">
      <ShieldCheck size={24} className="text-[#9ca9a0]" />
      <h3 className="mt-3 font-display text-base font-bold text-[#203c49]">{title}</h3>
      <p className="mt-1 max-w-sm text-sm leading-6 text-[#687271]">{detail}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Friendly error surface for inline page errors: a calm headline and a next
 * step up front, the raw technical message tucked behind a details toggle,
 * and an optional retry. The console never shows a raw server string without
 * this wrapper.
 */
export function FriendlyErrorMessage({ error, testId, onRetry }: { error: string; testId?: string; onRetry?: () => void }) {
  const friendly = friendlyError(error);
  const [showDetail, setShowDetail] = useState(false);
  return (
    <div className="rounded-lg border border-[#e7b8af] bg-[#f9e9e6] px-4 py-3" role="alert" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <CircleAlert size={15} className="shrink-0 text-[#914136]" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold leading-5 text-[#7c3a30]">{friendly.headline}</p>
          <p className="text-xs leading-5 text-[#7c3a30]">{friendly.next}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#c98d84] bg-[#fbfbf7] px-3 py-1.5 text-xs font-bold text-[#7c3a30] hover:border-[#914136]"
              data-testid={testId ? `${testId}-retry` : undefined}
            >
              <RotateCcw size={12} /> Try again
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowDetail((open) => !open)}
            className="inline-flex items-center gap-1 text-xs font-semibold text-[#a45248] underline decoration-[#e0b4ad] underline-offset-2 hover:text-[#7c3a30]"
            data-testid={testId ? `${testId}-details-toggle` : undefined}
          >
            {showDetail ? 'Hide details' : 'Technical details'}
            <ChevronDown size={12} className={showDetail ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
        </div>
      </div>
      {showDetail && (
        <p className="mt-2 break-words rounded-md border border-[#ecc7c0] bg-[#fdf3f1] px-3 py-2 font-mono-ui text-[11px] leading-4 text-[#7c3a30]" data-testid={testId ? `${testId}-detail` : undefined}>
          {friendly.detail}
        </p>
      )}
    </div>
  );
}
