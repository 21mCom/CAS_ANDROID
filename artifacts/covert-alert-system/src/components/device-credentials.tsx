import { useReducer, useRef, useState } from 'react';
import { KeyRound, RefreshCw, ShieldOff, Smartphone, Unlock, X } from 'lucide-react';
import { listCasDevices, revokeCasDevice, type CasDevice } from '@/hooks/use-field-test';
import { FriendlyErrorMessage, SectionKicker } from '@/components/field-ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Credential-retention state for the panel, expressed as pure transitions so
 * the security invariants are testable without a DOM: the enrollment
 * credential is held in memory only, and is forgotten — including the
 * half-typed dialog input — when the dialog is dismissed, when the
 * credential is rejected, and when the panel is closed with Done. Nothing
 * here ever touches web storage.
 */
export type PanelCredentialState = {
  /** Accepted credential, held in memory only; null while the panel is locked. */
  credential: string | null;
  dialogOpen: boolean;
  /** Half-typed dialog input; cleared on every dismiss / accept / reject. */
  entered: string;
  rejection: string | null;
};

export const initialPanelCredentialState: PanelCredentialState = {
  credential: null,
  dialogOpen: false,
  entered: '',
  rejection: null,
};

export type PanelCredentialEvent =
  | { type: 'open' }
  | { type: 'dismiss' }
  | { type: 'type'; value: string }
  | { type: 'submit' }
  | { type: 'accepted'; credential: string }
  | { type: 'rejected'; message: string }
  | { type: 'forget' };

export function reducePanelCredential(
  state: PanelCredentialState,
  event: PanelCredentialEvent,
): PanelCredentialState {
  switch (event.type) {
    case 'open':
      return { ...state, dialogOpen: true, entered: '', rejection: null };
    case 'dismiss':
      // Whatever was typed dies with the dialog.
      return { ...state, dialogOpen: false, entered: '', rejection: null };
    case 'type':
      return { ...state, entered: event.value };
    case 'submit':
      return { ...state, rejection: null };
    case 'accepted':
      return { credential: event.credential, dialogOpen: false, entered: '', rejection: null };
    case 'rejected':
      // Rejected credential: keep nothing — not even the typed input — so a
      // mistyped or stale value is never retained. The dialog stays open
      // with the reason inline so the operator can retry.
      return { ...state, credential: null, entered: '', rejection: event.message };
    case 'forget':
      return { ...state, credential: null };
  }
}

/** Deterministic "YYYY-MM-DD HH:mm UTC" rendering for list rows and tests. */
export function formatDeviceTimestamp(iso: string | null): string {
  if (!iso) return 'never';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Pure view for the enrolled-device list, split from the container so it can
 * be rendered (and tested) without a live server.
 */
export function DeviceListView({
  devices,
  confirmingId,
  busy,
  onConfirmRevoke,
  onCancelRevoke,
  onRevoke,
}: {
  devices: CasDevice[];
  confirmingId: string | null;
  busy: boolean;
  onConfirmRevoke: (id: string) => void;
  onCancelRevoke: () => void;
  onRevoke: (id: string) => void;
}) {
  if (devices.length === 0) {
    return <p className="px-5 py-4 text-xs leading-5 text-[#687271]" data-testid="device-list-empty">No phones or consoles have been given access yet.</p>;
  }
  return (
    <div className="divide-y divide-[#e3e4dc]">
      {devices.map((device) => {
        const revoked = device.revokedAt !== null;
        return (
          <div key={device.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start" data-testid={`row-device-${device.id}`}>
            <Smartphone size={16} className={`mt-0.5 shrink-0 ${revoked ? 'text-[#b0b5ad]' : 'text-[#236047]'}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className={`text-sm font-bold ${revoked ? 'text-[#687271] line-through' : 'text-[#203c49]'}`}>{device.label}</p>
                <span className={`text-[10px] font-bold ${revoked ? 'text-[#914136]' : 'text-[#236047]'}`} data-testid={`device-state-${device.id}`}>
                  {revoked ? `Revoked ${formatDeviceTimestamp(device.revokedAt)}` : 'Active'}
                </span>
              </div>
              <p className="mt-1 font-mono-ui text-[10px] text-[#687271]">{device.id}</p>
              <p className="mt-1 text-xs leading-5 text-[#687271]">
                Access granted {formatDeviceTimestamp(device.createdAt)} · Last used {formatDeviceTimestamp(device.lastUsedAt)}
              </p>
              {confirmingId === device.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-[#e7b8af] bg-[#f8e0db] px-3 py-2" data-testid={`confirm-revoke-${device.id}`}>
                  <p className="w-full text-xs font-bold text-[#914136]">
                    Cut off “{device.label}”? That device is blocked from its very next request. This cannot be undone — a lost phone stays locked out even if someone still has it.
                  </p>
                  <button
                    onClick={() => onRevoke(device.id)}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#914136] bg-[#914136] px-3 py-1.5 text-xs font-bold text-[#fbfbf7] hover:opacity-90 disabled:opacity-50"
                    data-testid={`button-confirm-revoke-${device.id}`}
                  >
                    <ShieldOff size={13} /> Yes, cut it off
                  </button>
                  <button
                    onClick={onCancelRevoke}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-1.5 text-xs font-bold text-[#43575a] hover:border-[#203c49] disabled:opacity-50"
                    data-testid={`button-cancel-revoke-${device.id}`}
                  >
                    Keep access
                  </button>
                </div>
              )}
            </div>
            {!revoked && confirmingId !== device.id && (
              <button
                onClick={() => onConfirmRevoke(device.id)}
                disabled={busy}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 text-xs font-bold text-[#914136] hover:border-[#914136] disabled:opacity-50"
                data-testid={`button-revoke-${device.id}`}
              >
                <ShieldOff size={13} /> Cut off access
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Operator panel for listing and revoking enrolled device credentials — the
 * one-click answer to a lost phone. The list/revoke endpoints are gated on
 * the enrollment credential (never this browser's own device token), so the
 * operator is asked for it in an in-app dialog when opening the panel — the
 * same style of dialog as console enrollment, not a native browser popup
 * (which looks identical to a phishing prompt). The credential is held in
 * memory only and discarded when the panel is closed or the credential is
 * rejected. Unlike the enrollment dialog there is deliberately no
 * keep-signed-in option: this panel never persists the credential.
 */
export function DeviceCredentialsPanel() {
  const [{ credential, dialogOpen, entered, rejection }, dispatch] = useReducer(
    reducePanelCredential,
    initialPanelCredentialState,
  );
  const [devices, setDevices] = useState<CasDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Mirror of the in-flight flag readable from the dialog-close callback,
  // whose closure would otherwise capture a stale value.
  const dialogBusyRef = useRef(false);
  const [dialogBusy, setDialogBusy] = useState(false);

  const open = () => {
    dialogBusyRef.current = false;
    setDialogBusy(false);
    dispatch({ type: 'open' });
  };

  const dismissDialog = () => {
    if (dialogBusyRef.current) return;
    dialogBusyRef.current = false;
    setDialogBusy(false);
    dispatch({ type: 'dismiss' });
  };

  const submitCredential = async () => {
    const trimmed = entered.trim();
    if (!trimmed || dialogBusyRef.current) return;
    dialogBusyRef.current = true;
    setDialogBusy(true);
    dispatch({ type: 'submit' });
    try {
      const list = await listCasDevices(trimmed);
      dialogBusyRef.current = false;
      setDialogBusy(false);
      setError(null);
      setDevices(list);
      dispatch({ type: 'accepted', credential: trimmed });
    } catch (err) {
      dialogBusyRef.current = false;
      setDialogBusy(false);
      setDevices(null);
      dispatch({
        type: 'rejected',
        message: err instanceof Error ? err.message : 'The device list could not be loaded.',
      });
    }
  };

  const close = () => {
    dispatch({ type: 'forget' });
    setDevices(null);
    setConfirmingId(null);
    setError(null);
  };

  const refresh = async () => {
    if (!credential) return;
    setBusy(true);
    setError(null);
    try {
      setDevices(await listCasDevices(credential));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The device list could not be reloaded.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    if (!credential) return;
    setBusy(true);
    setError(null);
    try {
      await revokeCasDevice(credential, id);
      setConfirmingId(null);
      // Reload from the server so the list reflects the recorded revocation
      // (including its server-side timestamp), not a local guess.
      setDevices(await listCasDevices(credential));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The revocation was rejected.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        // Any dismiss path (X, Escape, overlay click) forgets the typed
        // credential. Dismissal is ignored while the credential check is in
        // flight so the dialog can't close mid-request.
        if (!next) dismissDialog();
      }}
    >
      <DialogContent
        data-testid="device-credentials-dialog"
        className="sm:max-w-md"
        onEscapeKeyDown={(event) => {
          if (dialogBusyRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (dialogBusyRef.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound size={16} className="shrink-0 text-muted-foreground" />
            Show who has access
          </DialogTitle>
          <DialogDescription>
            Enter the enrollment credential — the alert password chosen when the server was set up
            (its <span className="font-mono-ui text-xs">CAS_ALERT_TOKEN</span> secret). It is kept
            in memory only, never stored, and forgotten when you press Done.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCredential();
          }}
        >
          {rejection && (
            <p
              data-testid="device-credentials-rejection"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {rejection}
            </p>
          )}
          <div className="grid gap-1.5">
            <label htmlFor="device-panel-credential" className="text-sm font-medium">
              Enrollment credential
            </label>
            <input
              id="device-panel-credential"
              data-testid="input-device-panel-credential"
              type="password"
              autoComplete="off"
              autoFocus
              disabled={dialogBusy}
              value={entered}
              onChange={(event) => dispatch({ type: 'type', value: event.target.value })}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <button
              type="button"
              data-testid="button-cancel-device-panel"
              disabled={dialogBusy}
              onClick={dismissDialog}
              className="rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
            >
              Not now
            </button>
            <button
              type="submit"
              data-testid="button-submit-device-panel"
              disabled={dialogBusy || !entered.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Unlock size={14} />
              {dialogBusy ? 'Checking…' : 'Show devices'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <section className="fade-up fade-up-3 mt-5 rounded-xl border border-[#d7d8d0] bg-[#fbfbf7]" data-testid="panel-device-credentials">
      <div className="flex items-center justify-between gap-3 border-b border-[#d7d8d0] px-5 py-4">
        <div>
          <SectionKicker testId="kicker-device-credentials">Who has access</SectionKicker>
          <h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">Lost a phone? Cut off its access here.</h2>
        </div>
        {credential ? (
          <div className="flex items-center gap-2">
            <button onClick={() => void refresh()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 text-xs font-bold text-[#43575a] hover:border-[#203c49] disabled:opacity-50" data-testid="button-refresh-devices">
              <RefreshCw size={13} /> Refresh
            </button>
            <button onClick={close} className="inline-flex items-center gap-1.5 rounded-md border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 text-xs font-bold text-[#43575a] hover:border-[#203c49]" data-testid="button-close-devices">
              <X size={13} /> Done
            </button>
          </div>
        ) : (
          <button onClick={open} disabled={busy} className="inline-flex items-center gap-2 rounded-md border border-[#203c49] bg-[#203c49] px-3 py-2 text-xs font-bold text-[#f2f0e6] hover:opacity-90 disabled:opacity-50" data-testid="button-manage-devices">
            <KeyRound size={13} /> Manage access
          </button>
        )}
      </div>
      {error && (
        <div className="border-b border-[#e7b8af] bg-[#fbfbf7] px-5 py-3">
          <FriendlyErrorMessage error={error} testId="device-credentials-error" onRetry={open} />
        </div>
      )}
      {devices ? (
        <DeviceListView
          devices={devices}
          confirmingId={confirmingId}
          busy={busy}
          onConfirmRevoke={setConfirmingId}
          onCancelRevoke={() => setConfirmingId(null)}
          onRevoke={(id) => void revoke(id)}
        />
      ) : (
        !error && (
          <p className="px-5 py-4 text-xs leading-5 text-[#687271]">
            Every enrolled phone and console browser has its own revocable access credential — so a lost device can be cut off without touching the others. Listing and cutting off require the enrollment credential: a stolen console session alone cannot lock out your other devices.
          </p>
        )
      )}
    </section>
    </>
  );
}
