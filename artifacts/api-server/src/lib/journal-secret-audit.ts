import { asc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { casIncidentEvents } from "@workspace/db/schema";
import { scanDetailsForSecrets, type JournalSecretHit } from "./note-secrets";

/**
 * One-off audit for journal entries written before the re-queue note guard
 * shipped: the guard only rejects new notes, so any DELIVERY_REQUEUED detail
 * stored earlier may already contain a pasted credential. Scans every
 * DELIVERY_REQUEUED event with the same NOTE_SECRET_PATTERNS the guard uses
 * and reports event id + pattern label only, never the detail text.
 */
export async function findJournalSecretLeaks(): Promise<{
  scanned: number;
  hits: JournalSecretHit[];
}> {
  const rows = await db
    .select({
      id: casIncidentEvents.id,
      incidentId: casIncidentEvents.incidentId,
      createdAt: casIncidentEvents.createdAt,
      detail: casIncidentEvents.detail,
    })
    .from(casIncidentEvents)
    .where(eq(casIncidentEvents.type, "DELIVERY_REQUEUED"))
    .orderBy(asc(casIncidentEvents.createdAt));
  return { scanned: rows.length, hits: scanDetailsForSecrets(rows) };
}
