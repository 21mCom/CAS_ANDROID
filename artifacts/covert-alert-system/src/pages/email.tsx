import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, Plug, Save, Trash2 } from 'lucide-react';
import { EvidenceLabel, SectionKicker } from '@/components/field-ui';
import { useOutboxStatus, type EmailChannelHealth } from '@/hooks/use-outbox-status';
import { outboxAgeLabel } from '@/lib/outbox-warnings';
import {
  deleteEmailAccount,
  fetchEmailAccounts,
  saveEmailAccount,
  testEmailAccount,
  type EmailAccountInfo,
  type EmailAccountSlot,
  type EmailAccountsResponse,
} from '@/lib/cas-config-api';

type AccountDraft = {
  host: string;
  port: string;
  user: string;
  /** Write-only: never prefilled from the server; blank keeps the stored one. */
  password: string;
  fromAddress: string;
  saved: EmailAccountInfo | null;
  busy: 'save' | 'test' | 'remove' | null;
  notice: string | null;
  error: string | null;
};

const EMPTY_DRAFT: AccountDraft = {
  host: '',
  port: '465',
  user: '',
  password: '',
  fromAddress: '',
  saved: null,
  busy: null,
  notice: null,
  error: null,
};

function draftFor(saved: EmailAccountInfo | undefined): AccountDraft {
  if (!saved) return { ...EMPTY_DRAFT };
  return {
    ...EMPTY_DRAFT,
    host: saved.host,
    port: String(saved.port),
    user: saved.user,
    fromAddress: saved.fromAddress ?? '',
    saved,
  };
}

/**
 * The scheduled mailbox probe's last outcome, mirrored from the outbox
 * status endpoint onto this page — the person fixing a dead mailbox is
 * looking here, not at the incidents panel. The probe is channel-level
 * (one record covering the active account source), so this renders one
 * line scoped to whichever mailbox the probe authenticated against. The
 * server's health registry only ever stores classifications, timestamps,
 * and redacted messages — rendering lastFailure.message exposes nothing
 * the incidents panel does not already show.
 */
export function EmailProbeHealthLine({ health, nowMs }: { health: EmailChannelHealth; nowMs: number }) {
  const age = (iso: string) => outboxAgeLabel(iso, nowMs);
  const scope =
    health.target === 'console'
      ? 'the mailbox saved on this page (primary, and fallback when set)'
      : health.target === 'environment'
        ? 'the server-secrets mailbox (CAS_EMAIL_*)'
        : null;

  if (health.state === 'ok' && health.lastProbeAt && scope) {
    return (
      <p className="mt-5 border border-[#b7cfbf] bg-[#eef5ee] px-5 py-4 text-xs leading-5 text-[#33523f]" data-testid="email-probe-health" data-state="ok">
        Last automatic login check of {scope}: <strong>ok</strong>, {age(health.lastProbeAt)} — the mailbox accepted the server&apos;s credentials. Re-checks every {Math.max(1, Math.round(health.probeIntervalMs / 86_400_000))}d.
      </p>
    );
  }
  if (health.state === 'failed') {
    const failure = health.lastFailure;
    // Mirror the pipeline warning's permanent/transient split: a mailbox
    // refusing authentication is broken until someone fixes it, but a
    // network-class failure may clear on the next probe — stating that as a
    // certain outage would be a false alarm.
    const permanent =
      failure !== null &&
      (failure.classification === 'authentication' ||
        failure.classification === 'not-configured' ||
        failure.classification === 'rejected');
    const when = health.lastProbeAt ?? failure?.at ?? null;
    return (
      <div
        className={`mt-5 border px-5 py-4 text-xs leading-5 ${permanent ? 'border-[#e7b8af] bg-[#f9e9e6] text-[#7c3a30]' : 'border-[#e8c880] bg-[#fff8e7] text-[#765013]'}`}
        data-testid="email-probe-health"
        data-state="failed"
        data-permanent={permanent ? 'true' : 'false'}
      >
        <p>
          Last automatic login check{scope ? ` of ${scope}` : ''}: <strong>failed ({failure?.classification ?? 'unknown'})</strong>
          {when ? `, ${age(when)}` : ''}.{' '}
          {permanent
            ? `Email alerts will not go out until the mailbox is fixed — update the account below${health.target === 'environment' ? ' or the CAS_EMAIL_* server secrets' : ''}.`
            : 'The mailbox could not be verified this run; if this persists, email alerts may not go out.'}
        </p>
        {failure && (
          <p className="mt-1 flex gap-2" data-testid="email-probe-health-detail">
            <CircleAlert size={14} className={`mt-0.5 shrink-0 ${permanent ? 'text-[#914136]' : 'text-[#a06712]'}`} />
            {failure.message}
          </p>
        )}
      </div>
    );
  }
  if (health.state === 'skipped') {
    return (
      <p className="mt-5 border border-[#d0d4cc] bg-[#f4f3ed] px-5 py-4 text-xs leading-5 text-[#5e6867]" data-testid="email-probe-health" data-state="skipped">
        Automatic login check: skipped — {health.note ?? 'not applicable'}.
      </p>
    );
  }
  return (
    <p className="mt-5 border border-[#d0d4cc] bg-[#f4f3ed] px-5 py-4 text-xs leading-5 text-[#5e6867]" data-testid="email-probe-health" data-state="pending">
      Automatic login check{scope ? ` of ${scope}` : ''}: scheduled — the first probe has not run yet (it runs shortly after server start).
    </p>
  );
}

const SOURCE_BANNER: Record<EmailAccountsResponse['source'], { tone: string; text: string }> = {
  console: {
    tone: 'border-[#b7cfbf] bg-[#eef5ee] text-[#33523f]',
    text: 'Console settings are live — the primary account below sends alert email. Any CAS_EMAIL_* server secrets are ignored while a primary account exists here; remove it to hand the channel back to the server environment.',
  },
  environment: {
    tone: 'border-[#f1cf7b] bg-[#fff8e7] text-[#765013]',
    text: 'Server secrets are live — alert email sends via the CAS_EMAIL_* values configured on the server. Saving a primary account here moves the channel into this console.',
  },
  none: {
    tone: 'border-[#e7b8af] bg-[#f9e9e6] text-[#7c3a30]',
    text: 'Not configured — no console account and no server mail secrets, so alert email cannot send. Save a primary account below (or set server secrets) to activate the channel.',
  },
};

function AccountPanel({
  slot,
  title,
  blurb,
  draft,
  onChange,
  onSave,
  onTest,
  onRemove,
}: {
  slot: EmailAccountSlot;
  title: string;
  blurb: string;
  draft: AccountDraft;
  onChange: (patch: Partial<AccountDraft>) => void;
  onSave: () => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  const dirty =
    !draft.saved ||
    draft.host.trim() !== draft.saved.host ||
    Number(draft.port) !== draft.saved.port ||
    draft.user.trim() !== draft.saved.user ||
    (draft.fromAddress.trim() || null) !== draft.saved.fromAddress ||
    draft.password.length > 0;
  const canTest = Boolean(draft.host.trim() && draft.user.trim() && (draft.password || draft.saved));
  return (
    <div className="border border-[#d7d8d0] bg-[#fbfbf7]" data-testid={`panel-email-account-${slot}`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-[#e3e4dc] px-5 py-4">
        <h2 className="font-display text-lg font-extrabold tracking-[-0.03em] text-[#203c49]">{title}</h2>
        <span
          className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${draft.saved ? 'border-[#b7cfbf] bg-[#eef5ee] text-[#33523f]' : 'border-[#d0d4cc] bg-[#e8e9e4] text-[#5e6867]'}`}
          data-testid={`status-email-account-${slot}`}
        >
          {draft.saved ? 'Saved' : slot === 'fallback' ? 'Not set (optional)' : 'Not set'}
        </span>
        {draft.saved && dirty && (
          <span className="font-mono-ui text-[9px] uppercase tracking-[0.1em] text-[#a06712]">unsaved changes</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {draft.saved && (
            <button
              onClick={onRemove}
              disabled={draft.busy !== null}
              className="inline-flex items-center gap-1.5 border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-1.5 text-xs font-bold hover:border-[#b95042] hover:text-[#914136] disabled:opacity-40"
              data-testid={`button-remove-email-${slot}`}
            >
              <Trash2 size={13} /> {draft.busy === 'remove' ? 'Removing…' : 'Remove'}
            </button>
          )}
          <button
            onClick={onTest}
            disabled={!canTest || draft.busy !== null}
            className="inline-flex items-center gap-1.5 border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-1.5 text-xs font-bold hover:border-[#203c49] disabled:cursor-not-allowed disabled:opacity-40"
            data-testid={`button-test-email-${slot}`}
          >
            <Plug size={13} /> {draft.busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <button
            onClick={onSave}
            disabled={!dirty || draft.busy !== null || !draft.host.trim() || !draft.user.trim() || (!draft.password && !draft.saved)}
            className="inline-flex items-center gap-1.5 bg-[#203c49] px-3 py-1.5 text-xs font-bold text-[#ffd067] disabled:cursor-not-allowed disabled:opacity-40"
            data-testid={`button-save-email-${slot}`}
          >
            <Save size={13} /> {draft.busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <div className="px-5 py-4">
        <p className="mb-4 text-[11px] leading-4 text-[#8a8f88]">{blurb}</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="font-mono-ui text-[10px] uppercase tracking-[0.12em] text-[#687271]">SMTP host</span>
            <input
              value={draft.host}
              onChange={(event) => onChange({ host: event.target.value, error: null, notice: null })}
              placeholder="smtp.gmail.com"
              className="mt-1 w-full border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 font-mono-ui text-xs text-[#203c49] focus:border-[#203c49] focus:outline-none"
              data-testid={`input-email-host-${slot}`}
            />
          </label>
          <label className="block">
            <span className="font-mono-ui text-[10px] uppercase tracking-[0.12em] text-[#687271]">Port (465 TLS · 587 STARTTLS)</span>
            <input
              value={draft.port}
              onChange={(event) => onChange({ port: event.target.value.replace(/[^0-9]/g, ''), error: null, notice: null })}
              inputMode="numeric"
              placeholder="465"
              className="mt-1 w-full border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 font-mono-ui text-xs text-[#203c49] focus:border-[#203c49] focus:outline-none"
              data-testid={`input-email-port-${slot}`}
            />
          </label>
          <label className="block">
            <span className="font-mono-ui text-[10px] uppercase tracking-[0.12em] text-[#687271]">Mailbox login</span>
            <input
              value={draft.user}
              onChange={(event) => onChange({ user: event.target.value, error: null, notice: null })}
              placeholder="cas-alerts@example.com"
              autoComplete="off"
              className="mt-1 w-full border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 font-mono-ui text-xs text-[#203c49] focus:border-[#203c49] focus:outline-none"
              data-testid={`input-email-user-${slot}`}
            />
          </label>
          <label className="block">
            <span className="font-mono-ui text-[10px] uppercase tracking-[0.12em] text-[#687271]">App password</span>
            <input
              type="password"
              value={draft.password}
              onChange={(event) => onChange({ password: event.target.value, error: null, notice: null })}
              placeholder={draft.saved ? 'Saved — type to replace' : '16-character app password'}
              autoComplete="new-password"
              className="mt-1 w-full border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 font-mono-ui text-xs text-[#203c49] focus:border-[#203c49] focus:outline-none"
              data-testid={`input-email-password-${slot}`}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="font-mono-ui text-[10px] uppercase tracking-[0.12em] text-[#687271]">From address (optional — defaults to the login)</span>
            <input
              value={draft.fromAddress}
              onChange={(event) => onChange({ fromAddress: event.target.value, error: null, notice: null })}
              placeholder="cas-alerts@example.com"
              autoComplete="off"
              className="mt-1 w-full border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 font-mono-ui text-xs text-[#203c49] focus:border-[#203c49] focus:outline-none"
              data-testid={`input-email-from-${slot}`}
            />
          </label>
        </div>
        {draft.error && (
          <p className="mt-4 flex gap-2 border-l-2 border-[#b95042] bg-[#f9e9e6] px-4 py-3 text-xs leading-5 text-[#7c3a30]" data-testid={`error-email-${slot}`}>
            <CircleAlert size={15} className="mt-0.5 shrink-0 text-[#914136]" />
            {draft.error}
          </p>
        )}
        {draft.notice && (
          <p className="mt-4 flex gap-2 border-l-2 border-[#75b28f] bg-[#eef5ee] px-4 py-3 text-xs leading-5 text-[#33523f]" data-testid={`notice-email-${slot}`}>
            {draft.notice}
          </p>
        )}
      </div>
    </div>
  );
}

export default function EmailDelivery() {
  const [status, setStatus] = useState<EmailAccountsResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<EmailAccountSlot, AccountDraft> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Same credential-gated poll the overview banner and incidents panel use;
  // it waits quietly until this browser has enrolled a console credential.
  const { status: outboxStatus } = useOutboxStatus();

  const load = useCallback(async () => {
    try {
      const response = await fetchEmailAccounts();
      setStatus(response);
      setDrafts({
        primary: draftFor(response.accounts.find((account) => account.slot === 'primary')),
        fallback: draftFor(response.accounts.find((account) => account.slot === 'fallback')),
      });
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load email delivery settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (slot: EmailAccountSlot, changes: Partial<AccountDraft>) => {
    setDrafts((current) => (current ? { ...current, [slot]: { ...current[slot], ...changes } } : current));
  };

  const payloadFor = (draft: AccountDraft) => ({
    host: draft.host.trim(),
    port: Number(draft.port) || undefined,
    user: draft.user.trim(),
    ...(draft.password ? { password: draft.password } : {}),
    fromAddress: draft.fromAddress.trim() || null,
  });

  const save = async (slot: EmailAccountSlot) => {
    const draft = drafts?.[slot];
    if (!draft) return;
    patch(slot, { busy: 'save', error: null, notice: null });
    try {
      await saveEmailAccount(slot, payloadFor(draft));
      await load();
      setDrafts((current) =>
        current ? { ...current, [slot]: { ...current[slot], busy: null, password: '', notice: 'Account saved. Alert email now sends through this mailbox.' } } : current,
      );
    } catch (error) {
      patch(slot, { busy: null, error: error instanceof Error ? error.message : 'Save was rejected.' });
    }
  };

  const test = async (slot: EmailAccountSlot) => {
    const draft = drafts?.[slot];
    if (!draft) return;
    patch(slot, { busy: 'test', error: null, notice: null });
    try {
      const result = await testEmailAccount(slot, payloadFor(draft));
      patch(
        slot,
        result.ok
          ? { busy: null, notice: 'Connection verified — TLS negotiated and the mailbox accepted the credentials. No message was sent.' }
          : { busy: null, error: `${result.message} (${result.classification})` },
      );
    } catch (error) {
      patch(slot, { busy: null, error: error instanceof Error ? error.message : 'The connection test failed.' });
    }
  };

  const remove = async (slot: EmailAccountSlot) => {
    if (!window.confirm(`Remove the ${slot} email account? ${slot === 'primary' ? 'The channel reverts to the server environment secrets if any are set.' : 'Alerts lose the redundant path.'}`)) return;
    patch(slot, { busy: 'remove', error: null, notice: null });
    try {
      await deleteEmailAccount(slot);
      await load();
    } catch (error) {
      patch(slot, { busy: null, error: error instanceof Error ? error.message : 'Remove failed.' });
    }
  };

  const banner = status ? SOURCE_BANNER[status.source] : null;

  return (
    <div className="mx-auto max-w-[1160px]">
      <section className="fade-up border-b border-[#cfd2c9] pb-7">
        <div className="mb-4 flex items-center gap-3"><SectionKicker>Email channel</SectionKicker><EvidenceLabel /></div>
        <h1 className="font-display text-3xl font-extrabold tracking-[-0.05em] sm:text-5xl">Where alert email sends from.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#687271]">
          Connect a dedicated mailbox and alert email sends directly through its SMTP service — no provider account needed. An optional fallback mailbox takes over per recipient whenever the primary fails. TLS is always required; the app password is stored on the server and never shown again.
        </p>
      </section>

      {loadError && <p className="mt-5 border border-[#e7b8af] bg-[#f9e9e6] px-5 py-4 text-sm text-[#7c3a30]" data-testid="text-email-load-error">{loadError}</p>}

      {banner && (
        <p className={`mt-5 border px-5 py-4 text-xs leading-5 ${banner.tone}`} data-testid="text-email-source">
          {banner.text}
        </p>
      )}

      {outboxStatus?.email && <EmailProbeHealthLine health={outboxStatus.email} nowMs={Date.now()} />}

      <section className="fade-up fade-up-1 mt-5 space-y-5">
        {drafts && (['primary', 'fallback'] as const).map((slot) => (
          <AccountPanel
            key={slot}
            slot={slot}
            title={slot === 'primary' ? 'Primary mailbox' : 'Fallback mailbox'}
            blurb={
              slot === 'primary'
                ? 'Sends every alert email. Use a dedicated account — not your everyday inbox — protected by an app password.'
                : 'Optional redundancy. When the primary refuses or cannot reach a recipient, that recipient is tried once through this account instead — never duplicated.'
            }
            draft={drafts[slot]}
            onChange={(changes) => patch(slot, changes)}
            onSave={() => void save(slot)}
            onTest={() => void test(slot)}
            onRemove={() => void remove(slot)}
          />
        ))}
      </section>

      <section className="fade-up fade-up-2 mt-5 border border-[#d7d8d0] bg-[#f4f3ed] p-5">
        <h2 className="font-display font-extrabold tracking-[-0.02em]">Mailbox setup</h2>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs leading-5 text-[#687271]">
          <li>Create a dedicated mailbox (a free Gmail account works well) used only for alerts.</li>
          <li>Turn on 2-step verification, then generate an app password (Google Account → Security → App passwords) and paste it above.</li>
          <li>Press <strong>Test connection</strong> — it proves TLS and the credentials without sending anything.</li>
          <li>Have each responder add the alert mailbox to their contacts so alerts bypass the spam folder.</li>
        </ol>
        <p className="mt-3 text-xs leading-5 text-[#687271]">
          Storage note: the app password is kept in the server database so the server can authenticate on every send; this console never displays it after saving. Anyone with database access can read it — the same exposure as the server secrets file. Configuration here takes precedence over the CAS_EMAIL_* server secrets while a primary account exists.
        </p>
      </section>
    </div>
  );
}
