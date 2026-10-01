import { useEffect, useState, type FormEvent } from 'react';
import { Pencil, Plus, UserCheck, UserX } from 'lucide-react';
import { EvidenceLabel, FriendlyErrorMessage, SectionKicker } from '@/components/field-ui';
import {
  createResponder,
  fetchResponders,
  updateResponder,
  type Responder,
  type ResponderPayload,
} from '@/lib/cas-config-api';

type ChannelDraft = { smsNumber: string; whatsappNumber: string; emailAddress: string; xmppAddress: string };

const emptyDraft: ChannelDraft = { smsNumber: '', whatsappNumber: '', emailAddress: '', xmppAddress: '' };

function draftFromResponder(responder: Responder): ChannelDraft {
  return {
    smsNumber: responder.channels.sms ?? '',
    whatsappNumber: responder.channels.whatsapp ?? '',
    emailAddress: responder.channels.email ?? '',
    xmppAddress: responder.channels.xmpp ?? '',
  };
}

function payloadFromDraft(draft: ChannelDraft): ResponderPayload {
  const trim = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    smsNumber: trim(draft.smsNumber),
    whatsappNumber: trim(draft.whatsappNumber),
    emailAddress: trim(draft.emailAddress),
    xmppAddress: trim(draft.xmppAddress),
  };
}

const CHANNEL_INPUTS: Array<{ key: keyof ChannelDraft; label: string; placeholder: string; testid: string }> = [
  { key: 'smsNumber', label: 'SMS number (text message)', placeholder: '+1 555 000 1111', testid: 'input-responder-sms' },
  { key: 'whatsappNumber', label: 'WhatsApp number', placeholder: '+1 555 000 1111', testid: 'input-responder-whatsapp' },
  { key: 'emailAddress', label: 'Email address', placeholder: 'responder@example.org', testid: 'input-responder-email' },
  { key: 'xmppAddress', label: 'Chat address (XMPP — like an email address for chat)', placeholder: 'responder@example.org', testid: 'input-responder-xmpp' },
];

function ChannelFields({ draft, onChange, idPrefix }: { draft: ChannelDraft; onChange: (next: ChannelDraft) => void; idPrefix: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {CHANNEL_INPUTS.map(({ key, label, placeholder, testid }) => (
        <label key={key} className="block">
          <span className="text-xs font-semibold text-[#687271]">{label}</span>
          <input
            value={draft[key]}
            onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
            placeholder={placeholder}
            className="mt-1 w-full rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 text-sm text-[#203c49] focus:border-[#203c49] focus:outline-none"
            data-testid={`${testid}${idPrefix}`}
          />
        </label>
      ))}
    </div>
  );
}

const CHANNEL_LABELS: Array<{ key: keyof Responder['channels']; label: string }> = [
  { key: 'sms', label: 'SMS' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'email', label: 'Email' },
  { key: 'xmpp', label: 'Chat (XMPP)' },
];

export default function Responders() {
  const [responders, setResponders] = useState<Responder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addName, setAddName] = useState('');
  const [addDraft, setAddDraft] = useState<ChannelDraft>(emptyDraft);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDraft, setEditDraft] = useState<ChannelDraft>(emptyDraft);

  const reload = async () => {
    try {
      const result = await fetchResponders();
      setResponders(result.responders);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load responders.');
    }
  };

  useEffect(() => { void reload(); }, []);

  const runAction = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
      await reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The change was rejected.');
    }
  };

  const submitAdd = (event: FormEvent) => {
    event.preventDefault();
    void runAction(async () => {
      await createResponder({ name: addName, ...payloadFromDraft(addDraft) });
      setAddName('');
      setAddDraft(emptyDraft);
      setAdding(false);
    });
  };

  const startEdit = (responder: Responder) => {
    setEditingId(responder.id);
    setEditName(responder.name);
    setEditDraft(draftFromResponder(responder));
  };

  const submitEdit = (event: FormEvent) => {
    event.preventDefault();
    if (!editingId) return;
    const id = editingId;
    void runAction(async () => {
      await updateResponder(id, { name: editName, ...payloadFromDraft(editDraft) });
      setEditingId(null);
    });
  };

  const toggleEnabled = (responder: Responder) =>
    void runAction(() => updateResponder(responder.id, { enabled: !responder.enabled }));

  const seededCount = (responders ?? []).filter((responder) => responder.seeded).length;

  return (
    <div className="mx-auto max-w-[1160px]">
      <section className="fade-up flex flex-col justify-between gap-5 border-b border-[#cfd2c9] pb-7 md:flex-row md:items-end">
        <div>
          <div className="mb-4 flex items-center gap-3"><SectionKicker testId="kicker-responder-circle">Your responders</SectionKicker><EvidenceLabel /></div>
          <h1 className="font-display text-3xl font-extrabold tracking-[-0.05em] sm:text-5xl">Who gets alerted.</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[#687271]">
            The people who hear first when an alert goes out. Each person is contacted on every channel filled in for them — text messages go from the phone&apos;s own SIM, while WhatsApp, chat (XMPP), and email are sent by the server. Changes take effect on the next alert.
          </p>
        </div>
        <button onClick={() => setAdding((open) => !open)} className="inline-flex items-center gap-2 self-start rounded-lg bg-[#203c49] px-4 py-3 text-xs font-bold text-[#f2f0e6] transition-colors hover:bg-[#2d4a55]" data-testid="button-toggle-add-responder">
          {adding ? 'Close' : <><Plus size={14} /> Add a responder</>}
        </button>
      </section>

      {seededCount > 0 && (
        <div className="fade-up fade-up-1 mt-5 flex gap-3 rounded-xl border-l-2 border-[#9eb7ad] bg-[#eef3ef] px-5 py-4" data-testid="banner-seeded-responders">
          <UserCheck size={18} className="mt-0.5 shrink-0 text-[#236047]" />
          <p className="text-xs leading-5 text-[#2c4a3c]">
            {seededCount} responder{seededCount === 1 ? '' : 's'} came from the server&apos;s recipient lists on first run. Those lists are now ignored — this page is in charge. Rename the imported entries to the people they belong to.
          </p>
        </div>
      )}

      {actionError && (
        <div className="mt-5" data-testid="banner-responder-error">
          <FriendlyErrorMessage error={actionError} />
        </div>
      )}

      {adding && (
        <form onSubmit={submitAdd} className="fade-up mt-5 rounded-xl border border-[#d7d8d0] bg-[#fbfbf7] p-5" data-testid="form-add-responder">
          <SectionKicker testId="kicker-new-responder">New responder</SectionKicker>
          <label className="mt-3 block max-w-md">
            <span className="text-xs font-semibold text-[#687271]">Name</span>
            <input
              value={addName}
              onChange={(event) => setAddName(event.target.value)}
              required
              maxLength={80}
              placeholder="e.g. Alex (sister)"
              className="mt-1 w-full rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 text-sm text-[#203c49] focus:border-[#203c49] focus:outline-none"
              data-testid="input-responder-name"
            />
          </label>
          <div className="mt-4"><ChannelFields draft={addDraft} onChange={setAddDraft} idPrefix="" /></div>
          <p className="mt-3 text-xs text-[#687271]">Fill in at least one way to reach them. A person is alerted on every channel you fill in.</p>
          <button type="submit" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#203c49] px-4 py-2 text-xs font-bold text-[#ffd067]" data-testid="button-save-responder">
            <Plus size={14} /> Add to your responders
          </button>
        </form>
      )}

      <section className="fade-up fade-up-1 mt-5 space-y-4">
        {loadError && (
          <div data-testid="text-responders-load-error">
            <FriendlyErrorMessage error={loadError} onRetry={() => void reload()} />
          </div>
        )}
        {responders && responders.length === 0 && (
          <p className="rounded-xl border border-dashed border-[#c6cbc3] bg-[#f6f6f0] px-6 py-10 text-center text-sm text-[#687271]" data-testid="text-no-responders">
            No responders yet — add the people who should be contacted first. Until someone is added here, alerts fall back to the server&apos;s recipient lists.
          </p>
        )}
        {(responders ?? []).map((responder) => (
          <div key={responder.id} className={`rounded-xl border border-[#d7d8d0] bg-[#fbfbf7] ${responder.enabled ? '' : 'opacity-70'}`} data-testid={`row-responder-${responder.id}`}>
            <div className="flex flex-wrap items-center gap-3 border-b border-[#e3e4dc] px-5 py-4">
              <p className="font-display text-base font-extrabold tracking-[-0.02em] text-[#203c49]">{responder.name}</p>
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${responder.enabled ? 'border-[#b9d8c5] bg-[#e1efe5] text-[#236047]' : 'border-[#d0d4cc] bg-[#e8e9e4] text-[#5e6867]'}`} data-testid={`status-responder-${responder.id}`}>
                {responder.enabled ? 'Enabled' : 'Disabled'}
              </span>
              {responder.seeded && <span className="text-[10px] font-semibold text-[#687271]">imported from server settings</span>}
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => toggleEnabled(responder)} className="inline-flex items-center gap-1.5 rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-1.5 text-xs font-bold hover:border-[#203c49]" data-testid={`button-toggle-responder-${responder.id}`}>
                  {responder.enabled ? <UserX size={13} /> : <UserCheck size={13} />} {responder.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onClick={() => (editingId === responder.id ? setEditingId(null) : startEdit(responder))} className="inline-flex items-center gap-1.5 rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-1.5 text-xs font-bold hover:border-[#203c49]" data-testid={`button-edit-responder-${responder.id}`}>
                  <Pencil size={13} /> {editingId === responder.id ? 'Close' : 'Edit'}
                </button>
              </div>
            </div>
            {editingId === responder.id ? (
              <form onSubmit={submitEdit} className="px-5 py-4" data-testid={`form-edit-responder-${responder.id}`}>
                <label className="block max-w-md">
                  <span className="text-xs font-semibold text-[#687271]">Name</span>
                  <input
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    required
                    maxLength={80}
                    className="mt-1 w-full rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 text-sm text-[#203c49] focus:border-[#203c49] focus:outline-none"
                    data-testid="input-edit-responder-name"
                  />
                </label>
                <div className="mt-4"><ChannelFields draft={editDraft} onChange={setEditDraft} idPrefix="-edit" /></div>
                <p className="mt-3 text-xs text-[#687271]">Clearing a channel removes this person from it. Clearing them all keeps the person on the list but alerts skip them.</p>
                <div className="mt-4 flex gap-2">
                  <button type="submit" className="inline-flex items-center gap-2 rounded-lg bg-[#203c49] px-4 py-2 text-xs font-bold text-[#ffd067]" data-testid="button-save-edit-responder">Save changes</button>
                  <button type="button" onClick={() => setEditingId(null)} className="rounded-lg border border-[#c6cbc3] px-4 py-2 text-xs font-bold text-[#43575a]" data-testid="button-cancel-edit-responder">Cancel</button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-x-6 gap-y-2 px-5 py-4">
                {CHANNEL_LABELS.filter(({ key }) => responder.channels[key]).map(({ key, label }) => (
                  <span key={key} className="font-mono-ui text-xs text-[#43575a]" data-testid={`chip-${key}-${responder.id}`}>
                    <span className="mr-1.5 font-bold text-[#a06712]">{label}</span>{responder.channels[key]}
                  </span>
                ))}
                {CHANNEL_LABELS.every(({ key }) => !responder.channels[key]) && (
                  <span className="text-xs italic text-[#8a8f88]">No way to reach this person — alerts skip them.</span>
                )}
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="fade-up fade-up-2 mt-5 rounded-xl border border-[#d7d8d0] bg-[#f4f3ed] p-5">
        <h2 className="font-display font-extrabold tracking-[-0.02em]">What lives where</h2>
        <p className="mt-2 text-xs leading-5 text-[#687271]">
          This page decides who is alerted and how they&apos;re reached. The delivery accounts and passwords stay on the server; the words responders receive are edited under Alert messages. Text messages always go out from the phone&apos;s own SIM.
        </p>
      </section>
    </div>
  );
}
