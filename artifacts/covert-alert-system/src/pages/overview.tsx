import { ArrowRight, Check, CircleAlert, MapPin, Smartphone, TimerReset, TriangleAlert } from 'lucide-react';
import { Link } from 'wouter';
import { useFieldTest } from '@/hooks/use-field-test';
import { EvidenceLabel, Meter, MetricTile, SectionKicker, StatusPill } from '@/components/field-ui';
import { OutboxStatusBanner } from '@/components/outbox-status';

export default function Overview() {
  const { gates, setup, incidents, runTestIncident, fieldRun } = useFieldTest();
  const verified = gates.filter((gate) => gate.status === 'verified').length;
  const needsWork = gates.filter((gate) => gate.status === 'partial' || gate.status === 'blocked').length;
  const setupComplete = setup.filter((item) => item.complete).length;
  const latestIncident = incidents[0];
  const measured = Object.keys(fieldRun.observations).length;

  return (
    <div className="mx-auto max-w-[1380px]">
      <section className="fade-up flex flex-col justify-between gap-6 border-b border-[#cfd2c9] pb-7 md:flex-row md:items-end">
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-3"><SectionKicker testId="kicker-milestone-0-/-feasibility">Readiness · field testing</SectionKicker><EvidenceLabel /></div>
          <h1 className="max-w-3xl font-display text-3xl font-extrabold leading-[1.08] tracking-[-0.05em] text-[#203c49] sm:text-5xl">When someone needs help,<br className="hidden sm:block" /> does the alert get out?</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[#687271] sm:text-base">This console answers that question for one managed Google Pixel on stock Android — calmly, and only with evidence. What we&apos;ve confirmed on the phone is kept strictly separate from what still needs a real test.</p>
        </div>
         <div className={`flex shrink-0 items-center gap-3 rounded-xl border-l-2 ${fieldRun.decision === 'go' ? 'border-[#236047]' : 'border-[#b95042]'} bg-[#fbfbf7] px-4 py-3`}>
           <span className={`flex h-9 w-9 items-center justify-center rounded-full ${fieldRun.decision === 'go' ? 'bg-[#e1efe5] text-[#236047]' : 'bg-[#f8e0db] text-[#914136]'}`}><TriangleAlert size={18} /></span>
           <div><p className="text-[11px] font-semibold text-[#a06712]">Readiness call</p><p className={`mt-0.5 font-display text-lg font-extrabold tracking-[-0.03em] ${fieldRun.decision === 'go' ? 'text-[#236047]' : 'text-[#914136]'}`}>{fieldRun.decision === 'go' ? 'GO — ready to rely on' : 'NO-GO — not ready yet'}</p><p className="text-[10px] text-[#687271]">{measured} / {gates.length} checks confirmed on the phone</p></div>
        </div>
      </section>

      <OutboxStatusBanner />

      <section className="fade-up fade-up-1 grid gap-3 py-6 sm:grid-cols-3">
        <MetricTile label="Checks verified" value={`${verified} / ${gates.length}`} detail="Confirmed on the real phone" testId="metric-verified-gates" />
        <MetricTile label="Needs attention" value={`${needsWork}`} detail="Checks that are partial or blocked" tone={needsWork > 0 ? 'warn' : 'default'} testId="metric-needs-work" />
        <MetricTile label="Setup done" value={`${setupComplete} / ${setup.length}`} detail="Items on the owner checklist" tone={setupComplete < setup.length ? 'warn' : 'default'} testId="metric-owner-checklist" />
      </section>

      <section className="fade-up fade-up-2 grid gap-5 xl:grid-cols-[1.4fr_0.85fr]">
        <div className="rounded-xl border border-[#d7d8d0] bg-[#fbfbf7]">
          <div className="flex flex-col gap-4 border-b border-[#d7d8d0] px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
             <div><SectionKicker testId="kicker-readiness-summary">Readiness summary</SectionKicker><h2 className="mt-1 font-display text-xl font-extrabold tracking-[-0.04em] text-[#203c49]">{fieldRun.decision === 'go' ? 'Every check passed on the phone.' : 'Not ready to rely on yet.'}</h2><p className="mt-1 max-w-xl text-sm leading-5 text-[#687271]">{measured === 0 ? 'Nothing has been recorded from the physical Pixel yet. The sample records below are examples, not a readiness claim.' : `${measured} of ${gates.length} checks have on-phone observations. Missing, failed, or inconclusive checks keep the call at NO-GO.`}</p></div>
            <Link href="/gates" className="inline-flex shrink-0 items-center gap-2 self-start rounded-lg border border-[#c6cbc3] px-3 py-2 text-xs font-bold text-[#203c49] transition-colors hover:border-[#203c49] hover:bg-[#eef0e9]" data-testid="link-review-gates">Review the checks <ArrowRight size={14} /></Link>
          </div>
          <div className="divide-y divide-[#e3e4dc]">
            {gates.map((gate) => <div key={gate.id} className="flex items-center gap-3 px-5 py-3.5"><span className="w-7 font-mono-ui text-[10px] text-[#9ca49e]">{gate.index}</span><div className="min-w-0 flex-1"><p className="text-sm font-bold text-[#203c49]">{gate.name}</p><p className="mt-0.5 truncate text-xs text-[#687271]">{gate.short}</p></div><StatusPill status={gate.status} /></div>)}
          </div>
          <div className="rounded-b-xl border-t border-[#d7d8d0] bg-[#f4f3ed] px-5 py-4"><div className="mb-2 flex items-center justify-between"><span className="text-[11px] font-semibold text-[#687271]">Check coverage</span><span className="text-[11px] font-semibold text-[#203c49]">{verified} of {gates.length} verified</span></div><Meter value={verified} total={gates.length} /></div>
        </div>

        <div className="rounded-xl border border-[#d7d8d0] bg-[#203c49] text-[#f2f0e6]">
          <div className="border-b border-[#3a5962] px-5 py-5"><SectionKicker testId="kicker-field-brief"><span className="text-[#ffd067]">The short version</span></SectionKicker><h2 className="mt-1 font-display text-xl font-extrabold tracking-[-0.04em]">One phone. One job: get help out.</h2></div>
          <div className="space-y-0 px-5">
            <div className="flex gap-4 border-b border-[#3a5962] py-4"><Smartphone size={17} className="mt-0.5 shrink-0 text-[#ffd067]" /><div><p className="text-xs font-bold">A managed Google Pixel 11</p><p className="mt-1 text-xs leading-5 text-[#aec0b8]">The approved test phone · stock Android · its exact build is recorded before each run</p></div></div>
             <div className="flex gap-4 border-b border-[#3a5962] py-4"><MapPin size={17} className="mt-0.5 shrink-0 text-[#ffd067]" /><div><p className="text-xs font-bold">{fieldRun.observations.location ? 'Location confirmed on the phone' : 'Location still to be confirmed'}</p><p className="mt-1 text-xs leading-5 text-[#aec0b8]">{fieldRun.observations.location ? fieldRun.observations.location.notes || 'Recorded from the physical phone.' : 'The 18 m sample accuracy is an example, not a real measurement.'}</p></div></div>
            <div className="flex gap-4 py-4"><TimerReset size={17} className="mt-0.5 shrink-0 text-[#ffd067]" /><div><p className="text-xs font-bold">Evidence has a shelf life</p><p className="mt-1 text-xs leading-5 text-[#aec0b8]">Sample records are a starting point for practice, not proof the system is ready.</p></div></div>
          </div>
        </div>
      </section>

      <section className="fade-up fade-up-3 mt-5 grid gap-5 lg:grid-cols-[1fr_1fr]">
        <div className="rounded-xl border border-[#d7d8d0] bg-[#fbfbf7]">
          <div className="border-b border-[#d7d8d0] px-5 py-4"><SectionKicker testId="kicker-what-is-measured">Confirmed on the phone</SectionKicker><h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">What we&apos;ve seen work</h2></div>
           <div className="grid gap-3 p-5 sm:grid-cols-2">
             {gates.filter((gate) => fieldRun.observations[gate.id]?.result === 'pass').map((gate) => <div key={gate.id} className="flex items-start gap-2.5 text-sm text-[#43575a]"><span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#e1efe5] text-[#236047]"><Check size={11} strokeWidth={3} /></span>{gate.name} — confirmed</div>)}
             {measured === 0 && <p className="text-sm text-[#687271]">Nothing recorded from the phone yet. Add results from the readiness checks page.</p>}
          </div>
        </div>
        <div className="rounded-xl border border-[#e8c880] bg-[#fff8e7]">
          <div className="border-b border-[#e8c880] px-5 py-4"><SectionKicker testId="kicker-what-is-assumed"><span className="text-[#a06712]">Still to confirm</span></SectionKicker><h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em] text-[#765013]">What we haven&apos;t proven yet</h2></div>
          <div className="space-y-3 p-5">
            {['The shortcut still works while the phone is locked', 'The alert record survives the app being closed', 'A second person can review the evidence'].map((item) => <div key={item} className="flex items-start gap-2.5 text-sm text-[#765013]"><CircleAlert size={16} className="mt-0.5 shrink-0 text-[#c78b21]" />{item}</div>)}
          </div>
        </div>
      </section>

      <section className="mt-5 rounded-xl border border-[#d7d8d0] bg-[#fbfbf7]">
        <div className="flex flex-col gap-3 border-b border-[#d7d8d0] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><SectionKicker testId="kicker-latest-local-activity">Recent activity</SectionKicker><h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">The latest from this console</h2></div><button onClick={runTestIncident} title="Writes a local test record only — no alert is sent and no responder is contacted." className="inline-flex items-center justify-center gap-2 self-start rounded-lg border border-[#203c49] px-3 py-2 text-xs font-bold text-[#203c49] transition-colors hover:bg-[#203c49] hover:text-[#f2f0e6]" data-testid="button-overview-test-incident">Record a test event <ArrowRight size={14} /></button></div>
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#fff1cf] text-[#a06712]"><CircleAlert size={16} /></span><div className="min-w-0 flex-1"><p className="text-sm font-bold text-[#203c49]">{latestIncident?.title || 'No activity yet'}</p><p className="mt-1 text-xs text-[#687271]">{latestIncident?.detail || 'Use “Record a test event” to add a local record — it never sends anything.'}</p></div><Link href="/incidents" className="inline-flex items-center gap-1 text-xs font-bold text-[#a06712]" data-testid="link-open-incidents">Open the alert log <ArrowRight size={13} /></Link></div>
      </section>
    </div>
  );
}
