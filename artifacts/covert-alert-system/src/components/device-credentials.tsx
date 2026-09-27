import { useState } from 'react';
import { KeyRound, RefreshCw, ShieldOff, Smartphone, X } from 'lucide-react';
import { listCasDevices, revokeCasDevice, type CasDevice } from '@/hooks/use-field-test';
import { SectionKicker } from '@/components/field-ui';

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
    return <p className="px-5 py-4 text-xs leading-5 text-[#687271]" data-testid="device-list-empty">No device credentials are enrolled yet.</p>;
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
                <span className={`font-mono-ui text-[9px] uppercase tracking-[0.1em] ${revoked ? 'text-[#914136]' : 'text-[#236047]'}`} data-testid={`device-state-${device.id}`}>
                  {revoked ? `revoked ${formatDeviceTimestamp(device.revokedAt)}` : 'active'}
                </span>
              </div>
              <p className="mt-1 font-mono-ui text-[10px] text-[#687271]">{device.id}</p>
              <p className="mt-1 text-xs leading-5 text-[#687271]">
                Enrolled {formatDeviceTimestamp(device.createdAt)} · Last used {formatDeviceTimestamp(device.lastUsedAt)}
              </p>
              {confirmingId === device.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2 border border-[#e7b8af] bg-[#f8e0db] px-3 py-2" data-testid={`confirm-revoke-${device.id}`}>
                  <p className="w-full text-xs font-bold text-[#914136]">
                    Revoke “{device.label}”? That device is blocked from its very next request. This cannot be undone — a lost phone stays locked out even if it still holds its credential.
                  </p>
                  <button
                    onClick={() => onRevoke(device.id)}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 border border-[#914136] bg-[#914136] px-3 py-1.5 text-xs font-bold text-[#fbfbf7] hover:opacity-90 disabled:opacity-50"
                    data-testid={`button-confirm-revoke-${device.id}`}
                  >
                    <ShieldOff size={13} /> Confirm revoke
                  </button>
                  <button
                    onClick={onCancelRevoke}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-1.5 text-xs font-bold text-[#43575a] hover:border-[#203c49] disabled:opacity-50"
                    data-testid={`button-cancel-revoke-${device.id}`}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
            {!revoked && confirmingId !== device.id && (
              <button
                onClick={() => onConfirmRevoke(device.id)}
                disabled={busy}
                className="inline-flex shrink-0 items-center gap-1.5 border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 text-xs font-bold text-[#914136] hover:border-[#914136] disabled:opacity-50"
                data-testid={`button-revoke-${device.id}`}
              >
                <ShieldOff size={13} /> Revoke
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
      'Enter the CAS enrollment credential (the server\u2019s CAS_ALERT_TOKEN secret) to list and revoke device credentials. It is kept in memory only and never stored.',
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
    <section className="fade-up fade-up-3 mt-5 border border-[#d7d8d0] bg-[#fbfbf7]" data-testid="panel-device-credentials">
      <div className="flex items-center justify-between gap-3 border-b border-[#d7d8d0] px-5 py-4">
        <div>
          <SectionKicker>Device credentials</SectionKicker>
          <h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">Lost phone? Revoke its credential here.</h2>
        </div>
        {credential ? (
          <div className="flex items-center gap-2">
            <button onClick={() => void refresh()} disabled={busy} className="inline-flex items-center gap-1.5 border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 text-xs font-bold text-[#43575a] hover:border-[#203c49] disabled:opacity-50" data-testid="button-refresh-devices">
              <RefreshCw size={13} /> Refresh
            </button>
            <button onClick={close} className="inline-flex items-center gap-1.5 border border-[#c6cbc3] bg-[#fbfbf7] px-3 py-2 text-xs font-bold text-[#43575a] hover:border-[#203c49]" data-testid="button-close-devices">
              <X size={13} /> Done
            </button>
          </div>
        ) : (
          <button onClick={() => void open()} disabled={busy} className="inline-flex items-center gap-2 border border-[#203c49] bg-[#203c49] px-3 py-2 text-xs font-bold text-[#f2f0e6] hover:opacity-90 disabled:opacity-50" data-testid="button-manage-devices">
            <KeyRound size={13} /> Manage devices
          </button>
        )}
      </div>
      {error && (
        <p className="border-b border-[#e7b8af] bg-[#f8e0db] px-5 py-3 text-xs font-bold text-[#914136]" data-testid="device-credentials-error">{error}</p>
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
            Every enrolled phone and console browser holds its own revocable credential. Listing and revoking require the enrollment credential — a stolen console session alone cannot lock out other devices.
          </p>
        )
      )}
    </section>
  );
}
