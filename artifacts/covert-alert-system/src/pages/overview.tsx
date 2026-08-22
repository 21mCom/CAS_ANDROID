import { ArrowRight, Check, CircleAlert, MapPin, Smartphone, TimerReset, TriangleAlert } from 'lucide-react';
import { Link } from 'wouter';
import { useFieldTest } from '@/hooks/use-field-test';
import { EvidenceLabel, Meter, MetricTile, SectionKicker, StatusPill } from '@/components/field-ui';

export default function Overview() {
  const { gates, setup, incidents, runTestIncident } = useFieldTest();
  const verified = gates.filter((gate) => gate.status === 'verified').length;
  const needsWork = gates.filter((gate) => gate.status === 'partial' || gate.status === 'blocked').length;
  const setupComplete = setup.filter((item) => item.complete).length;
  const latestIncident = incidents[0];

  return (
    <div className="mx-auto max-w-[1380px]">
      <section className="fade-up flex flex-col justify-between gap-6 border-b border-[#cfd2c9] pb-7 md:flex-row md:items-end">
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-3"><SectionKicker>Milestone 0 / feasibility</SectionKicker><EvidenceLabel /></div>
          <h1 className="max-w-3xl font-display text-3xl font-extrabold leading-[1.08] tracking-[-0.05em] text-[#203c49] sm:text-5xl">Can this Pixel carry<br className="hidden sm:block" /> the alert path?</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[#687271] sm:text-base">A calm, evidence-led readout for one managed Google Pixel on stock Android. This console separates what was observed from what still needs a field test.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 border-l-2 border-[#e8a629] bg-[#fbfbf7] px-4 py-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#fff1cf] text-[#a06712]"><TriangleAlert size={18} /></span>
          <div><p className="font-mono-ui text-[10px] uppercase tracking-[0.12em] text-[#a06712]">Readiness call</p><p className="mt-0.5 font-display text-lg font-extrabold tracking-[-0.03em] text-[#8a5a09]">Conditional go</p></div>
        </div>
      </section>

      <section className="fade-up fade-up-1 grid gap-3 py-6 sm:grid-cols-3">
        <MetricTile label="Verified gates" value={`${verified} / ${gates.length}`} detail="Measured enough to repeat" />
        <MetricTile label="Needs work" value={`${needsWork}`} detail="Partial or blocked acceptance" tone={needsWork > 0 ? 'warn' : 'default'} />
        <MetricTile label="Owner checklist" value={`${setupComplete} / ${setup.length}`} detail="Local readiness inputs" tone={setupComplete < setup.length ? 'warn' : 'default'} />
      </section>

      <section className="fade-up fade-up-2 grid gap-5 xl:grid-cols-[1.4fr_0.85fr]">
        <div className="border border-[#d7d8d0] bg-[#fbfbf7]">
          <div className="flex flex-col gap-4 border-b border-[#d7d8d0] px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
            <div><SectionKicker>Readiness summary</SectionKicker><h2 className="mt-1 font-display text-xl font-extrabold tracking-[-0.04em] text-[#203c49]">The handoff is not green yet.</h2><p className="mt-1 max-w-xl text-sm leading-5 text-[#687271]">The delivery and location observations are repeatable. Entry-path persistence and observer inspection still have an explicit gap.</p></div>
            <Link href="/gates" className="inline-flex shrink-0 items-center gap-2 self-start border border-[#c6cbc3] px-3 py-2 text-xs font-bold text-[#203c49] transition-colors hover:border-[#203c49] hover:bg-[#eef0e9]" data-testid="link-review-gates">Review gates <ArrowRight size={14} /></Link>
          </div>
          <div className="divide-y divide-[#e3e4dc]">
            {gates.map((gate) => <div key={gate.id} className="flex items-center gap-3 px-5 py-3.5"><span className="w-7 font-mono-ui text-[10px] text-[#9ca49e]">{gate.index}</span><div className="min-w-0 flex-1"><p className="text-sm font-bold text-[#203c49]">{gate.name}</p><p className="mt-0.5 truncate text-xs text-[#687271]">{gate.short}</p></div><StatusPill status={gate.status} /></div>)}
          </div>
          <div className="border-t border-[#d7d8d0] bg-[#f4f3ed] px-5 py-4"><div className="mb-2 flex items-center justify-between"><span className="font-mono-ui text-[10px] uppercase tracking-[0.13em] text-[#687271]">Gate coverage</span><span className="font-mono-ui text-[11px] text-[#203c49]">{verified} of {gates.length} verified</span></div><Meter value={verified} total={gates.length} /></div>
        </div>

        <div className="border border-[#d7d8d0] bg-[#203c49] text-[#f2f0e6]">
          <div className="border-b border-[#3a5962] px-5 py-5"><SectionKicker>Field brief</SectionKicker><h2 className="mt-1 font-display text-xl font-extrabold tracking-[-0.04em]">One device. One path.</h2></div>
          <div className="space-y-0 px-5">
            <div className="flex gap-4 border-b border-[#3a5962] py-4"><Smartphone size={17} className="mt-0.5 shrink-0 text-[#ffd067]" /><div><p className="text-xs font-bold">Managed Google Pixel 8a</p><p className="mt-1 text-xs leading-5 text-[#aec0b8]">Stock Android · test SIM present · no backend dependency</p></div></div>
            <div className="flex gap-4 border-b border-[#3a5962] py-4"><MapPin size={17} className="mt-0.5 shrink-0 text-[#ffd067]" /><div><p className="text-xs font-bold">Location observation exists</p><p className="mt-1 text-xs leading-5 text-[#aec0b8]">18 m reported accuracy at 14:08 UTC, permission granted while in use.</p></div></div>
            <div className="flex gap-4 py-4"><TimerReset size={17} className="mt-0.5 shrink-0 text-[#ffd067]" /><div><p className="text-xs font-bold">Evidence is time-bounded</p><p className="mt-1 text-xs leading-5 text-[#aec0b8]">Sample records are a starting point, not a claim of production readiness.</p></div></div>
          </div>
        </div>
      </section>

      <section className="fade-up fade-up-3 mt-5 grid gap-5 lg:grid-cols-[1fr_1fr]">
        <div className="border border-[#d7d8d0] bg-[#fbfbf7]">
          <div className="border-b border-[#d7d8d0] px-5 py-4"><SectionKicker>What is measured</SectionKicker><h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">Observed in this sample run</h2></div>
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            {['Pixel launch surface opens', 'Two SMS receipts observed', 'Location fix with accuracy', 'Lock-screen state survives'].map((item) => <div key={item} className="flex items-start gap-2.5 text-sm text-[#43575a]"><span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#e1efe5] text-[#236047]"><Check size={11} strokeWidth={3} /></span>{item}</div>)}
          </div>
        </div>
        <div className="border border-[#e8c880] bg-[#fff8e7]">
          <div className="border-b border-[#e8c880] px-5 py-4"><SectionKicker>What is assumed</SectionKicker><h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em] text-[#765013]">Still needs an owner or observer</h2></div>
          <div className="space-y-3 p-5">
            {['Shortcut repeats under lock', 'Process interruption preserves the record', 'A second operator can inspect evidence'].map((item) => <div key={item} className="flex items-start gap-2.5 text-sm text-[#765013]"><CircleAlert size={16} className="mt-0.5 shrink-0 text-[#c78b21]" />{item}</div>)}
          </div>
        </div>
      </section>

      <section className="mt-5 border border-[#d7d8d0] bg-[#fbfbf7]">
        <div className="flex flex-col gap-3 border-b border-[#d7d8d0] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><SectionKicker>Latest local activity</SectionKicker><h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">The handoff trail</h2></div><button onClick={runTestIncident} className="inline-flex items-center justify-center gap-2 self-start border border-[#203c49] px-3 py-2 text-xs font-bold text-[#203c49] transition-colors hover:bg-[#203c49] hover:text-[#f2f0e6]" data-testid="button-overview-test-incident">Record TEST incident <ArrowRight size={14} /></button></div>
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#fff1cf] text-[#a06712]"><CircleAlert size={16} /></span><div className="min-w-0 flex-1"><p className="text-sm font-bold text-[#203c49]">{latestIncident?.title || 'No local incidents yet'}</p><p className="mt-1 text-xs text-[#687271]">{latestIncident?.detail || 'Use TEST incident to create a local, non-delivery record.'}</p></div><Link href="/incidents" className="inline-flex items-center gap-1 text-xs font-bold text-[#a06712]" data-testid="link-open-incidents">Open timeline <ArrowRight size={13} /></Link></div>
      </section>
    </div>
  );
}