import { useEffect, useState } from 'react';
import { CasStateShapeError } from '@/lib/cas-state-schema';
import { parseCasAppUpdateManifest } from '@/lib/cas-app-update-schema';
import { casStoredDeviceToken } from './use-field-test';

export type AppUpdateManifest = {
  packageName: string;
  versionCode: number;
  versionName: string;
  sha256: string;
  sizeBytes: number;
  publishedAt: string;
  downloadPath: string;
};

export type AppUpdateStatus = {
  /** The published build, or null when nothing is published / not loaded. */
  manifest: AppUpdateManifest | null;
  /** True when the server answered 404: no build has ever been published. */
  unpublished: boolean;
  unreachable: boolean;
  mismatch: string | null;
};

/**
 * One poll of the update manifest endpoint, validated against the console's
 * mirror of the server contract before any of it is applied: a drifted
 * server throws CasStateShapeError instead of letting the console show a
 * wrong build pin. A 404 is not an error — it is the server's explicit
 * "nothing published" answer.
 */
export async function requestAppUpdateManifest(
  fetchImpl: typeof fetch,
  token: string,
): Promise<AppUpdateManifest | null> {
  const response = await fetchImpl('/api/cas/app-updates/manifest', {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Unable to load the published update build');
  // A 200 whose body is not even JSON is drift, not an outage.
  const body: unknown = await response.json().catch(() => {
    throw new CasStateShapeError("The server's update manifest response is not valid JSON. The server may be running a different version than this console; refresh once, and if it persists redeploy the matching server build.");
  });
  return parseCasAppUpdateManifest(body);
}

/**
 * Routes a failed poll: a drifted response is a version mismatch (the
 * server answered, but in a shape this console was not built against);
 * anything else means the console lost sight of the manifest entirely.
 */
export function appUpdatePollFailure(error: unknown): { unreachable: boolean; mismatch: string | null } {
  if (error instanceof CasStateShapeError) return { unreachable: false, mismatch: error.message };
  return { unreachable: true, mismatch: null };
}

/**
 * Polls the published handset update build so the console can answer "what
 * will phones install right now?". The manifest only changes when an
 * operator publishes a build, so a slow poll is enough. Like every other
 * console read it is credential-gated: until this browser has enrolled, the
 * tick is skipped quietly and the next poll picks the credential up from
 * this browser's credential storage.
 */
export function useAppUpdateStatus(pollMs = 60_000): AppUpdateStatus {
  const [state, setState] = useState<AppUpdateStatus>({
    manifest: null,
    unpublished: false,
    unreachable: false,
    mismatch: null,
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const token = casStoredDeviceToken();
        if (!token) return;
        const manifest = await requestAppUpdateManifest(fetch, token);
        if (!cancelled) {
          setState({ manifest, unpublished: manifest === null, unreachable: false, mismatch: null });
        }
      } catch (error) {
        if (cancelled) return;
        const failure = appUpdatePollFailure(error);
        // Never render a build pin from a drifted contract — drop the last
        // snapshot so only the mismatch warning is shown. For a plain
        // outage, keep the last good snapshot but flag that the console lost
        // sight of the published build.
        setState((prev) => ({
          manifest: failure.mismatch ? null : prev.manifest,
          unpublished: failure.mismatch ? false : prev.unpublished,
          unreachable: failure.unreachable,
          mismatch: failure.mismatch,
        }));
      }
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  return state;
}
