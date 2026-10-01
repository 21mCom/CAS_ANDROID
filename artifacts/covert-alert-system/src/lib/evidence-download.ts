/**
 * Filename for a console-downloaded evidence clip.
 *
 * The server's download route (api-server cas-evidence.ts) owns the naming
 * scheme — cas-<incident>-<kind>[-<camera>]-<sequence>.<ext> — and sends it
 * in the Content-Disposition header. The console prefers that header so the
 * two can never drift again (a console-side builder once dropped the camera
 * label, so front-camera clips saved without it). The fallback rebuilds the
 * same scheme, camera label included, for the case where the header is
 * missing (e.g. a proxy that strips it).
 */

export interface EvidenceFilenameItem {
  kind: 'audio' | 'photo' | 'video';
  sequence: number;
  camera: 'front' | 'back' | null;
}

const EXTENSIONS: Record<EvidenceFilenameItem['kind'], string> = {
  photo: 'jpg',
  video: 'mp4',
  audio: 'm4a',
};

/**
 * Extract the filename from a Content-Disposition header, or null when the
 * header is absent or carries no usable name. Both quoted and token forms
 * are accepted. Only the basename survives: a header must never smuggle a
 * path into the operator's save dialog.
 */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  // Quoted form wins when present — even an empty one, so filename=""
  // degrades to null instead of leaking the quotes into the token match.
  const quoted = /filename="([^"]*)"/i.exec(header);
  const raw = quoted ? quoted[1] : /filename=([^;\s]+)/i.exec(header)?.[1] ?? null;
  if (!raw) return null;
  const basename = raw.split(/[\\/]/).pop()?.trim() ?? '';
  return basename === '' ? null : basename;
}

/** Mirrors the server route's naming scheme, camera label included. */
export function fallbackEvidenceFilename(incidentId: string | undefined, item: EvidenceFilenameItem): string {
  return `cas-${incidentId ?? 'unknown'}-${item.kind}${item.camera ? `-${item.camera}` : ''}-${item.sequence}.${EXTENSIONS[item.kind]}`;
}

/**
 * The name the console gives a downloaded clip: the server-provided one
 * when present, the locally rebuilt equivalent otherwise.
 */
export function evidenceDownloadFilename(
  contentDisposition: string | null,
  incidentId: string | undefined,
  item: EvidenceFilenameItem,
): string {
  return filenameFromContentDisposition(contentDisposition) ?? fallbackEvidenceFilename(incidentId, item);
}
