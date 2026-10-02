import { AlertTriangle, CheckCircle2, PackageOpen, PackageX } from 'lucide-react';
import { useAppUpdateStatus, type AppUpdateStatus } from '@/hooks/use-app-update';
import { SectionKicker } from '@/components/field-ui';
import { outboxAgeLabel as ageLabel } from '@/lib/outbox-warnings';

function sizeLabel(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  if (sizeBytes >= 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${sizeBytes} B`;
}

/** Short pin for display; the full hash stays one hover away. */
function shortSha(sha256: string): string {
  return `${sha256.slice(0, 12)}…${sha256.slice(-8)}`;
}

/**
 * Which update build the server is currently shipping to handsets. Answers
 * the operator question "what will phones install right now?" without
 * leaving the console. Read-only; publishing stays a curl away.
 */
export function AppUpdatePanel() {
  const state = useAppUpdateStatus();
  return <AppUpdateView state={state} nowMs={Date.now()} />;
}

/**
 * Pure presentational half, split out so every state (published build,
 * nothing published, drifted contract, outage) can be render-tested
 * without the polling hook.
 */
export function AppUpdateView({ state, nowMs }: { state: AppUpdateStatus; nowMs: number }) {
  const { manifest, unpublished, unreachable, mismatch } = state;

  // Not enrolled yet / first poll in flight — say nothing rather than
  // flashing a false empty state.
  if (!manifest && !unpublished && !unreachable && !mismatch) return null;

  return (
    <section className="fade-up fade-up-2 mt-5 rounded-xl border border-[#d7d8d0] bg-[#fbfbf7]" data-testid="app-update-panel">
      <div className="border-b border-[#d7d8d0] px-5 py-4">
        <div className="flex items-center gap-2">
          <PackageOpen size={15} className="text-[#203c49]" />
          <SectionKicker testId="kicker-phone-update-build">Phone updates</SectionKicker>
        </div>
        <h2 className="mt-1 font-display text-lg font-extrabold tracking-[-0.03em]">What phones will install right now</h2>
      </div>
      <div className="px-5 py-4">
        {mismatch ? (
          <div className="flex items-start gap-2 rounded-lg border border-[#e8c880] bg-[#fff8e7] px-3 py-2 text-xs leading-5 text-[#765013]" data-testid="app-update-mismatch">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>The server&apos;s update manifest is in a format this console doesn&apos;t recognize — the published build is hidden until that&apos;s resolved. {mismatch}</span>
          </div>
        ) : (
          <>
            {unreachable && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-[#e8c880] bg-[#fff8e7] px-3 py-2 text-xs leading-5 text-[#765013]" data-testid="app-update-unreachable">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>The console can&apos;t reach the update manifest right now{manifest ? ' — showing the last known build' : ''}.</span>
              </div>
            )}
            {manifest ? (
              <div className="space-y-1.5" data-testid="app-update-published">
                <p className="flex items-center gap-2 text-sm font-bold text-[#203c49]">
                  <CheckCircle2 size={15} className="text-[#236047]" />
                  {manifest.versionName} <span className="font-medium text-[#687271]">(build {manifest.versionCode})</span>
                </p>
                <p className="text-xs leading-5 text-[#687271]">
                  {sizeLabel(manifest.sizeBytes)} · published {ageLabel(manifest.publishedAt, nowMs)} · package {manifest.packageName}
                </p>
                <p className="font-mono-ui text-[11px] text-[#687271]" title={manifest.sha256} data-testid="app-update-sha256">
                  SHA-256 {shortSha(manifest.sha256)}
                </p>
              </div>
            ) : (
              <p className="flex items-start gap-2 text-xs leading-5 text-[#687271]" data-testid="app-update-none">
                <PackageX size={14} className="mt-0.5 shrink-0" />
                <span>No update build is published on this server. Handsets polling for an update get &quot;nothing new&quot; until one is.</span>
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
