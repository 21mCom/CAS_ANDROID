import { useState } from 'react';
import { KeyRound, RefreshCw, ShieldOff, Smartphone, X } from 'lucide-react';
import { listCasDevices, revokeCasDevice, type CasDevice } from '@/hooks/use-field-test';
import { FriendlyErrorMessage, SectionKicker } from '@/components/field-ui';

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
 * operator is asked for it when opening the panel; it is held in memory only
 * and discarded when the panel is closed or the credential is rejected.
 */
export function DeviceCredentialsPanel() {
  const [credential, setCredential] = useState<string | null>(null);
  const [devices, setDevices] = useState<CasDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const open = async () => {
    const entered = window.prompt(
      'Enter the enrollment credential — the alert password chosen when the server was set up (its CAS_ALERT_TOKEN secret). It is kept in memory only, never stored, and forgotten when you press Done.',
    )?.trim() ?? '';
    if (!entered) return;
    setBusy(true);
    setError(null);
    try {
      setDevices(await listCasDevices(entered));
      setCredential(entered);
    } catch (err) {
      // Rejected credential: keep nothing, so a mistyped or stale value is
      // never retained.
      setCredential(null);
      setDevices(null);
      setError(err instanceof Error ? err.message : 'The device list could not be loaded.');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setCredential(null);
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
          <button onClick={() => void open()} disabled={busy} className="inline-flex items-center gap-2 rounded-md border border-[#203c49] bg-[#203c49] px-3 py-2 text-xs font-bold text-[#f2f0e6] hover:opacity-90 disabled:opacity-50" data-testid="button-manage-devices">
            <KeyRound size={13} /> Manage access
          </button>
        )}
      </div>
      {error && (
        <div className="border-b border-[#e7b8af] bg-[#fbfbf7] px-5 py-3">
          <FriendlyErrorMessage error={error} testId="device-credentials-error" onRetry={() => void open()} />
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
  );
}
