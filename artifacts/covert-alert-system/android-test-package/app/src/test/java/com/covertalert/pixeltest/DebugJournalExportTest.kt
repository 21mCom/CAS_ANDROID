package com.covertalert.pixeltest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the filtered field-paste export ("Copy recent alert/SMS events"): the
 * keep/drop decision per event family, the recency bound, and that the
 * cas-debug-journal-v1 envelope with its "NOT a Gate 0A report" warning
 * survives filtering. The first Human-Sheet-1 failure report arrived without
 * any SMS events because the unbounded full-journal paste truncated — these
 * tests exist so the filtered export cannot silently drift back to that.
 */
class DebugJournalExportTest {

    // ---- families the filtered export KEEPS ----

    @Test
    fun `keeps the SMS send and divide-fallback chain`() {
        listOf(
            "SMS_SEND_START", "SMS_PART_RESULT", "SMS_SEND_OUTCOME",
            "SMS_DIVIDE_FALLBACK", "SMS_SEND_ABORTED", "SMS_RECEIPT_OUTCOME",
            "SMS_BATCH_RECOVERY", "SMS_BATCH_REHYDRATED", "SMS_BATCH_PERSIST_FAILED",
        ).forEach { assertTrue("$it must be kept", DebugJournalExport.isAlertRelevant(it)) }
    }

    @Test
    fun `keeps the MVP alert chain and incident families`() {
        listOf(
            "MVP_ALERT_ATTEMPT", "MVP_ALERT_OUTCOME", "MVP_SMS_OUTCOME",
            "LOCATION_CAPTURE", "LOCATION_RECAPTURE_STARTED",
            "CAPTURE_REQUEST_RECEIVED", "CAPTURE_PUSH_RECEIVED", "CAPTURE_REQUEST_ACK",
            "REQUEUE_CHECK", "REQUEUE_CHECK_OUTCOME",
            "RECEIPT_RETRY", "RECEIPT_RETRY_OUTCOME",
            "EVIDENCE_CAPTURE", "EVIDENCE_UPLOAD",
        ).forEach { assertTrue("$it must be kept", DebugJournalExport.isAlertRelevant(it)) }
    }

    @Test
    fun `keeps the single events that explain a refused or unwoken send`() {
        listOf("DEVICE_CREDENTIAL_REJECTED", "PUSH_TOKEN_REGISTERED", "PUSH_UNAVAILABLE")
            .forEach { assertTrue("$it must be kept", DebugJournalExport.isAlertRelevant(it)) }
    }

    // ---- families the filtered export DROPS (proxy/boot/UI noise) ----

    @Test
    fun `drops the proxy cover and boot noise that dominated field journals`() {
        // These three alone produced 1,564 events in the 2026-10-01 field session.
        listOf("PROXY_TRIGGER", "COVER_LAUNCH_OUTCOME", "BOOT_OBSERVED")
            .forEach { assertFalse("$it must be dropped", DebugJournalExport.isAlertRelevant(it)) }
    }

    @Test
    fun `drops UI housekeeping and configuration noise`() {
        listOf(
            "BACK_OBSERVED", "OBSERVER_SCREEN_OPENED", "SHORTCUT_OUTCOME",
            "COVER_CONFIGURED", "COVER_PICKER_EMPTY", "REPORT_COPIED",
            "DEBUG_JOURNAL_COPIED", "ALERT_SERVER_CONFIGURED",
            "DEVICE_CREDENTIAL_ENROLLED",
            "UPDATE_CHECK", "UPDATE_DOWNLOAD", "UPDATE_INSTALL",
            "CAMERA_PERMISSION", "MIC_PERMISSION",
        ).forEach { assertFalse("$it must be dropped", DebugJournalExport.isAlertRelevant(it)) }
    }

    @Test
    fun `kept prefixes also cover their family configuration and permission events`() {
        // Prefix matching keeps the whole family: SMS_RESPONDERS_CONFIGURED
        // says which numbers a send went to, LOCATION_PERMISSION explains a
        // missing fix. Small volume, high diagnostic value — kept by design.
        assertTrue(DebugJournalExport.isAlertRelevant("SMS_RESPONDERS_CONFIGURED"))
        assertTrue(DebugJournalExport.isAlertRelevant("LOCATION_PERMISSION"))
    }

    // ---- bound ----

    @Test
    fun `bounds the export to the most recent matches`() {
        // Interleave noise so filtering and bounding are both exercised:
        // 400 kept-candidate SMS events spread through 800 total events.
        val types = (0 until 800).map {
            if (it % 2 == 0) "PROXY_TRIGGER" else "SMS_PART_RESULT"
        }
        val kept = DebugJournalExport.filteredIndices(types)
        assertEquals(DebugJournalExport.FILTERED_MAX_EVENTS, kept.size)
        // Most recent win: the last kept index must be the journal's last
        // matching event, and every kept index must be a matching type.
        assertEquals(799, kept.last())
        kept.forEach { assertEquals("SMS_PART_RESULT", types[it]) }
        // Journal order is preserved.
        assertEquals(kept.sorted(), kept)
    }

    @Test
    fun `under the bound everything matching is kept`() {
        val types = listOf("PROXY_TRIGGER", "SMS_SEND_START", "BOOT_OBSERVED", "MVP_ALERT_OUTCOME")
        assertEquals(listOf(1, 3), DebugJournalExport.filteredIndices(types))
    }

    // ---- envelope survives filtering ----

    @Test
    fun `filtered export keeps the debug-journal schema envelope`() {
        assertEquals("cas-debug-journal-v1", DebugJournalExport.SCHEMA)
        assertEquals("debug-journal", DebugJournalExport.REPORT_TYPE)
        // Both variants must carry the importer warning verbatim.
        assertTrue(DebugJournalExport.FILTERED_NOTE.contains("NOT a Gate 0A report"))
        assertTrue(DebugJournalExport.FULL_NOTE.contains("NOT a Gate 0A report"))
    }
}
