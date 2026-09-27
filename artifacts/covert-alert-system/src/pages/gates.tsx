import { useMemo, useState } from 'react';
import { ArrowRight, Check, ChevronDown, CircleAlert, Download, FileJson, RotateCcw, Save } from 'lucide-react';
import { Link } from 'wouter';
import { Gate0AImportError, useFieldTest, type Gate0AImportIssue, type GateStatus, type ObservationResult } from '@/hooks/use-field-test';
import { EvidenceLabel, SectionKicker, StatusPill } from '@/components/field-ui';
import { assertGate0aReportSize } from '@/lib/gate0a-import';

type GateFilter = 'all' | 'needs-work' | 'verified';

export default function Gates() {
  const { gates, updateGateStatus, resetDemo, fieldRun, recordObservation, importGate0AReport, updateFieldRun, finalizeDecision } = useFieldTest();
  const [filter, setFilter] = useState<GateFilter>('all');
  const [saved, setSaved] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importIssues, setImportIssues] = useState<Gate0AImportIssue[]>([]);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const filtered = useMemo(() => gates.filter((gate) => filter === 'all' || (filter === 'verified' ? gate.status === 'verified' : gate.status === 'partial' || gate.status === 'blocked')), [filter, gates]);

  const saveStatus = (id: string, value: GateStatus) => {
    updateGateStatus(id, value);
    setSaved(id);
    window.setTimeout(() => setSaved(null), 1800);
  };

  const observedCount = Object.keys(fieldRun.observations).length;
  const allObserved = observedCount === gates.length;
  const saveObservation = (id: string, result: ObservationResult, notes: string) => {
    recordObservation(id, { result, notes, recordedAt: new Date().toISOString() });
  };
  const handleGate0AImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setImportError(null);
    setImportIssues([]);
    setImportMessage(null);
    try {
      assertGate0aReportSize(importFile.size);
      const summary = await importGate0AReport(await importFile.text());
      const evidenceLabel = summary.evidenceClass === 'physical-device-observation'
        ? 'physical Pixel evidence'
        : summary.evidenceClass === 'simulated-emulator'
          ? 'simulated emulator evidence'
          : 'sample evidence';
      setImportMessage(`Imported as INCONCLUSIVE ${evidenceLabel}. Preflight: ${summary.preflightStatus}; run: ${summary.runStatus}; unresolved warnings: ${summary.warningCount}. Review the notes before recording a final result.`);
      setImportFile(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Gate 0A report was rejected.');
      setImportIssues(error instanceof Gate0AImportError ? error.issues : []);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1380px]">
        <section className="fade-up flex flex-col justify-between gap-5 border-b border-[#cfd2c9] pb-7 md:flex-row md:items-end"><div><div className="mb-4 flex items-center gap-3"><SectionKicker>Feasibility / 5 gates</SectionKicker><EvidenceLabel /></div><h1 className="font-display text-3xl font-extrabold tracking-[-0.05em] sm:text-5xl">The gates are the work.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687271]">Record what was observed on the managed Pixel. Sample evidence is never treated as physical validation.</p></div><div className="flex flex-wrap gap-2 self-start"><a href="/gate0a-run-guide.pdf" download className="inline-flex items-center gap-2 border border-[#a06712] bg-[#fff8e7] px-3 py-2 text-xs font-bold text-[#765013] hover:border-[#765013]" data-testid="link-gate0a-run-guide"><Download size={14} />Print Gate 0A guide</a><Link href="/setup" className="inline-flex items-center gap-2 border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 text-xs font-bold text-[#203c49] hover:border-[#203c49]" data-testid="link-gates-setup">Open owner setup <ArrowRight size={14} /></Link></div></section>
       <section className="fade-up fade-up-1 mt-5 border border-[#d7d8d0] bg-[#203c49] p-5 text-[#f2f0e6] sm:p-6" data-testid="panel-physical-run">
         <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
           <div><SectionKicker>Physical validation run</SectionKicker><h2 className="mt-1 font-display text-xl font-extrabold">Managed Pixel record</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-[#aec0b8]">Enter the device details before testing. Each gate below gets its own measured timestamp, result, and operator note.</p></div>
           <div className={`border px-3 py-2 text-xs font-bold ${fieldRun.decision === 'go' ? 'border-[#8ac29b] text-[#bce3c8]' : 'border-[#ffd067] text-[#ffd067]'}`} data-testid="text-readiness-decision">Decision: {fieldRun.decision === 'pending' ? 'Pending evidence' : fieldRun.decision === 'go' ? 'GO' : 'NO-GO'}</div>
         </div>
         <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
           <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#aec0b8]">Device model<input value={fieldRun.deviceModel} onChange={(e) => updateFieldRun({ deviceModel: e.target.value })} className="mt-1 w-full border border-[#52707a] bg-[#294b58] px-3 py-2 text-xs font-normal normal-case tracking-normal text-[#f2f0e6] outline-none" data-testid="input-device-model" /></label>
           <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#aec0b8]">Android version<input value={fieldRun.androidVersion} onChange={(e) => updateFieldRun({ androidVersion: e.target.value })} className="mt-1 w-full border border-[#52707a] bg-[#294b58] px-3 py-2 text-xs font-normal normal-case tracking-normal text-[#f2f0e6] outline-none" data-testid="input-android-version" /></label>
           <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#aec0b8]">Build<input value={fieldRun.build} onChange={(e) => updateFieldRun({ build: e.target.value })} placeholder="e.g. AP3A..." className="mt-1 w-full border border-[#52707a] bg-[#294b58] px-3 py-2 text-xs font-normal normal-case tracking-normal text-[#f2f0e6] outline-none placeholder:text-[#78929a]" data-testid="input-device-build" /></label>
           <label className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#aec0b8]">Operator<input value={fieldRun.operator} onChange={(e) => updateFieldRun({ operator: e.target.value })} className="mt-1 w-full border border-[#52707a] bg-[#294b58] px-3 py-2 text-xs font-normal normal-case tracking-normal text-[#f2f0e6] outline-none" data-testid="input-run-operator" /></label>
         </div>
         <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#3a5962] pt-4"><span className="font-mono-ui text-[10px] uppercase tracking-[0.12em] text-[#aec0b8]">{observedCount} / {gates.length} physical observations recorded</span><div className="flex gap-2"><button disabled={!allObserved || Object.values(fieldRun.observations).some((item) => item.result !== 'pass')} onClick={() => finalizeDecision('go')} className="inline-flex items-center gap-2 border border-[#8ac29b] px-3 py-2 text-xs font-bold text-[#bce3c8] disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-decision-go">Mark GO</button><button onClick={() => finalizeDecision('no-go')} className="inline-flex items-center gap-2 border border-[#e7b8af] px-3 py-2 text-xs font-bold text-[#f0c2ba]" data-testid="button-decision-no-go">Mark NO-GO</button></div></div>
       </section>
       <section className="fade-up fade-up-2 mt-5 border border-[#c7d7d2] bg-[#eef5f1] p-5 sm:p-6" data-testid="panel-gate0a-import">
         <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div><div className="flex items-center gap-2"><FileJson size={17} className="text-[#236047]" /><SectionKicker>Native evidence import</SectionKicker></div><h2 className="mt-1 font-display text-xl font-extrabold text-[#203c49]">Import Gate 0A report</h2><p className="mt-1 max-w-2xl text-xs leading-5 text-[#43575a]">Load the JSON report from the disposable Pixel harness. The console validates <span className="font-mono-ui">cas-gate0a-report-v2</span>, accepts the approved Pixel 11 physical target or pinned Pixel 8a/API 35 emulator, and maps the result only to the Proxy Launch observation.</p></div>
           <div className="border border-[#e8c880] bg-[#fff8e7] px-3 py-2 text-[11px] font-bold leading-4 text-[#765013]">Imported reports stay INCONCLUSIVE.<br />They never create a Pass or GO.</div>
         </div>
         <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
           <label className="inline-flex cursor-pointer items-center justify-center gap-2 border border-[#236047] bg-[#fbfbf7] px-3 py-2 text-xs font-bold text-[#236047] hover:bg-[#e1efe5]"><FileJson size={14} />{importFile ? importFile.name : 'Choose JSON report'}<input type="file" accept=".json,application/json" className="sr-only" onChange={(event) => { setImportFile(event.target.files?.[0] || null); setImportError(null); setImportIssues([]); setImportMessage(null); }} data-testid="input-gate0a-report" /></label>
           <button onClick={() => void handleGate0AImport()} disabled={!importFile || importing} className="inline-flex items-center justify-center gap-2 border border-[#203c49] bg-[#203c49] px-3 py-2 text-xs font-bold text-[#f2f0e6] disabled:cursor-not-allowed disabled:opacity-40" data-testid="button-import-gate0a-report">{importing ? 'Validating report…' : 'Validate & import report'}<ArrowRight size={14} /></button>
         </div>
         {importError && <div className="mt-3 border-l-2 border-[#b95042] bg-[#f8e0db] px-3 py-2" role="alert" data-testid="text-gate0a-import-error"><p className="text-xs font-bold leading-5 text-[#914136]">{importError}</p>{importIssues.length > 0 && <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto border-t border-[#e4b6ac] pt-2" data-testid="list-gate0a-import-issues">{importIssues.map((issue, index) => <li key={`${issue.path || 'report'}-${index}`} className="flex items-start gap-2 text-[11px] font-bold leading-4 text-[#914136]"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#b95042]" /><span className="font-mono-ui">{issue.path ? `${issue.path}: ` : ''}{issue.message ?? 'Invalid value'}</span></li>)}</ul>}</div>}
         {importMessage && <p className="mt-3 border-l-2 border-[#236047] bg-[#e1efe5] px-3 py-2 text-xs font-bold leading-5 text-[#236047]" role="status" data-testid="text-gate0a-import-success">{importMessage}</p>}
       </section>
      <section className="fade-up fade-up-1 flex flex-col gap-4 border-b border-[#d7d8d0] py-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex flex-wrap gap-2">{(['all', 'needs-work', 'verified'] as GateFilter[]).map((item) => <button key={item} onClick={() => setFilter(item)} className={`border px-3 py-2 text-xs font-bold transition-colors ${filter === item ? 'border-[#203c49] bg-[#203c49] text-[#f2f0e6]' : 'border-[#c6cbc3] bg-[#fbfbf7] text-[#687271] hover:border-[#203c49] hover:text-[#203c49]'}`} data-testid={`button-filter-${item}`}>{item === 'all' ? 'All gates' : item === 'needs-work' ? 'Needs work' : 'Verified'}</button>)}</div><button onClick={resetDemo} className="inline-flex items-center gap-2 self-start text-xs font-bold text-[#687271] hover:text-[#203c49]" data-testid="button-reset-gates"><RotateCcw size={14} /> Reset sample statuses</button></section>
      <div className="fade-up fade-up-2 mt-5 space-y-3">
        {filtered.length === 0 ? <div className="border border-dashed border-[#c6cbc3] bg-[#f6f6f0] p-12 text-center"><p className="font-display font-bold text-[#203c49]">No gates match this view.</p><button onClick={() => setFilter('all')} className="mt-3 text-xs font-bold text-[#a06712]" data-testid="button-clear-gate-filter">Show all gates</button></div> : filtered.map((gate) => <article key={gate.id} className="border border-[#d7d8d0] bg-[#fbfbf7] transition-shadow hover:shadow-[0_8px_20px_rgba(32,60,73,0.06)]" data-testid={`card-gate-${gate.id}`}>
          <div className="grid gap-5 p-5 lg:grid-cols-[minmax(240px,0.8fr)_minmax(300px,1.25fr)_minmax(240px,0.9fr)] lg:p-6">
            <div className="flex gap-4"><span className="font-mono-ui text-xs text-[#a06712]">{gate.index}</span><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-display text-lg font-extrabold tracking-[-0.03em] text-[#203c49]">{gate.name}</h2><StatusPill status={gate.status} /></div><p className="mt-1 text-sm text-[#687271]">{gate.short}</p><div className="mt-5"><label className="font-mono-ui text-[10px] uppercase tracking-[0.13em] text-[#687271]" htmlFor={`status-${gate.id}`}>Update local status</label><div className="mt-2 flex items-center gap-2"><div className="relative"><select id={`status-${gate.id}`} value={gate.status} onChange={(event) => saveStatus(gate.id, event.target.value as GateStatus)} className="appearance-none border border-[#c6cbc3] bg-[#f4f3ed] py-2 pl-3 pr-8 text-xs font-bold text-[#203c49] outline-none focus:border-[#a06712]" data-testid={`select-gate-status-${gate.id}`}><option value="verified">Verified</option><option value="partial">Partial</option><option value="blocked">Blocked</option><option value="not-started">Not started</option></select><ChevronDown size={13} className="pointer-events-none absolute right-2 top-2.5 text-[#687271]" /></div>{saved === gate.id && <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[#236047]"><Check size={13} />Saved</span>}</div></div></div></div>
             <div className="border-l-0 border-[#e3e4dc] lg:border-l lg:pl-6"><p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-[#a06712]">Acceptance criterion</p><p className="mt-2 text-sm leading-6 text-[#43575a]">{gate.criterion}</p><div className="mt-5"><div className="mb-2 flex items-center justify-between"><span className="font-mono-ui text-[10px] uppercase tracking-[0.13em] text-[#687271]">Evidence on file</span><EvidenceLabel /></div><ul className="space-y-2">{gate.evidence.map((item) => <li key={item} className="flex items-start gap-2 text-xs leading-5 text-[#687271]"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#8ca69f]" />{item}</li>)}</ul>{fieldRun.observations[gate.id] ? <div className="mt-4 border border-[#b9d8c5] bg-[#f0f8f1] p-3" data-testid={`evidence-measured-${gate.id}`}><div className="flex items-center justify-between"><span className="font-mono-ui text-[10px] font-bold uppercase tracking-[0.12em] text-[#236047]">Measured evidence</span><span className="text-[10px] text-[#687271]">{new Date(fieldRun.observations[gate.id].recordedAt).toLocaleString()}</span></div><p className="mt-1 text-xs font-bold text-[#236047]">{fieldRun.observations[gate.id].result.toUpperCase()}</p><p className="mt-1 text-xs leading-5 text-[#43575a]">{fieldRun.observations[gate.id].notes || 'No operator note supplied.'}</p></div> : <div className="mt-4 flex items-start gap-2 border border-[#e8c880] bg-[#fff8e7] p-3 text-xs leading-5 text-[#765013]"><CircleAlert size={14} className="mt-0.5 shrink-0" />No physical observation recorded yet.</div>}</div></div>
             <div className="border-t border-[#e3e4dc] pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0"><p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-[#687271]">Physical observation</p><div className="mt-2 flex gap-2"><select key={`result-${gate.id}-${fieldRun.observations[gate.id]?.recordedAt || 'empty'}`} defaultValue={fieldRun.observations[gate.id]?.result || 'pass'} id={`result-${gate.id}`} className="border border-[#c6cbc3] bg-[#f4f3ed] px-2 py-2 text-xs font-bold text-[#203c49]" data-testid={`select-observation-${gate.id}`}><option value="pass">Pass</option><option value="fail">Fail</option><option value="inconclusive">Inconclusive</option></select><button onClick={() => { const result = (document.getElementById(`result-${gate.id}`) as HTMLSelectElement).value as ObservationResult; const notes = (document.getElementById(`notes-${gate.id}`) as HTMLInputElement).value; saveObservation(gate.id, result, notes); }} className="inline-flex items-center gap-1 border border-[#203c49] px-2.5 py-2 text-xs font-bold text-[#203c49] hover:bg-[#203c49] hover:text-[#f2f0e6]" data-testid={`button-save-observation-${gate.id}`}><Save size={13} />Record now</button></div><input key={`notes-${gate.id}-${fieldRun.observations[gate.id]?.recordedAt || 'empty'}`} id={`notes-${gate.id}`} defaultValue={fieldRun.observations[gate.id]?.notes || ''} placeholder="What did the operator observe?" className="mt-2 w-full border border-[#c6cbc3] bg-[#f4f3ed] px-3 py-2 text-xs text-[#203c49] outline-none" data-testid={`input-observation-notes-${gate.id}`} /><p className="mt-3 text-sm font-semibold leading-6 text-[#203c49]">Next: {gate.nextAction}</p><div className="mt-3 flex items-center justify-between"><span className="text-[11px] text-[#687271]">Owner: <strong className="text-[#43575a]">{gate.owner}</strong></span><span className="font-mono-ui text-[10px] uppercase tracking-[0.11em] text-[#a06712]">Physical record</span></div></div>
          </div>
        </article>)}
      </div>
       <div className="fade-up fade-up-3 mt-5 border-l-2 border-[#e8a629] bg-[#fff8e7] px-5 py-4"><p className="font-mono-ui text-[10px] font-medium uppercase tracking-[0.15em] text-[#a06712]">Decision rule</p><p className="mt-1 text-sm leading-6 text-[#765013]">GO is enabled only when all five gates have timestamped physical observations and every result is Pass. Any missing, failed, or inconclusive gate requires NO-GO or more testing.</p></div>
    </div>
  );
}