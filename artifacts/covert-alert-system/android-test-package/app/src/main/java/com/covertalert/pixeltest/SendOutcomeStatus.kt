package com.covertalert.pixeltest

/**
 * Builds the inline one-glance outcome line shown under the "Send MVP alert
 * now" button. Pure (no Android imports) so the wording and — critically —
 * the success/failure decision are unit-testable on the JVM; MainActivity
 * only colors and displays what this returns.
 *
 * The success decision must never be "the server accepted the trigger": a
 * committed incident with no SMS leaving the SIM is a NOT_SENT the sender
 * must see. The dispatch test is string-based because DeviceSmsSender
 * journals the same human-readable outcome string; the producer builds that
 * string via [smsDispatchSummary] from the dispatch loop's ACTUAL counts —
 * never from the responder list's size — so a send in which every division
 * failed or every sendMultipartTextMessage threw immediately cannot read
 * as SENT (the unit tests pin both sides).
 */
object SendOutcomeStatus {

    /**
     * Prefix of the ONLY DeviceSmsSender.sendAlert outcome in which message
     * parts were handed to the radio. Every other return ("no responder
     * numbers configured", "SmsManager unavailable", "send aborted: …",
     * "SEND_SMS permission not granted", "not sent: …") means nothing left
     * the phone. DeviceSmsSender builds its success string from this exact
     * prefix; change it in both places or the tests fail.
     */
    const val SMS_DISPATCHED_PREFIX = "sent to "

    /** True when sendAlert actually dispatched message parts to the radio. */
    fun smsDispatched(smsOutcome: String): Boolean = smsOutcome.startsWith(SMS_DISPATCHED_PREFIX)

    /**
     * Builds sendAlert's outcome string from what the dispatch loop actually
     * did. Only a positive [dispatchedTo] earns the [SMS_DISPATCHED_PREFIX]
     * success string: when nothing was handed to the radio (every
     * divideMessage failed, or every sendMultipartTextMessage threw
     * immediately) the string must not carry the prefix, or the button would
     * show a green SENT for an alert that never left the phone. A partial
     * dispatch still names the shortfall so the sender knows to reconcile
     * with the console's per-recipient receipt.
     */
    fun smsDispatchSummary(dispatchedTo: Int, attempted: Int, preDispatchFailures: List<String>): String {
        if (dispatchedTo <= 0) {
            val detail = preDispatchFailures.joinToString("; ")
            return "not sent: no alert SMS could be handed to the radio" +
                if (detail.isNotEmpty()) " — $detail" else ""
        }
        val failedBeforeDispatch = attempted - dispatchedTo
        return if (failedBeforeDispatch > 0) {
            "${SMS_DISPATCHED_PREFIX}$dispatchedTo of $attempted responder(s); awaiting radio results ($failedBeforeDispatch failed before dispatch)"
        } else {
            "${SMS_DISPATCHED_PREFIX}$dispatchedTo responder(s); awaiting radio results"
        }
    }

    data class Line(val text: String, val success: Boolean)

    /**
     * Online path: the trigger POST succeeded and the server committed an
     * incident. The line is SENT only when the handset SMS also dispatched;
     * otherwise it is a red NOT_SENT that still names the created incident
     * so the sender can reconcile with the console.
     */
    fun triggered(incidentId: String?, smsOutcome: String): Line {
        val id = incidentId ?: "unknown"
        return if (smsDispatched(smsOutcome)) {
            Line("SENT — incident $id\nHandset SMS: $smsOutcome", success = true)
        } else {
            Line(
                "NOT_SENT: incident $id was created on the server, but no alert SMS left this phone — $smsOutcome",
                success = false,
            )
        }
    }

    /**
     * Offline path: no reachable console, so no incident exists and the
     * handset SMS is the whole alert. The header stays NOT_SENT to server
     * (true regardless of the SMS result); the success flag follows the SMS
     * dispatch alone.
     */
    fun offlineDirect(reason: String, smsOutcome: String): Line =
        Line("NOT_SENT to server: $reason\nHandset SMS: $smsOutcome", success = smsDispatched(smsOutcome))
}
