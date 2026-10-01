package com.covertalert.pixeltest

/**
 * Filter + bound rules for the field-paste debug-journal export
 * ("Copy recent alert/SMS events" in MainActivity).
 *
 * The raw journal is dominated by cover/proxy/boot noise (PROXY_TRIGGER,
 * COVER_LAUNCH_OUTCOME, BOOT_OBSERVED — over 1,500 events in a single field
 * session), so an unbounded full-journal paste truncates mid-stream and loses
 * exactly the events that explain why an alert send failed. This export keeps
 * only the alert-send and incident-relevant families and bounds the result to
 * the most recent [FILTERED_MAX_EVENTS] matching events, so the whole paste
 * fits comfortably in a chat or report.
 *
 * Android-free on purpose: the keep/drop and bounding decisions are pinned by
 * JVM tests (DebugJournalExportTest); MainActivity only maps the selected
 * journal indices back to JSON.
 */
object DebugJournalExport {

    /** Same envelope marker as the full export, so pasted JSON stays parseable. */
    const val SCHEMA = "cas-debug-journal-v1"
    const val REPORT_TYPE = "debug-journal"

    /**
     * The full export's note, verbatim — the "NOT a Gate 0A report" warning
     * must survive every export variant so a paste can never be fed to the
     * Gate 0A importer by mistake.
     */
    const val FULL_NOTE =
        "Raw on-device journal for field debugging (alert sends, SMS radio results, capture events). NOT a Gate 0A report — do not import it as one."

    /** Upper bound on matching events in the filtered export (most recent win). */
    const val FILTERED_MAX_EVENTS = 300

    const val FILTERED_NOTE =
        "Filtered on-device journal for field pastes: alert-send and incident-relevant events only (SMS_*, MVP_*, LOCATION_*, CAPTURE_*, REQUEUE_*, receipt/trigger diagnostics), most recent $FILTERED_MAX_EVENTS matches. NOT a Gate 0A report — do not import it as one."

    // Event families a field paste must keep: the alert-send chain and its
    // incident context. Prefix match covers every current and future member
    // of the family (e.g. SMS_DIVIDE_FALLBACK, SMS_PART_RESULT).
    private val KEPT_PREFIXES = listOf(
        "SMS_",       // send start/parts/outcome, divide fallback, receipts, batch durability
        "MVP_",       // alert attempt/outcome, SMS outcome summary
        "LOCATION_",  // fix capture + recapture watchdog around a send
        "CAPTURE_",   // responder capture requests/policy (incident evidence)
        "REQUEUE_",   // server-driven requeue checks of a committed incident
        "RECEIPT_",   // delivery-receipt retry chain
        "EVIDENCE_",  // evidence capture/upload for the incident
    )

    // Single events outside those families that still explain a send: a
    // rejected credential refuses the trigger (401), and the push-wake pair
    // explains why a capture request did or did not arrive.
    private val KEPT_EVENTS = setOf(
        "DEVICE_CREDENTIAL_REJECTED",
        "PUSH_TOKEN_REGISTERED",
        "PUSH_UNAVAILABLE",
    )

    /** True when [type] belongs in the filtered field paste. */
    fun isAlertRelevant(type: String): Boolean =
        type in KEPT_EVENTS || KEPT_PREFIXES.any { type.startsWith(it) }

    /**
     * Indices into the journal (in journal order) that the filtered export
     * keeps: events whose type passes [isAlertRelevant], bounded to the most
     * recent [FILTERED_MAX_EVENTS] matches when the journal holds more.
     */
    fun filteredIndices(types: List<String>): List<Int> {
        val matching = types.withIndex()
            .filter { isAlertRelevant(it.value) }
            .map { it.index }
        return if (matching.size <= FILTERED_MAX_EVENTS) matching
        else matching.subList(matching.size - FILTERED_MAX_EVENTS, matching.size)
    }
}
