import { useMemo, useState, type FormEvent } from 'react';
import { Activity, ArrowRight, Camera, Check, CircleStop, Download, LockKeyhole, Mic, RotateCcw, ShieldAlert, Video } from 'lucide-react';
import { Link } from 'wouter';
import { casAuthedFetch, useFieldTest, type EvidenceItem, type OutboxItem, type Priority } from '@/hooks/use-field-test';
import { formatEvidenceSize, useCapturePolicy } from '@/hooks/use-capture-policy';
import { evidenceDownloadFilename } from '@/lib/evidence-download';
import { EvidenceLabel, EmptyState, FriendlyErrorMessage, PriorityPill, SectionKicker } from '@/components/field-ui';
import { OutboxStatusPanel } from '@/components/outbox-status';

const EVIDENCE_KIND_ICONS = { audio: Mic, photo: Camera, video: Video } as const;

/** True when the delivery was accepted by the built-in dev provider sink, not a real provider. */
const isSimulatedDelivery = (item: OutboxItem) => item.state === 'SENT' && item.deliveredTo === 'dev-sink';

/** True when the handset sent the alert itself over its own SIM (device-direct mode), not via a gateway. */
const isHandsetDelivery = (item: OutboxItem) => item.state === 'SENT' && item.deliveredTo === 'handset-sim';

function outboxChipTitle(item: OutboxItem): string | undefined {
  if (item.state === 'DEAD_LETTER') return `Gave up after ${item.attempts} attempts${item.lastError ? ` — last error: ${item.lastError}` : ''}`;
  if (item.state === 'WITHDRAWN') return 'Cancelled when the alert was resolved, before it was sent — it will not be delivered.';
  if (isSimulatedDelivery(item)) return 'Accepted by the built-in test inbox — simulated delivery: no real provider was contacted and no responder received anything.';
  if (isHandsetDelivery(item)) return 'Sent by the phone itself, over its own SIM — no gateway involved.';
  if (item.state === 'SENT' && item.deliveredTo) return `Delivered via ${item.deliveredTo}`;
  return undefined;
}

function outboxChipLabel(item: OutboxItem): string {
  if (isSimulatedDelivery(item)) return 'Test only — nothing was really sent';
  if (item.state === 'DEAD_LETTER') return `Couldn’t be delivered · gave up after ${item.attempts} attempts`;
  if (item.state === 'WITHDRAWN') return 'Cancelled · alert was resolved';
  if (item.state === 'QUEUED') return 'Waiting to send';
  if (item.state === 'PROCESSING') return 'Sending now';
  if (item.state === 'FAILED') return 'Retrying';
  return 'Sent';
}

function outboxChipClass(item: OutboxItem): string {
  if (item.state === 'DEAD_LETTER') return 'border-[#914136] bg-[#914136]/10 font-bold text-[#914136]';
  if (isSimulatedDelivery(item)) return 'border-[#a06712] bg-[#fff8e7] font-bold text-[#a06712]';
  if (item.state === 'FAILED') return 'border-[#a06712] bg-[#fbfbf7] text-[#a06712]';
  if (item.state === 'WITHDRAWN') return 'border-[#c6cbc3] bg-[#f4f2e9] text-[#687271] line-through';
  return 'border-[#c6cbc3] bg-[#fbfbf7] text-[#687271]';
}

export default function Incidents() {
  const { incidents, activeIncident, runTestIncident, triggerKernel, acknowledgeKernel, resolveKernel, requeueOutboxItem, requestCapture, resetDemo } = useFieldTest();
  const { policy } = useCapturePolicy();
  const [filter, setFilter] = useState<'all' | Priority>('all');
  const [requeueTarget, setRequeueTarget] = useState<string | null>(null);
  const [requeueNote, setRequeueNote] = useState('');
  const [requeueError, setRequeueError] = useState<string | null>(null);
  const [requeueBusy, setRequeueBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureBusy, setCaptureBusy] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);

  const submitCaptureRequest = async (kind: 'audio' | 'photo' | 'video') => {
    if (captureBusy) return;
    setCaptureBusy(kind);
    setCaptureError(null);
    try {
      await requestCapture(kind);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : 'Capture request was rejected.');
    } finally {
      setCaptureBusy(null);
    }
  };

  const downloadEvidence = async (item: EvidenceItem) => {
    if (downloadBusy === item.id) return;
    setDownloadBusy(item.id);
    setCaptureError(null);
    try {
      // Downloads are credentialed: fetch the bytes with the Bearer credential
      // and hand the operator a file, since a bare <a href> cannot send it.
      const response = await casAuthedFetch(`/api/cas/evidence/${item.id}/download`);
      if (!response.ok) throw new Error(`Download was rejected (${response.status}).`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      // The server's Content-Disposition filename is the source of truth
      // (it carries the camera label); the local fallback mirrors it.
      anchor.download = evidenceDownloadFilename(
        response.headers.get('content-disposition'),
        activeIncident?.id,
        item,
      );
      // The anchor must be in the document: some browsers ignore synthetic
      // click() downloads on detached elements.
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // The click only schedules the download — the browser starts reading
      // the blob asynchronously. Revoking the URL in the same tick races that
      // startup and silently aborts the download, so revoke only after the
      // download manager has had time to open the blob.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : 'Download failed.');
    } finally {
      setDownloadBusy(null);
    }
  };

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
      <section className="fade-up flex flex-col justify-between gap-5 border-b border-[#cfd2c9] pb-7 md:flex-row md:items-end"><div><div className="mb-4 flex items-center gap-3"><SectionKicker testId="kicker-incident-kernel-/-read-only">Alert log</SectionKicker><EvidenceLabel /></div><h1 className="font-display text-3xl font-extrabold tracking-[-0.05em] sm:text-5xl">What happened, in order.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687271]">Every alert keeps a permanent timeline — what triggered it, who was notified, and what the phone reported — so you can reconstruct the moment later.</p></div><div className="flex max-w-xs flex-col gap-1.5 self-start md:items-end"><button onClick={runTestIncident} className="inline-flex items-center justify-center gap-2 self-start rounded-lg bg-[#203c49] px-4 py-3 text-xs font-bold text-[#f2f0e6] transition-colors hover:bg-[#2d4a55] md:self-end" data-testid="button-incidents-test-incident"><Activity size={15} /> Record a test event</button><p className="text-[11px] leading-4 text-[#687271] md:text-right" data-testid="text-test-incident-hint">Adds a practice entry to the timeline only — nothing is sent and no one is contacted. To exercise the real delivery path, use <strong className="text-[#203c49]">Trigger the alert</strong> below (or the phone’s own Send alert), which notifies responders for real and reports what happened.</p></div></section>
      <OutboxStatusPanel />
      <section className="fade-up fade-up-1 mt-5 grid gap-5 xl:grid-cols-[1fr_320px]">
        <div className="rounded-xl border border-[#d7d8d0] bg-[#fbfbf7]">
          <div className="border-b border-[#d7d8d0] bg-[#f4f2e9] p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <ShieldAlert size={16} className="text-[#a06712]" />
                  <SectionKicker testId="kicker-incident-kernel-/-simulation">Current alert</SectionKicker>
                </div>
                <h2 className="mt-1 font-display text-xl font-extrabold tracking-[-0.04em] text-[#203c49]">
                  {activeIncident ? activeIncident.status === 'ACTIVE_UNACKED' ? 'Active — nobody has acknowledged yet' : activeIncident.status === 'ACTIVE_ACKED' ? 'Acknowledged — someone is handling it' : activeIncident.status === 'RESOLVED' ? 'Resolved — all clear' : 'No active alert' : 'No active alert'}
                </h2>
                <p className="mt-1 max-w-xl text-xs leading-5 text-[#687271]">
                  {activeIncident
                    ? `One alert record · triggered ${activeIncident.triggerCount} time${activeIncident.triggerCount === 1 ? '' : 's'} · ${activeIncident.events.length} timeline entries`
                    : 'Nothing is active right now. You can trigger a real alert here to practice the flow — it will notify your responders for real.'}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={triggerKernel} title="Triggers a real alert: responders are notified through the configured channels." className="inline-flex items-center gap-2 rounded-lg bg-[#203c49] px-3 py-2 text-xs font-bold text-[#f2f0e6] transition-colors hover:bg-[#2d4a55]" data-testid="button-trigger-kernel"><ShieldAlert size={14} /> {activeIncident && activeIncident.status !== 'RESOLVED' ? 'Trigger again' : 'Trigger the alert'}</button>
                <button onClick={acknowledgeKernel} disabled={!activeIncident || activeIncident.status !== 'ACTIVE_UNACKED'} title="Mark that someone has seen the alert and is handling it." className="inline-flex items-center gap-2 rounded-lg border border-[#b9d8c5] bg-[#e1efe5] px-3 py-2 text-xs font-bold text-[#236047] transition-opacity disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-ack-kernel"><Check size={14} /> Acknowledge</button>
                <button onClick={resolveKernel} disabled={!activeIncident || activeIncident.status !== 'ACTIVE_ACKED'} title="Mark the alert as handled. Anything still waiting to be sent is cancelled." className="inline-flex items-center gap-2 rounded-lg border border-[#e7b8af] bg-[#f8e0db] px-3 py-2 text-xs font-bold text-[#914136] transition-opacity disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-resolve-kernel"><CircleStop size={14} /> Mark resolved</button>
              </div>
            </div>
            {activeIncident && (
              <div className="mt-4 grid gap-3 border-t border-[#d7d8d0] pt-4 sm:grid-cols-2">
                <div>
                  <p className="text-[11px] font-semibold text-[#687271]">Alert reference</p>
                  <p className="mt-1 break-all font-mono-ui text-xs text-[#203c49]">{activeIncident.id}</p>
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-[#687271]">Deliveries for this alert</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">{activeIncident.outbox.map((item) => <span key={item.id} className="inline-flex items-center gap-1"><span title={outboxChipTitle(item)} className={`rounded-md border px-2 py-1 text-[11px] font-medium ${outboxChipClass(item)}`} data-testid={`chip-outbox-${item.id}`}>{item.transport} · {outboxChipLabel(item)}</span>{item.state === 'DEAD_LETTER' ? <button onClick={() => openRequeueNote(item.id)} title="Try this delivery again after fixing the provider problem" className="rounded-md border border-[#914136] bg-[#fbfbf7] px-2 py-1 text-[11px] font-bold text-[#914136] transition-colors hover:bg-[#f8e0db]" data-testid={`button-requeue-outbox-${item.id}`}>Try again</button> : null}</span>)}</div>
                  {requeueTarget && activeIncident.outbox.some((item) => item.id === requeueTarget) && (
                    <form onSubmit={submitRequeue} className="mt-3 rounded-lg border border-[#e7b8af] bg-[#fbfbf7] p-3" data-testid="form-requeue-note">
                      <label htmlFor="requeue-note" className="text-[11px] font-semibold text-[#687271]">What did you fix? (optional — saved in the alert’s permanent record)</label>
                      <input
                        id="requeue-note"
                        value={requeueNote}
                        onChange={(event) => { setRequeueNote(event.target.value); setRequeueError(null); }}
                        maxLength={500}
                        placeholder='e.g. "renewed the provider password"'
                        className="mt-1 w-full rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-2 py-1.5 text-xs text-[#203c49] placeholder:text-[#9aa39f] focus:border-[#203c49] focus:outline-none"
                        data-testid="input-requeue-note"
                      />
                      <p className="mt-2 flex items-start gap-1.5 text-[11px] font-bold leading-4 text-[#914136]" data-testid="text-requeue-hint">
                        <LockKeyhole size={12} className="mt-0.5 shrink-0" />
                        Never paste passwords or keys here — this record is permanent. Describe the fix, not the secret.
                      </p>
                      {requeueError && (
                        <div className="mt-2" data-testid="text-requeue-error"><FriendlyErrorMessage error={requeueError} /></div>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="submit" disabled={requeueBusy} className="rounded-md bg-[#914136] px-3 py-1.5 text-[11px] font-bold text-[#fbfbf7] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-requeue-confirm">{requeueBusy ? 'Sending it again…' : 'Send it again'}</button>
                        <button type="button" onClick={() => { setRequeueTarget(null); setRequeueError(null); }} disabled={requeueBusy} className="rounded-md border border-[#c6cbc3] px-3 py-1.5 text-[11px] font-bold text-[#687271] transition-colors hover:border-[#203c49] disabled:opacity-40" data-testid="button-requeue-cancel">Cancel</button>
                      </div>
                    </form>
                  )}
                </div>
                <div className="sm:col-span-2" data-testid="panel-incident-location">
                  <p className="text-[11px] font-semibold text-[#687271]">Where the phone was</p>
                  {activeIncident.location ? (
                    <p className="mt-1 text-xs leading-5 text-[#203c49]">
                      <a
                        href={`https://maps.google.com/?q=${activeIncident.location.latitude.toFixed(5)},${activeIncident.location.longitude.toFixed(5)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono-ui font-bold text-[#a06712] underline decoration-[#e8c880] underline-offset-2 hover:text-[#203c49]"
                        data-testid="link-incident-map"
                      >
                        {activeIncident.location.latitude.toFixed(5)}, {activeIncident.location.longitude.toFixed(5)}
                      </a>
                      {' '}· accurate to about {Math.round(activeIncident.location.accuracyM)} m · recorded{' '}
                      {(() => {
                        const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(activeIncident.location.capturedAt)) / 1000));
                        return ageSeconds < 90 ? `${ageSeconds}s` : `${Math.round(ageSeconds / 60)}min`;
                      })()}{' '}ago — a location is always shown with its accuracy and age, never as “right now”.
                    </p>
                  ) : (
                    <p className="mt-1 text-xs leading-5 text-[#687271]">No location was captured with this alert (permission off, no signal, or time ran out). The alert itself still went out on time.</p>
                  )}
                </div>
                <div className="sm:col-span-2" data-testid="panel-incident-evidence">
                  <p className="text-[11px] font-semibold text-[#687271]">Evidence from the phone</p>
                  {activeIncident.evidence.length === 0 ? (
                    <p className="mt-1 text-xs leading-5 text-[#687271]">
                      No clips yet. Turn capture types on at the{' '}
                      <Link href="/capture" className="font-bold text-[#a06712]" data-testid="link-incident-capture-settings">Evidence capture</Link>
                      {' '}page, or request one below when its setting is “only when a responder asks”.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {activeIncident.evidence.map((item) => {
                        const KindIcon = EVIDENCE_KIND_ICONS[item.kind];
                        const capturedAge = item.capturedAt
                          ? (() => {
                              const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(item.capturedAt)) / 1000));
                              return ageSeconds < 90 ? `${ageSeconds}s` : `${Math.round(ageSeconds / 60)}min`;
                            })()
                          : null;
                        return (
                          <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[#e0e1da] bg-[#f7f7f1] px-3 py-2" data-testid={`row-evidence-${item.id}`}>
                            <KindIcon size={14} className="text-[#203c49]" />
                            <span className="text-xs font-bold text-[#203c49]">
                              {item.kind}{item.camera ? ` · ${item.camera} camera` : ''}{item.sequence > 1 ? ` · clip ${item.sequence}` : ''}
                            </span>
                            <span className="text-[11px] text-[#687271]">
                              {formatEvidenceSize(item.sizeBytes)}
                              {capturedAge ? ` · captured ${capturedAge} ago` : ''}
                              {item.requestId ? ' · requested by a responder' : ''}
                            </span>
                            <button
                              onClick={() => { void downloadEvidence(item); }}
                              disabled={downloadBusy === item.id}
                              className="ml-auto inline-flex items-center gap-1 rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-2 py-1 text-[11px] font-bold text-[#203c49] transition-colors hover:border-[#203c49] disabled:cursor-not-allowed disabled:opacity-40"
                              data-testid={`button-download-evidence-${item.id}`}
                            >
                              <Download size={12} /> {downloadBusy === item.id ? 'Downloading…' : 'Download'}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {(['audio', 'photo', 'video'] as const).filter((kind) => policy[kind] === 'responder').map((kind) => {
                      const latest = [...activeIncident.captureRequests].reverse().find((request) => request.kind === kind);
                      return (
                        <span key={kind} className="inline-flex items-center gap-1">
                          <button
                            onClick={() => { void submitCaptureRequest(kind); }}
                            disabled={captureBusy !== null}
                            className="inline-flex items-center gap-1.5 rounded-md border border-[#203c49] bg-[#fbfbf7] px-2 py-1 text-[11px] font-bold text-[#203c49] transition-colors hover:bg-[#e1efe5] disabled:opacity-40"
                            title="The phone picks the request up on its next contact with the server and reports the outcome to the timeline"
                            data-testid={`button-request-capture-${kind}`}
                          >
                            Ask the phone for {kind}
                          </button>
                          {latest && (
                            <span
                              className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${latest.state === 'FAILED' ? 'border-[#914136] text-[#914136]' : latest.state === 'COMPLETED' ? 'border-[#b9d8c5] text-[#236047]' : 'border-[#c6cbc3] text-[#687271]'}`}
                              title={latest.detail ?? undefined}
                              data-testid={`status-capture-request-${kind}`}
                            >
                              {latest.state === 'PENDING' ? 'Requested' : latest.state === 'STARTED' ? 'In progress' : latest.state === 'COMPLETED' ? 'Done' : 'Failed'}
                            </span>
                          )}
                        </span>
                      );
                    })}
                    {(['audio', 'photo', 'video'] as const).every((kind) => policy[kind] !== 'responder') && (
                      <p className="text-[11px] text-[#687271]">
                        Asking the phone for evidence becomes available once a capture type is set to{' '}
                        <strong>only when a responder asks</strong> on the Evidence capture page.
                      </p>
                    )}
                  </div>
                  {captureError && (
                    <div className="mt-2"><FriendlyErrorMessage error={captureError} testId="text-capture-error" /></div>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-4 border-b border-[#d7d8d0] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex flex-wrap gap-2">{(['all', 'P1', 'P2', 'P3'] as const).map((item) => <button key={item} onClick={() => setFilter(item)} className={`rounded-lg border px-3 py-2 text-[11px] font-bold transition-colors ${filter === item ? 'border-[#203c49] bg-[#203c49] text-[#f2f0e6]' : 'border-[#c6cbc3] text-[#687271] hover:border-[#203c49]'}`} data-testid={`button-filter-priority-${item}`}>{item === 'all' ? 'All events' : `${item} only`}</button>)}</div><button onClick={resetDemo} className="inline-flex items-center gap-2 self-start text-xs font-bold text-[#687271] hover:text-[#203c49]" data-testid="button-reset-incidents"><RotateCcw size={14} /> Reset the sample</button></div>
          {visible.length === 0 ? <div className="p-6"><EmptyState title="Nothing at this urgency level" detail="Pick another level above, or record a test event to add a P3 practice entry." /></div> : <div className="relative px-5 py-5"><div className="absolute bottom-7 left-[38px] top-7 w-px bg-[#d7d8d0]" />{visible.map((incident) => <div key={incident.id} className="relative grid grid-cols-[28px_1fr] gap-4 pb-6 last:pb-0" data-testid={`row-incident-${incident.id}`}><div className="z-10 mt-1 flex h-7 w-7 items-center justify-center rounded-full border border-[#d7d8d0] bg-[#fbfbf7]"><span className={`h-2 w-2 rounded-full ${incident.priority === 'P1' ? 'bg-[#203c49]' : incident.priority === 'P2' ? 'bg-[#e8a629]' : 'bg-[#8ca69f]'}`} /></div><div className="rounded-xl border border-[#e0e1da] bg-[#f7f7f1] p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-center gap-2"><PriorityPill priority={incident.priority} /><h2 className="text-sm font-bold text-[#203c49]">{incident.title}</h2></div><span className="text-[11px] text-[#687271]">{incident.time} UTC</span></div><p className="mt-2 text-sm leading-5 text-[#687271]">{incident.detail}</p><div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#e0e1da] pt-3 text-[11px] font-medium text-[#687271]"><span>Status: <strong className={incident.state === 'Blocked' ? 'text-[#914136]' : incident.state === 'Local only' ? 'text-[#a06712]' : 'text-[#236047]'}>{incident.state}</strong></span><span>Source: {incident.source}</span>{incident.sample ? <EvidenceLabel /> : <span className="text-[#a06712]">Recorded by this console</span>}</div></div></div>)}</div>}
        </div>
        <aside className="space-y-5">
          <div className="rounded-xl border border-[#d7d8d0] bg-[#203c49] p-5 text-[#f2f0e6]"><SectionKicker testId="kicker-priority-model"><span className="text-[#ffd067]">What P1 · P2 · P3 mean</span></SectionKicker><h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">How urgent each entry is.</h2><div className="mt-4 space-y-3"><div className="flex gap-3 border-t border-[#3a5962] pt-3"><PriorityPill priority="P1" /><p className="text-xs leading-5 text-[#c2cec7]">The emergency itself — someone needs help right now.</p></div><div className="flex gap-3 border-t border-[#3a5962] pt-3"><PriorityPill priority="P2" /><p className="text-xs leading-5 text-[#c2cec7]">Supporting news: a delivery going out, a location arriving.</p></div><div className="flex gap-3 border-t border-[#3a5962] pt-3"><PriorityPill priority="P3" /><p className="text-xs leading-5 text-[#c2cec7]">Background notes and practice records.</p></div></div></div>
          <div className="rounded-xl border border-[#d7d8d0] bg-[#fbfbf7] p-5"><SectionKicker testId="kicker-kernel-contract">What this record guarantees</SectionKicker><h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">You can trust the timeline</h2><ul className="mt-4 space-y-3">{[['Order', 'Events stay in the order they happened — alert, deliveries, location.'], ['Urgency', 'Every entry keeps its P1 / P2 / P3 level.'], ['Source', 'Each entry says where it came from and whether a second person can verify it.'], ['Time', 'Entries keep their real timestamps and observed state, not a vague “success”.']].map(([title, detail]) => <li key={title} className="flex gap-3 text-xs leading-5 text-[#687271]"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#e8a629]" /><span><strong className="text-[#203c49]">{title}:</strong> {detail}</span></li>)}</ul></div>
          <div className="rounded-xl border border-[#e8c880] bg-[#fff8e7] p-5"><div className="flex gap-3"><LockKeyhole size={17} className="mt-0.5 shrink-0 text-[#a06712]" /><div><p className="text-sm font-bold text-[#765013]">A record, not a remote control</p><p className="mt-1 text-xs leading-5 text-[#765013]">This timeline never edits history. Sample entries are clearly marked, and real triggers only ever add to the record — nothing here can quietly change what happened.</p></div></div></div>
        </aside>
      </section>
      <div className="mt-5 flex items-center justify-between border-t border-[#d7d8d0] pt-4 text-xs text-[#687271]"><span>Want to check the phone first?</span><Link href="/gates" className="inline-flex items-center gap-1 font-bold text-[#a06712]" data-testid="link-incidents-gates">Review the readiness checks <ArrowRight size={13} /></Link></div>
    </div>
  );
}
