import { useMemo, useState } from 'react';
import { ArrowRight, Check, ChevronDown, RotateCcw } from 'lucide-react';
import { Link } from 'wouter';
import { useFieldTest, type GateStatus } from '@/hooks/use-field-test';
import { EvidenceLabel, SectionKicker, StatusPill } from '@/components/field-ui';

type GateFilter = 'all' | 'needs-work' | 'verified';

export default function Gates() {
  const { gates, updateGateStatus, resetDemo } = useFieldTest();
  const [filter, setFilter] = useState<GateFilter>('all');
  const [saved, setSaved] = useState<string | null>(null);
  const filtered = useMemo(() => gates.filter((gate) => filter === 'all' || (filter === 'verified' ? gate.status === 'verified' : gate.status === 'partial' || gate.status === 'blocked')), [filter, gates]);

  const saveStatus = (id: string, value: GateStatus) => {
    updateGateStatus(id, value);
    setSaved(id);
    window.setTimeout(() => setSaved(null), 1800);
  };

  return (
    <div className="mx-auto max-w-[1380px]">
      <section className="fade-up flex flex-col justify-between gap-5 border-b border-[#cfd2c9] pb-7 md:flex-row md:items-end"><div><div className="mb-4 flex items-center gap-3"><SectionKicker>Feasibility / 5 gates</SectionKicker><EvidenceLabel /></div><h1 className="font-display text-3xl font-extrabold tracking-[-0.05em] sm:text-5xl">The gates are the work.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687271]">Each gate names one observable condition for a stock Android feasibility run. Change status only when evidence changes; the next action stays visible either way.</p></div><Link href="/setup" className="inline-flex items-center gap-2 self-start border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 text-xs font-bold text-[#203c49] hover:border-[#203c49]" data-testid="link-gates-setup">Open owner setup <ArrowRight size={14} /></Link></section>
      <section className="fade-up fade-up-1 flex flex-col gap-4 border-b border-[#d7d8d0] py-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex flex-wrap gap-2">{(['all', 'needs-work', 'verified'] as GateFilter[]).map((item) => <button key={item} onClick={() => setFilter(item)} className={`border px-3 py-2 text-xs font-bold transition-colors ${filter === item ? 'border-[#203c49] bg-[#203c49] text-[#f2f0e6]' : 'border-[#c6cbc3] bg-[#fbfbf7] text-[#687271] hover:border-[#203c49] hover:text-[#203c49]'}`} data-testid={`button-filter-${item}`}>{item === 'all' ? 'All gates' : item === 'needs-work' ? 'Needs work' : 'Verified'}</button>)}</div><button onClick={resetDemo} className="inline-flex items-center gap-2 self-start text-xs font-bold text-[#687271] hover:text-[#203c49]" data-testid="button-reset-gates"><RotateCcw size={14} /> Reset sample statuses</button></section>
      <div className="fade-up fade-up-2 mt-5 space-y-3">
        {filtered.length === 0 ? <div className="border border-dashed border-[#c6cbc3] bg-[#f6f6f0] p-12 text-center"><p className="font-display font-bold text-[#203c49]">No gates match this view.</p><button onClick={() => setFilter('all')} className="mt-3 text-xs font-bold text-[#a06712]" data-testid="button-clear-gate-filter">Show all gates</button></div> : filtered.map((gate) => <article key={gate.id} className="border border-[#d7d8d0] bg-[#fbfbf7] transition-shadow hover:shadow-[0_8px_20px_rgba(32,60,73,0.06)]" data-testid={`card-gate-${gate.id}`}>
          <div className="grid gap-5 p-5 lg:grid-cols-[minmax(240px,0.8fr)_minmax(300px,1.25fr)_minmax(240px,0.9fr)] lg:p-6">
            <div className="flex gap-4"><span className="font-mono-ui text-xs text-[#a06712]">{gate.index}</span><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-display text-lg font-extrabold tracking-[-0.03em] text-[#203c49]">{gate.name}</h2><StatusPill status={gate.status} /></div><p className="mt-1 text-sm text-[#687271]">{gate.short}</p><div className="mt-5"><label className="font-mono-ui text-[10px] uppercase tracking-[0.13em] text-[#687271]" htmlFor={`status-${gate.id}`}>Update local status</label><div className="mt-2 flex items-center gap-2"><div className="relative"><select id={`status-${gate.id}`} value={gate.status} onChange={(event) => saveStatus(gate.id, event.target.value as GateStatus)} className="appearance-none border border-[#c6cbc3] bg-[#f4f3ed] py-2 pl-3 pr-8 text-xs font-bold text-[#203c49] outline-none focus:border-[#a06712]" data-testid={`select-gate-status-${gate.id}`}><option value="verified">Verified</option><option value="partial">Partial</option><option value="blocked">Blocked</option><option value="not-started">Not started</option></select><ChevronDown size={13} className="pointer-events-none absolute right-2 top-2.5 text-[#687271]" /></div>{saved === gate.id && <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#236047]"><Check size={13} />Saved</span>}</div></div></div></div>
            <div className="border-l-0 border-[#e3e4dc] lg:border-l lg:pl-6"><p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-[#a06712]">Acceptance criterion</p><p className="mt-2 text-sm leading-6 text-[#43575a]">{gate.criterion}</p><div className="mt-5"><div className="mb-2 flex items-center justify-between"><span className="font-mono-ui text-[10px] uppercase tracking-[0.13em] text-[#687271]">Evidence on file</span><EvidenceLabel /></div><ul className="space-y-2">{gate.evidence.map((item) => <li key={item} className="flex items-start gap-2 text-xs leading-5 text-[#687271]"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#8ca69f]" />{item}</li>)}</ul></div></div>
            <div className="border-t border-[#e3e4dc] pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0"><p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-[#687271]">Next action</p><p className="mt-2 text-sm font-semibold leading-6 text-[#203c49]">{gate.nextAction}</p><div className="mt-5 flex items-center justify-between"><span className="text-[11px] text-[#687271]">Owner: <strong className="text-[#43575a]">{gate.owner}</strong></span><span className="font-mono-ui text-[10px] uppercase tracking-[0.11em] text-[#a06712]">Local edit</span></div></div>
          </div>
        </article>)}
      </div>
      <div className="fade-up fade-up-3 mt-5 border-l-2 border-[#e8a629] bg-[#fff8e7] px-5 py-4"><p className="font-mono-ui text-[10px] font-medium uppercase tracking-[0.15em] text-[#a06712]">Decision rule</p><p className="mt-1 text-sm leading-6 text-[#765013]">A verified gate means the criterion was observed in this run, not that production behavior is guaranteed. Keep partial and blocked gates visible in the handoff.</p></div>
    </div>
  );
}