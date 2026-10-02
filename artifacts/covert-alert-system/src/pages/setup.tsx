import { useMemo, useState } from 'react';
import { Check, ChevronRight, CircleAlert, RotateCcw, Save, ShieldCheck } from 'lucide-react';
import { Link } from 'wouter';
import { useFieldTest } from '@/hooks/use-field-test';
import { EvidenceLabel, Meter, SectionKicker } from '@/components/field-ui';
import { DeviceCredentialsPanel } from '@/components/device-credentials';
import { AppUpdatePanel } from '@/components/app-update-status';

/** Display names for the server-seeded checklist groups (the stored values stay unchanged). */
const GROUP_TITLES: Record<string, string> = {
  'Device surface': 'The phone itself',
  Connectivity: 'Connections',
  Delivery: 'Who gets alerted',
  'Entry path': 'Opening the alert',
  'Run control': 'During the test',
};

export default function Setup() {
  const { setup, toggleSetupItem, resetDemo } = useFieldTest();
  const [saved, setSaved] = useState(false);
  const complete = useMemo(() => setup.filter((item) => item.complete).length, [setup]);
  const groups = Array.from(new Set(setup.map((item) => item.group)));
  const markItem = (id: string) => {
    toggleSetupItem(id);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div className="mx-auto max-w-[1160px]">
      <section className="fade-up flex flex-col justify-between gap-5 border-b border-[#cfd2c9] pb-7 md:flex-row md:items-end"><div><div className="mb-4 flex items-center gap-3"><SectionKicker testId="kicker-owner-setup-/-readiness">Setup checklist</SectionKicker><EvidenceLabel /></div><h1 className="font-display text-3xl font-extrabold tracking-[-0.05em] sm:text-5xl">Get everything ready before the next test.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687271]">Work through this list before a test session. Things you&apos;ve confirmed yourself stay clearly separate from what&apos;s been measured on the phone, so the readiness call stays honest.</p></div><div className="flex items-center gap-2 text-xs text-[#687271]">{saved && <span className="inline-flex items-center gap-1 text-[#236047]"><Save size={13} /> Saved</span>}<button onClick={resetDemo} className="inline-flex items-center gap-2 rounded-lg border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 font-bold hover:border-[#203c49]" data-testid="button-reset-setup"><RotateCcw size={14} /> Reset the checklist</button></div></section>
      <section className="fade-up fade-up-1 mt-5 rounded-xl border border-[#d7d8d0] bg-[#203c49] p-5 text-[#f2f0e6] sm:p-6"><div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"><div><SectionKicker testId="kicker-readiness-meter"><span className="text-[#ffd067]">Your progress</span></SectionKicker><div className="mt-2 flex items-baseline gap-2"><span className="font-display text-4xl font-extrabold tracking-[-0.06em] text-[#ffd067]">{complete}</span><span className="text-xs text-[#aec0b8]">of {setup.length} done</span></div><p className="mt-1 max-w-xl text-xs leading-5 text-[#aec0b8]">This checklist is saved on the server, so it&apos;s still here after a refresh. Ticking an item doesn&apos;t mark its readiness check as verified — only evidence from the phone does that.</p></div><div className="w-full sm:w-64"><div className="mb-2 flex justify-between text-[11px] font-semibold text-[#aec0b8]"><span>Checklist progress</span><span>{Math.round((complete / setup.length) * 100)}%</span></div><Meter value={complete} total={setup.length} color="bg-[#ffd067]" /></div></div></section>
      {complete < setup.length && <div className="fade-up fade-up-2 mt-5 flex gap-3 rounded-xl border-l-2 border-[#e8a629] bg-[#fff8e7] px-5 py-4"><CircleAlert size={18} className="mt-0.5 shrink-0 text-[#a06712]" /><div><p className="text-sm font-bold text-[#765013]">Before the next test session</p><p className="mt-1 text-xs leading-5 text-[#765013]">Confirm the shortcut and test mode with the owner. Text messages go from the phone&apos;s own SIM; WhatsApp, chat (XMPP), and email are sent by the server through the services you&apos;ve configured — the phone never opens another app.</p></div></div>}
      <section className="fade-up fade-up-2 mt-5 space-y-5">
        {groups.map((group) => <div key={group} className="rounded-xl border border-[#d7d8d0] bg-[#fbfbf7]"><div className="flex items-center justify-between border-b border-[#d7d8d0] px-5 py-4"><div><SectionKicker testId={`kicker-${group.toLowerCase().replaceAll(' ', '-')}`}>{GROUP_TITLES[group] ?? group}</SectionKicker><h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">{GROUP_TITLES[group] ?? group}</h2></div><span className="text-[11px] font-semibold text-[#687271]">{setup.filter((item) => item.group === group && item.complete).length} of {setup.filter((item) => item.group === group).length}</span></div><div className="divide-y divide-[#e3e4dc]">{setup.filter((item) => item.group === group).map((item) => <div key={item.id} className="flex items-start gap-4 px-5 py-4 transition-colors hover:bg-[#f7f7f1]" data-testid={`row-setup-${item.id}`}><button onClick={() => markItem(item.id)} className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ${item.complete ? 'border-[#236047] bg-[#236047] text-[#f2f0e6]' : 'border-[#9da9a3] bg-[#f7f7f1] text-transparent hover:border-[#a06712]'}`} aria-label={`${item.complete ? 'Unmark' : 'Mark'} ${item.label}`} data-testid={`button-toggle-setup-${item.id}`}><Check size={13} strokeWidth={3} /></button><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className={`text-sm font-bold ${item.complete ? 'text-[#43575a]' : 'text-[#203c49]'}`}>{item.label}</p><span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${item.mode === 'measured' ? 'border-[#f1cf7b] bg-[#fff8e7] text-[#8a5a09]' : 'border-[#d0d4cc] text-[#687271]'}`}>{item.mode === 'measured' ? 'confirmed on the phone' : 'confirmed by you'}</span></div><p className="mt-1 max-w-2xl text-xs leading-5 text-[#687271]">{item.detail}</p></div><ChevronRight size={16} className="mt-1 shrink-0 text-[#b0b5ad]" /></div>)}</div></div>)}
      </section>
      <DeviceCredentialsPanel />
      <AppUpdatePanel />
      <section className="fade-up fade-up-3 mt-5 grid gap-5 md:grid-cols-2"><div className="rounded-xl border border-[#d7d8d0] bg-[#fbfbf7] p-5"><div className="flex gap-3"><ShieldCheck size={19} className="mt-0.5 text-[#236047]" /><div><h2 className="font-display font-extrabold tracking-[-0.02em]">Checklist done?</h2><p className="mt-1 text-xs leading-5 text-[#687271]">Head to the readiness checks to turn this preparation into measured, on-phone evidence. The checklist stays as your record of what was true before the run.</p><Link href="/gates" className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-[#a06712]" data-testid="link-setup-gates">Open the readiness checks <ChevronRight size={14} /></Link></div></div></div><div className="rounded-xl border border-[#d7d8d0] bg-[#f4f3ed] p-5"><h2 className="font-display font-extrabold tracking-[-0.02em]">What this console can&apos;t tell you</h2><p className="mt-2 text-xs leading-5 text-[#687271]">It doesn&apos;t judge encryption, attacker behavior, or app-store readiness, and it makes no promises about production use. It records the questions you can answer — clearly, and in plain sight.</p></div></section>
    </div>
  );
}
