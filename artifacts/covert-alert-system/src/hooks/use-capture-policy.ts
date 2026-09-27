import { useCallback, useEffect, useState } from 'react';
import { casAuthedFetch } from '@/hooks/use-field-test';

export type CaptureSetting = 'off' | 'trigger' | 'responder';
export type CaptureTiming = 'immediate' | 'screen-off';

export type CapturePolicy = {
  audio: CaptureSetting;
  photo: CaptureSetting;
  video: CaptureSetting;
  timing: CaptureTiming;
  updatedAt: string | null;
};

const DEFAULT_POLICY: CapturePolicy = {
  audio: 'off',
  photo: 'off',
  video: 'off',
  timing: 'immediate',
  updatedAt: null,
};

/**
 * The evidence-capture policy the handset honors on every trigger and server
 * contact. Reads are credential-gated like every other console read (the
 * policy reveals the system's capture posture), so they go through
 * casAuthedFetch like the writes. The device fetches this policy with its
 * own enrolled credential on its next contact, so a change here takes effect
 * with no app reinstall.
 */
export function useCapturePolicy() {
  const [policy, setPolicy] = useState<CapturePolicy>(DEFAULT_POLICY);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await casAuthedFetch('/api/cas/evidence-policy');
      if (!response.ok) throw new Error(`Unable to load the capture policy (${response.status}).`);
      setPolicy(await response.json() as CapturePolicy);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load the capture policy.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (next: CapturePolicy) => {
    setSaving(true);
    setError(null);
    try {
      const response = await casAuthedFetch('/api/cas/evidence-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio: next.audio,
          photo: next.photo,
          video: next.video,
          timing: next.timing,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `The capture policy was rejected (${response.status}).`);
      }
      setPolicy(await response.json() as CapturePolicy);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The capture policy could not be saved.';
      setError(message);
      throw cause;
    } finally {
      setSaving(false);
    }
  }, []);

  return { policy, loaded, saving, error, save, reload: load };
}

/** Human size for the evidence panel: 12.4 KB, 3.1 MB. */
export function formatEvidenceSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
