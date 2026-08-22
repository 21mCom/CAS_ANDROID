import { Check, CircleAlert, CircleDot, Clock3, Minus, ShieldCheck } from 'lucide-react';
import type { GateStatus, Priority } from '@/hooks/use-field-test';

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
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${statusStyles[status]}`} data-testid={`status-gate-${status}`}>
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
  return <span className={`inline-flex items-center rounded-sm border px-2 py-1 font-mono-ui text-[11px] font-medium tracking-[0.12em] ${styles[priority]}`} data-testid={`priority-${priority}`}>{priority}</span>;
}

export function EvidenceLabel({ children = 'SAMPLE EVIDENCE' }: { children?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono-ui text-[10px] font-medium uppercase tracking-[0.13em] text-[#a06712]" data-testid="label-sample-evidence">
      <CircleDot size={10} className="status-pulse" />
      {children}
    </span>
  );
}

export function SectionKicker({ children }: { children: string }) {
  return <p className="font-mono-ui text-[10px] font-medium uppercase tracking-[0.18em] text-[#a06712]" data-testid={`kicker-${children.toLowerCase().replaceAll(' ', '-')}`}>{children}</p>;
}

export function Meter({ value, total, color = 'bg-[#e8a629]' }: { value: number; total: number; color?: string }) {
  return (
    <div className="flex gap-1.5" aria-label={`${value} of ${total}`} data-testid="meter-readiness">
      {Array.from({ length: total }).map((_, index) => <span key={index} className={`h-2 flex-1 rounded-sm ${index < value ? color : 'bg-[#dfe1d9]'}`} />)}
    </div>
  );
}

export function MetricTile({ label, value, detail, tone = 'default' }: { label: string; value: string; detail: string; tone?: 'default' | 'warn' | 'danger' }) {
  const border = tone === 'danger' ? 'border-l-[#b95042]' : tone === 'warn' ? 'border-l-[#e8a629]' : 'border-l-[#9eb7ad]';
  return (
    <div className={`border border-[#d7d8d0] border-l-4 ${border} bg-[#fbfbf7] px-4 py-3`} data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
      <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-[#687271]">{label}</p>
      <p className="mt-1 font-display text-2xl font-extrabold tracking-[-0.04em] text-[#203c49]">{value}</p>
      <p className="mt-1 text-xs text-[#687271]">{detail}</p>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center justify-center border border-dashed border-[#c6cbc3] bg-[#f6f6f0] px-6 py-12 text-center" data-testid="empty-state">
      <ShieldCheck size={24} className="text-[#9ca9a0]" />
      <h3 className="mt-3 font-display text-base font-bold text-[#203c49]">{title}</h3>
      <p className="mt-1 max-w-sm text-sm leading-6 text-[#687271]">{detail}</p>
    </div>
  );
}