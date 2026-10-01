import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, RotateCcw, Save } from 'lucide-react';
import { EvidenceLabel, FriendlyErrorMessage, SectionKicker } from '@/components/field-ui';
import {
  fetchTemplates,
  previewTemplate,
  resetTemplate,
  saveTemplate,
  type TemplateInfo,
} from '@/lib/cas-config-api';

type DraftState = {
  body: string;
  saved: TemplateInfo;
  preview: string | null;
  warnings: string[];
  error: string | null;
  saving: boolean;
};

const CHANNEL_NOTES: Record<string, string> = {
  SMS: 'Sent from the phone’s own SIM (or the server’s text gateway). Keep it to one 160-character text when you can — longer messages are split, and the preview flags that below.',
  XMPP: 'Sent as a chat message through the chat (XMPP) service configured on the server.',
  EMAIL: 'Sent through the mailbox on the Email alerts page; the subject line stays "CAS <priority> alert <incident>".',
  WHATSAPP: 'Sent through the WhatsApp Business service configured on the server.',
};

export default function Messages() {
  const [drafts, setDrafts] = useState<Record<string, DraftState> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const previewTimers = useRef<Record<string, number>>({});

  const load = async () => {
    try {
      const templates = await fetchTemplates();
      const next: Record<string, DraftState> = {};
      for (const template of templates) {
        next[template.channel] = { body: template.body, saved: template, preview: template.preview, warnings: template.warnings, error: null, saving: false };
      }
      setDrafts(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load the alert messages.');
    }
  };

  useEffect(() => {
    let cancelled = false;
    const loadOnce = async () => {
      try {
        const templates = await fetchTemplates();
        if (cancelled) return;
        const next: Record<string, DraftState> = {};
        for (const template of templates) {
          next[template.channel] = { body: template.body, saved: template, preview: template.preview, warnings: template.warnings, error: null, saving: false };
        }
        setDrafts(next);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Unable to load the alert messages.');
      }
    };
    void loadOnce();
    return () => { cancelled = true; };
  }, []);

  const schedulePreview = (channel: string, body: string) => {
    window.clearTimeout(previewTimers.current[channel]);
    previewTimers.current[channel] = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await previewTemplate(channel, body);
          setDrafts((current) => {
            if (!current || current[channel]?.body !== body) return current;
            return {
              ...current,
              [channel]: result.ok
                ? { ...current[channel], preview: result.preview, warnings: result.warnings, error: null }
                : { ...current[channel], preview: null, warnings: [], error: result.error },
            };
          });
        } catch (error) {
          setDrafts((current) =>
            current && current[channel]?.body === body
              ? { ...current, [channel]: { ...current[channel], error: error instanceof Error ? error.message : 'Preview failed.' } }
              : current,
          );
        }
      })();
    }, 400);
  };

  const editBody = (channel: string, body: string) => {
    setDrafts((current) => (current ? { ...current, [channel]: { ...current[channel], body, error: null } } : current));
    if (body.trim().length > 0) schedulePreview(channel, body);
  };

  const save = async (channel: string) => {
    const draft = drafts?.[channel];
    if (!draft) return;
    setDrafts((current) => (current ? { ...current, [channel]: { ...current[channel], saving: true, error: null } } : current));
    try {
      const saved = await saveTemplate(channel, draft.body);
      setDrafts((current) =>
        current ? { ...current, [channel]: { body: saved.body, saved, preview: saved.preview, warnings: saved.warnings, error: null, saving: false } } : current,
      );
    } catch (error) {
      setDrafts((current) =>
        current ? { ...current, [channel]: { ...current[channel], saving: false, error: error instanceof Error ? error.message : 'Save was rejected.' } } : current,
      );
    }
  };

  const reset = async (channel: string) => {
    if (!window.confirm(`Restore the built-in default wording for ${channel}? Your custom text is discarded.`)) return;
    try {
      const saved = await resetTemplate(channel);
      setDrafts((current) =>
        current ? { ...current, [channel]: { body: saved.body, saved, preview: saved.preview, warnings: saved.warnings, error: null, saving: false } } : current,
      );
    } catch (error) {
      setDrafts((current) =>
        current ? { ...current, [channel]: { ...current[channel], error: error instanceof Error ? error.message : 'Reset failed.' } } : current,
      );
    }
  };

  const channels = useMemo(() => Object.keys(drafts ?? {}), [drafts]);

  return (
    <div className="mx-auto max-w-[1160px]">
      <section className="fade-up border-b border-[#cfd2c9] pb-7">
        <div className="mb-4 flex items-center gap-3"><SectionKicker testId="kicker-alert-wording">Alert messages</SectionKicker><EvidenceLabel /></div>
        <h1 className="font-display text-3xl font-extrabold tracking-[-0.05em] sm:text-5xl">What responders receive.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#687271]">
          One message per channel. The preview shows exactly what a responder would receive for a current P1 alert with a fresh location — placeholders like the name or location are filled in at send time, and anything that looks like a password or key is refused.
        </p>
      </section>

      {loadError && (
        <div className="mt-5" data-testid="text-templates-load-error">
          <FriendlyErrorMessage error={loadError} onRetry={() => void load()} />
        </div>
      )}

      <section className="fade-up fade-up-1 mt-5 space-y-5">
        {channels.map((channel) => {
          const draft = drafts?.[channel];
          if (!draft) return null;
          const dirty = draft.body.trim() !== draft.saved.body;
          return (
            <div key={channel} className="rounded-xl border border-[#d7d8d0] bg-[#fbfbf7]" data-testid={`panel-template-${channel}`}>
              <div className="flex flex-wrap items-center gap-3 border-b border-[#e3e4dc] px-5 py-4">
                <h2 className="font-display text-lg font-extrabold tracking-[-0.03em] text-[#203c49]">{channel === 'XMPP' ? 'Chat (XMPP)' : channel === 'SMS' ? 'SMS text' : channel === 'EMAIL' ? 'Email' : channel === 'WHATSAPP' ? 'WhatsApp' : channel}</h2>
                <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${draft.saved.source === 'custom' ? 'border-[#f1cf7b] bg-[#fff1cf] text-[#8a5a09]' : 'border-[#d0d4cc] bg-[#e8e9e4] text-[#5e6867]'}`} data-testid={`status-template-${channel}`}>
                  {draft.saved.source === 'custom' ? 'Custom wording' : 'Built-in default'}
                </span>
                {dirty && <span className="text-[11px] font-semibold text-[#a06712]">Unsaved changes</span>}
                <div className="ml-auto flex items-center gap-2">
                  {draft.saved.source === 'custom' && (
                    <button onClick={() => void reset(channel)} className="inline-flex items-center gap-1.5 rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-1.5 text-xs font-bold hover:border-[#203c49]" data-testid={`button-reset-template-${channel}`}>
                      <RotateCcw size={13} /> Default
                    </button>
                  )}
                  <button
                    onClick={() => void save(channel)}
                    disabled={!dirty || draft.saving}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#203c49] px-3 py-1.5 text-xs font-bold text-[#ffd067] disabled:cursor-not-allowed disabled:opacity-40"
                    data-testid={`button-save-template-${channel}`}
                  >
                    <Save size={13} /> {draft.saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
              <div className="grid gap-5 px-5 py-4 lg:grid-cols-2">
                <div>
                  <textarea
                    value={draft.body}
                    onChange={(event) => editBody(channel, event.target.value)}
                    rows={4}
                    maxLength={2000}
                    className="w-full rounded-lg border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 font-mono-ui text-xs leading-5 text-[#203c49] focus:border-[#203c49] focus:outline-none"
                    data-testid={`input-template-${channel}`}
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {draft.saved.placeholders.map((token) => (
                      <button
                        key={token}
                        type="button"
                        onClick={() => editBody(channel, `${draft.body}{{${token}}}`)}
                        className="rounded-md border border-[#d0d4cc] bg-[#f4f3ed] px-2 py-1 font-mono-ui text-[10px] text-[#43575a] hover:border-[#203c49]"
                        title={`Insert {{${token}}}`}
                        data-testid={`chip-placeholder-${channel}-${token}`}
                      >
                        {`{{${token}}}`}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] leading-4 text-[#8a8f88]">{CHANNEL_NOTES[channel]}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#687271]">Preview — what a responder receives</p>
                  {draft.error ? (
                    <div className="mt-2" data-testid={`error-template-${channel}`}>
                      <FriendlyErrorMessage error={draft.error} />
                    </div>
                  ) : (
                    <p className="mt-2 whitespace-pre-wrap rounded-lg border border-[#d7d8d0] bg-[#f4f3ed] px-4 py-3 font-mono-ui text-xs leading-5 text-[#203c49]" data-testid={`preview-template-${channel}`}>
                      {draft.preview ?? '…'}
                    </p>
                  )}
                  {draft.warnings.map((warning) => (
                    <p key={warning} className="mt-2 flex gap-2 rounded-lg border-l-2 border-[#e8a629] bg-[#fff8e7] px-4 py-2 text-[11px] leading-4 text-[#765013]" data-testid={`warning-template-${channel}`}>
                      <CircleAlert size={13} className="mt-0.5 shrink-0 text-[#a06712]" />
                      {warning}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <section className="fade-up fade-up-2 mt-5 rounded-xl border border-[#d7d8d0] bg-[#f4f3ed] p-5">
        <h2 className="font-display font-extrabold tracking-[-0.02em]">What stays on the server</h2>
        <p className="mt-2 text-xs leading-5 text-[#687271]">
          Messages never carry delivery passwords — those stay in the server settings, and text that looks like a key or password is refused. When the phone sends texts itself, the console hands it the finished message with every alert; the phone&apos;s own fallback wording applies only when the console is unreachable.
        </p>
      </section>
    </div>
  );
}
