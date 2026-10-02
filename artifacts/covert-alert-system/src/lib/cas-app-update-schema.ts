import { z } from 'zod';
import { casResponseShapeError } from '@/lib/cas-state-schema';
import type { AppUpdateManifest } from '@/hooks/use-app-update';

/**
 * Console-side mirror of the API's GET /api/cas/app-updates/manifest
 * response contract (artifacts/api-server/src/routes/cas-updates.ts —
 * manifestFor): the newest published handset build, with the SHA-256 and
 * size the server computed from the stored APK bytes at publish time.
 * The console renders this so an operator can answer "what will phones
 * install right now?" without curl; a drifted server (stale deployment,
 * mixed environments) must surface as a mismatch, not as a wrong pin.
 *
 * The compile-time assertions at the bottom pin the inferred payload type
 * to the hook's AppUpdateManifest declaration in both directions, so
 * editing one side without the other is a typecheck failure.
 */
export const casAppUpdateManifestSchema = z.object({
  packageName: z.string(),
  versionCode: z.number().int(),
  versionName: z.string(),
  // The server computes this from the APK bytes (createHash hex digest).
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int(),
  publishedAt: z.string(),
  downloadPath: z.string(),
}).strict();

export type CasAppUpdateManifestRemote = z.infer<typeof casAppUpdateManifestSchema>;

/**
 * Parses a GET /api/cas/app-updates/manifest JSON body. Throws
 * CasStateShapeError — with the first offending path — when the server
 * speaks a shape this console was not built against, so the polling hook
 * can flag the mismatch instead of rendering a wrong update pin.
 */
export function parseCasAppUpdateManifest(body: unknown): CasAppUpdateManifestRemote {
  const result = casAppUpdateManifestSchema.safeParse(body);
  if (!result.success) throw casResponseShapeError('app update manifest', result.error);
  return result.data;
}

// Compile-time lockstep with the hook's AppUpdateManifest type: assigning
// in both directions fails typecheck the moment the mirror schema and the
// hook's declaration disagree.
const _schemaMatchesHook: AppUpdateManifest = null as unknown as CasAppUpdateManifestRemote;
const _hookMatchesSchema: CasAppUpdateManifestRemote = null as unknown as AppUpdateManifest;
void _schemaMatchesHook;
void _hookMatchesSchema;
