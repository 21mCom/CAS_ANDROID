/**
 * One-off audit: sweep existing DELIVERY_REQUEUED incident journal entries for
 * credentials pasted before the re-queue note guard shipped.
 *
 * The guard (routes/cas.ts) only rejects new notes, so any detail stored
 * before it shipped may already contain a pasted API key or password — and the
 * journal is append-only and broadly visible. This script scans every
 * DELIVERY_REQUEUED event with the exact NOTE_SECRET_PATTERNS the guard uses
 * and reports event id + pattern label only; it never prints the detail text,
 * so the audit output itself cannot leak the credential.
 *
 * Usage: pnpm --filter @workspace/api-server run audit:journal-secrets
 * Requires DATABASE_URL. Exits 0 when the journal is clean, 1 when hits are
 * found (so it can gate automation or page a human), 2 on operational errors.
 */
import { pool } from "@workspace/db";
import { findJournalSecretLeaks } from "../src/lib/journal-secret-audit";

const ROTATION_GUIDANCE = [
  "For every event id listed above:",
  "  1. Treat the pasted credential as compromised — it is visible to anyone",
  "     who can read the incident journal, and the journal is append-only.",
  "  2. Rotate/revoke it at the provider NOW (provider console or API); do not",
  "     wait for a cleanup of the journal row.",
  "  3. Verify the old value no longer authenticates before closing this out.",
  "  4. Escalate to the security on-call if the credential was production-scoped",
  "     or if journal access cannot be accounted for.",
  "  5. Journal follow-up notes must describe the fix only (e.g. \"rotated the",
  "     provider API key\") — never paste the new credential.",
].join("\n");

try {
  const { scanned, hits } = await findJournalSecretLeaks();
  console.log(`Scanned ${scanned} DELIVERY_REQUEUED journal event(s).`);
  if (hits.length === 0) {
    console.log("CLEAN: no known secret shapes found in re-queue journal details.");
    process.exitCode = 0;
  } else {
    const eventIds = new Set(hits.map((hit) => hit.eventId));
    console.error(`LEAKS FOUND: ${hits.length} secret-shape hit(s) across ${eventIds.size} event(s):`);
    for (const hit of hits) {
      console.error(
        `  - event ${hit.eventId} (incident ${hit.incidentId}, ${hit.createdAt.toISOString()}): contains ${hit.patternLabel}`,
      );
    }
    console.error("");
    console.error(ROTATION_GUIDANCE);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Audit failed to run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
} finally {
  await pool.end();
}
