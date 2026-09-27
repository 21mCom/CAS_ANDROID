import { useMemo, useState, type FormEvent } from 'react';
import { Activity, ArrowRight, Check, CircleStop, LockKeyhole, RotateCcw, ShieldAlert } from 'lucide-react';
import { Link } from 'wouter';
import { useFieldTest, type Priority } from '@/hooks/use-field-test';
import { EvidenceLabel, EmptyState, PriorityPill, SectionKicker } from '@/components/field-ui';
import { OutboxStatusPanel } from '@/components/outbox-status';

export default function Incidents() {
  const { incidents, activeIncident, runTestIncident, triggerKernel, acknowledgeKernel, resolveKernel, requeueOutboxItem, resetDemo } = useFieldTest();
  const [filter, setFilter] = useState<'all' | Priority>('all');
  const [requeueTarget, setRequeueTarget] = useState<string | null>(null);
  const [requeueNote, setRequeueNote] = useState('');
  const [requeueError, setRequeueError] = useState<string | null>(null);
  const [requeueBusy, setRequeueBusy] = useState(false);

  const openRequeueNote = (id: string) => {
    setRequeueTarget(id);
    setRequeueNote('');
    setRequeueError(null);
  };

  const submitRequeue = async (event: FormEvent) => {
    event.preventDefault();
    if (!requeueTarget || requeueBusy) return;
    setRequeueBusy(true);
    setRequeueError(null);
    try {
      await requeueOutboxItem(requeueTarget, requeueNote.trim() || undefined);
      setRequeueTarget(null);
      setRequeueNote('');
    } catch (error) {
      // Keep the note box open and show the rejection so the responder can
      // rephrase (e.g. when the server refuses a note that looks like a credential).
      setRequeueError(error instanceof Error ? error.message : 'Re-queue was rejected.');
    } finally {
      setRequeueBusy(false);
    }
  };
  const journalEntries = useMemo(() => activeIncident?.events.map((event) => ({
    id: event.id,
    priority: event.priority,
    time: event.time.slice(11, 19),
    title: event.type.replaceAll('_', ' '),
    detail: event.detail,
    state: 'Journaled',
    source: 'Incident journal',
    sample: false,
  })) ?? [], [activeIncident]);
  const visible = useMemo(() => {
    const entries = [...journalEntries, ...incidents];
    return filter === 'all' ? entries : entries.filter((item) => item.priority === filter);
  }, [filter, incidents, journalEntries]);

  return (
    <div className="mx-auto max-w-[1380px]">
      <section className="fade-up flex flex-col justify-between gap-5 border-b border-[#cfd2c9] pb-7 md:flex-row md:items-end"><div><div className="mb-4 flex items-center gap-3"><SectionKicker>Incident kernel / read-only</SectionKicker><EvidenceLabel /></div><h1 className="font-display text-3xl font-extrabold tracking-[-0.05em] sm:text-5xl">Preserve the sequence.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687271]">A durable timeline for the incident kernel. It keeps priority, event order, source, and observable state together across refreshes and devices.</p></div><button onClick={runTestIncident} className="inline-flex items-center justify-center gap-2 self-start bg-[#203c49] px-4 py-3 text-xs font-bold text-[#f2f0e6] transition-colors hover:bg-[#2d4a55]" data-testid="button-incidents-test-incident"><Activity size={15} /> Run local TEST</button></section>
      <OutboxStatusPanel />
      <section className="fade-up fade-up-1 mt-5 grid gap-5 xl:grid-cols-[1fr_320px]">
        <div className="border border-[#d7d8d0] bg-[#fbfbf7]">
          <div className="border-b border-[#d7d8d0] bg-[#f4f2e9] p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <ShieldAlert size={16} className="text-[#a06712]" />
                  <SectionKicker>Incident kernel / simulation</SectionKicker>
                </div>
                <h2 className="mt-1 font-display text-xl font-extrabold tracking-[-0.04em] text-[#203c49]">
                  {activeIncident ? activeIncident.status.replaceAll('_', ' ') : 'No active incident'}
                </h2>
                <p className="mt-1 max-w-xl text-xs leading-5 text-[#687271]">
                  {activeIncident
                    ? `One durable incident · ${activeIncident.triggerCount} trigger${activeIncident.triggerCount === 1 ? '' : 's'} folded together · ${activeIncident.events.length} journal events`
                    : 'Exercise idempotent triggers and responder transitions locally. This does not contact recipients or control a device.'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={triggerKernel} className="inline-flex items-center gap-2 bg-[#203c49] px-3 py-2 text-xs font-bold text-[#f2f0e6] transition-colors hover:bg-[#2d4a55]" data-testid="button-trigger-kernel"><ShieldAlert size={14} /> {activeIncident && activeIncident.status !== 'RESOLVED' ? 'Retrigger' : 'Activate kernel'}</button>
                <button onClick={acknowledgeKernel} disabled={!activeIncident || activeIncident.status !== 'ACTIVE_UNACKED'} className="inline-flex items-center gap-2 border border-[#b9d8c5] bg-[#e1efe5] px-3 py-2 text-xs font-bold text-[#236047] transition-opacity disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-ack-kernel"><Check size={14} /> ACK</button>
                <button onClick={resolveKernel} disabled={!activeIncident || activeIncident.status !== 'ACTIVE_ACKED'} className="inline-flex items-center gap-2 border border-[#e7b8af] bg-[#f8e0db] px-3 py-2 text-xs font-bold text-[#914136] transition-opacity disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-resolve-kernel"><CircleStop size={14} /> RESOLVE</button>
              </div>
            </div>
            {activeIncident && (
              <div className="mt-4 grid gap-3 border-t border-[#d7d8d0] pt-4 sm:grid-cols-2">
                <div>
                  <p className="font-mono-ui text-[10px] uppercase tracking-[0.13em] text-[#687271]">Stable incident ID</p>
                  <p className="mt-1 break-all font-mono-ui text-xs text-[#203c49]">{activeIncident.id}</p>
                </div>
                <div>
                  <p className="font-mono-ui text-[10px] uppercase tracking-[0.13em] text-[#687271]">Independent P1 outbox</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">{activeIncident.outbox.map((item) => <span key={item.id} className="inline-flex items-center gap-1"><span title={item.state === 'DEAD_LETTER' ? `Delivery abandoned after ${item.attempts} attempts${item.lastError ? ` — last error: ${item.lastError}` : ''}` : undefined} className={`border px-2 py-1 font-mono-ui text-[10px] ${item.state === 'DEAD_LETTER' ? 'border-[#914136] bg-[#914136]/10 font-bold text-[#914136]' : item.state === 'FAILED' ? 'border-[#a06712] bg-[#fbfbf7] text-[#a06712]' : 'border-[#c6cbc3] bg-[#fbfbf7] text-[#687271]'}`}>{item.transport} · {item.state === 'DEAD_LETTER' ? `DEAD LETTER · abandoned after ${item.attempts} attempts` : item.state}</span>{item.state === 'DEAD_LETTER' ? <button onClick={() => openRequeueNote(item.id)} title="Re-queue this abandoned delivery after fixing the provider problem" className="border border-[#914136] bg-[#fbfbf7] px-2 py-1 font-mono-ui text-[10px] font-bold text-[#914136] transition-colors hover:bg-[#f8e0db]" data-testid={`button-requeue-outbox-${item.id}`}>Re-queue</button> : null}</span>)}</div>
                  {requeueTarget && activeIncident.outbox.some((item) => item.id === requeueTarget) && (
                    <form onSubmit={submitRequeue} className="mt-3 border border-[#e7b8af] bg-[#fbfbf7] p-3" data-testid="form-requeue-note">
                      <label htmlFor="requeue-note" className="font-mono-ui text-[10px] uppercase tracking-[0.13em] text-[#687271]">What did you fix? (optional — recorded in the incident journal)</label>
                      <input
                        id="requeue-note"
                        value={requeueNote}
                        onChange={(event) => { setRequeueNote(event.target.value); setRequeueError(null); }}
                        maxLength={500}
                        placeholder='e.g. "rotated the provider API key"'
                        className="mt-1 w-full border border-[#c6cbc3] bg-[#fbfbf7] px-2 py-1.5 text-xs text-[#203c49] placeholder:text-[#9aa39f] focus:border-[#203c49] focus:outline-none"
                        data-testid="input-requeue-note"
                      />
                      <p className="mt-2 flex items-start gap-1.5 text-[11px] font-bold leading-4 text-[#914136]" data-testid="text-requeue-hint">
                        <LockKeyhole size={12} className="mt-0.5 shrink-0" />
                        Never paste credentials — the journal is permanent. Describe the fix, not the secret.
                      </p>
                      {requeueError && (
                        <p role="alert" className="mt-2 border border-[#914136] bg-[#914136]/10 px-2 py-1.5 text-[11px] font-bold leading-4 text-[#914136]" data-testid="text-requeue-error">{requeueError}</p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="submit" disabled={requeueBusy} className="bg-[#914136] px-3 py-1.5 font-mono-ui text-[10px] font-bold text-[#fbfbf7] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-requeue-confirm">{requeueBusy ? 'Re-queuing…' : 'Re-queue delivery'}</button>
                        <button type="button" onClick={() => { setRequeueTarget(null); setRequeueError(null); }} disabled={requeueBusy} className="border border-[#c6cbc3] px-3 py-1.5 font-mono-ui text-[10px] font-bold text-[#687271] transition-colors hover:border-[#203c49] disabled:opacity-40" data-testid="button-requeue-cancel">Cancel</button>
                      </div>
                    </form>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-4 border-b border-[#d7d8d0] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex flex-wrap gap-2">{(['all', 'P1', 'P2', 'P3'] as const).map((item) => <button key={item} onClick={() => setFilter(item)} className={`border px-3 py-2 font-mono-ui text-[10px] uppercase tracking-[0.1em] transition-colors ${filter === item ? 'border-[#203c49] bg-[#203c49] text-[#f2f0e6]' : 'border-[#c6cbc3] text-[#687271] hover:border-[#203c49]'}`} data-testid={`button-filter-priority-${item}`}>{item === 'all' ? 'All events' : item}</button>)}</div><button onClick={resetDemo} className="inline-flex items-center gap-2 self-start text-xs font-bold text-[#687271] hover:text-[#203c49]" data-testid="button-reset-incidents"><RotateCcw size={14} /> Reset sample</button></div>
          {visible.length === 0 ? <div className="p-6"><EmptyState title="No events in this priority" detail="Choose another priority or run a local TEST incident to add a P3 record." /></div> : <div className="relative px-5 py-5"><div className="absolute bottom-7 left-[38px] top-7 w-px bg-[#d7d8d0]" />{visible.map((incident) => <div key={incident.id} className="relative grid grid-cols-[28px_1fr] gap-4 pb-6 last:pb-0" data-testid={`row-incident-${incident.id}`}><div className="z-10 mt-1 flex h-7 w-7 items-center justify-center border border-[#d7d8d0] bg-[#fbfbf7]"><span className={`h-2 w-2 rounded-full ${incident.priority === 'P1' ? 'bg-[#203c49]' : incident.priority === 'P2' ? 'bg-[#e8a629]' : 'bg-[#8ca69f]'}`} /></div><div className="border border-[#e0e1da] bg-[#f7f7f1] p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-center gap-2"><PriorityPill priority={incident.priority} /><h2 className="text-sm font-bold text-[#203c49]">{incident.title}</h2></div><span className="font-mono-ui text-[10px] text-[#687271]">{incident.time} UTC</span></div><p className="mt-2 text-sm leading-5 text-[#687271]">{incident.detail}</p><div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#e0e1da] pt-3 font-mono-ui text-[10px] uppercase tracking-[0.08em] text-[#687271]"><span>State: <strong className={incident.state === 'Blocked' ? 'text-[#914136]' : incident.state === 'Local only' ? 'text-[#a06712]' : 'text-[#236047]'}>{incident.state}</strong></span><span>Source: {incident.source}</span>{incident.sample ? <EvidenceLabel /> : <span className="text-[#a06712]">LOCAL ACTION</span>}</div></div></div>)}</div>}
        </div>
        <aside className="space-y-5">
          <div className="border border-[#d7d8d0] bg-[#203c49] p-5 text-[#f2f0e6]"><SectionKicker>Priority model</SectionKicker><h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">Urgency is explicit.</h2><div className="mt-4 space-y-3"><div className="flex gap-3 border-t border-[#3a5962] pt-3"><PriorityPill priority="P1" /><p className="text-xs leading-5 text-[#c2cec7]">Immediate duress signal; preserve first in the sequence.</p></div><div className="flex gap-3 border-t border-[#3a5962] pt-3"><PriorityPill priority="P2" /><p className="text-xs leading-5 text-[#c2cec7]">Supporting delivery or location event.</p></div><div className="flex gap-3 border-t border-[#3a5962] pt-3"><PriorityPill priority="P3" /><p className="text-xs leading-5 text-[#c2cec7]">Diagnostic, observer, or non-urgent record.</p></div></div></div>
          <div className="border border-[#d7d8d0] bg-[#fbfbf7] p-5"><SectionKicker>Kernel contract</SectionKicker><h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">What must survive</h2><ul className="mt-4 space-y-3">{[['Ordering', 'Do not lose the sequence of alert, delivery, and location events.'], ['Priority', 'Keep P1 / P2 / P3 attached to every event.'], ['Provenance', 'Name the source and whether an observer can verify it.'], ['Time', 'Store the event time and the observed state, not a vague success flag.']].map(([title, detail]) => <li key={title} className="flex gap-3 text-xs leading-5 text-[#687271]"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#e8a629]" /><span><strong className="text-[#203c49]">{title}:</strong> {detail}</span></li>)}</ul></div>
          <div className="border border-[#e8c880] bg-[#fff8e7] p-5"><div className="flex gap-3"><LockKeyhole size={17} className="mt-0.5 shrink-0 text-[#a06712]" /><div><p className="text-sm font-bold text-[#765013]">Read-only by design</p><p className="mt-1 text-xs leading-5 text-[#765013]">Timeline entries are sample evidence or local TEST records. This prototype does not send messages or control the device.</p></div></div></div>
        </aside>
      </section>
      <div className="mt-5 flex items-center justify-between border-t border-[#d7d8d0] pt-4 text-xs text-[#687271]"><span>Need to validate the source path first?</span><Link href="/gates" className="inline-flex items-center gap-1 font-bold text-[#a06712]" data-testid="link-incidents-gates">Review feasibility gates <ArrowRight size={13} /></Link></div>
    </div>
  );
}
