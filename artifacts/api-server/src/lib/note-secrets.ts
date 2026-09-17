/**
 * Obvious secret shapes that must never reach the incident journal. The
 * journal is append-only and broadly visible, so a responder note that pastes
 * an actual credential would leak it permanently; these notes are rejected
 * outright. Describing the fix ("rotated the SMS provider credentials") is
 * always fine — only the secret shapes themselves match.
 *
 * This module is the single source of truth for the shapes: the re-queue
 * guard (routes/cas.ts) rejects new notes that match, and the one-off journal
 * audit (scripts/audit-journal-secrets.ts) scans pre-guard entries with the
 * same patterns. Keep the two uses on this shared list so the audit can never
 * drift from the guard.
 */
export const NOTE_SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:sk|pk)_(?:live|test)_[0-9A-Za-z]{8,}\b/, label: "a provider API key" },
  { pattern: /\bsk-[0-9A-Za-z_-]{16,}\b/, label: "a provider API key" },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/, label: "a Google API key" },
  { pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, label: "a Slack token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "an AWS access key" },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{16,}\b|\bgithub_pat_[0-9A-Za-z_]{20,}\b/, label: "a GitHub token" },
  { pattern: /\bBearer\s+[0-9A-Za-z._~+/=-]{8,}\b/i, label: "a bearer token" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "a private key block" },
  { pattern: /\b(?:password|passwd|pwd|secret|api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret)\s*[:=]\s*["']?\S{4,}/i, label: "a password or key in key=value form" },
];

export function detectSecretInNote(note: string): string | null {
  for (const { pattern, label } of NOTE_SECRET_PATTERNS) {
    if (pattern.test(note)) return label;
  }
  return null;
}

/**
 * A journal entry whose detail matches a known secret shape. Deliberately
 * carries only the event id, incident id, timestamp, and pattern label — never
 * the detail text — so audit output cannot itself leak the credential.
 */
export interface JournalSecretHit {
  eventId: string;
  incidentId: string;
  createdAt: Date;
  patternLabel: string;
}

/**
 * Scans journal entries for known secret shapes, returning one hit per
 * matching pattern per entry (an entry that pasted two kinds of credential
 * produces two hits). Safe to log or serialize: hits never include the entry
 * detail.
 */
export function scanDetailsForSecrets(
  entries: Array<{ id: string; incidentId: string; createdAt: Date; detail: string }>,
): JournalSecretHit[] {
  const hits: JournalSecretHit[] = [];
  for (const entry of entries) {
    for (const { pattern, label } of NOTE_SECRET_PATTERNS) {
      if (pattern.test(entry.detail)) {
        hits.push({
          eventId: entry.id,
          incidentId: entry.incidentId,
          createdAt: entry.createdAt,
          patternLabel: label,
        });
      }
    }
  }
  return hits;
}
