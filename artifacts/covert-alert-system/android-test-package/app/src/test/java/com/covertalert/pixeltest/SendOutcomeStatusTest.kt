package com.covertalert.pixeltest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the inline Send-button outcome decision: a committed incident must
 * never read as a green SENT unless message parts were actually handed to
 * the radio. These are the exact strings DeviceSmsSender.sendAlert returns;
 * the producer builds them via SendOutcomeStatus.smsDispatchSummary from the
 * dispatch loop's actual counts, so a drift between producer and classifier
 * fails here.
 */
class SendOutcomeStatusTest {

    // Regression: server trigger committed an incident, the console circle
    // was never seeded (no deviceSms directive), and the handset has no local
    // numbers — DeviceSmsSender falls back to the empty local list and sends
    // nothing. Must NOT read as SENT.
    @Test
    fun unseededCircleWithNoLocalNumbers_isNotSent() {
        val line = SendOutcomeStatus.triggered("inc-123", "no responder numbers configured")
        assertFalse(line.success)
        assertTrue(line.text.startsWith("NOT_SENT"))
        // The created incident stays distinguishable from the delivery failure.
        assertTrue(line.text.contains("inc-123"))
        assertTrue(line.text.contains("no responder numbers configured"))
    }

    // Regression: the durable batch record could not be persisted, so
    // sendAlert aborted before anything was dispatched. Must NOT read as SENT.
    @Test
    fun dispatchAbort_isNotSent() {
        val line = SendOutcomeStatus.triggered(
            "inc-9",
            "send aborted: could not durably persist the delivery batch (see SMS_SEND_ABORTED)",
        )
        assertFalse(line.success)
        assertTrue(line.text.startsWith("NOT_SENT"))
        assertTrue(line.text.contains("inc-9"))
    }

    @Test
    fun dispatchedParts_isSent() {
        val line = SendOutcomeStatus.triggered("inc-1", "sent to 2 responder(s); awaiting radio results")
        assertTrue(line.success)
        assertTrue(line.text.startsWith("SENT"))
        assertTrue(line.text.contains("inc-1"))
    }

    // Regression: every divideMessage failed or every sendMultipartTextMessage
    // threw immediately — zero parts reached the radio. The summary must not
    // carry the dispatched prefix, so the button must NOT read as SENT.
    @Test
    fun allImmediateFailures_isNotSent() {
        val summary = SendOutcomeStatus.smsDispatchSummary(
            dispatchedTo = 0,
            attempted = 2,
            preDispatchFailures = listOf("PERMISSION_DENIED (***)", "ILLEGAL_DESTINATION_ADDRESS (***)"),
        )
        assertFalse(SendOutcomeStatus.smsDispatched(summary))
        assertTrue(summary.startsWith("not sent"))
        assertTrue(summary.contains("PERMISSION_DENIED"))
        val line = SendOutcomeStatus.triggered("inc-7", summary)
        assertFalse(line.success)
        assertTrue(line.text.startsWith("NOT_SENT"))
        assertTrue(line.text.contains("inc-7"))
    }

    // Partial dispatch: some recipients got the SMS, some failed before
    // dispatch. Still a real dispatch (SENT), and the shortfall is named so
    // the sender reconciles with the console's per-recipient receipt.
    @Test
    fun partialDispatch_isSentWithShortfallNamed() {
        val summary = SendOutcomeStatus.smsDispatchSummary(
            dispatchedTo = 1,
            attempted = 2,
            preDispatchFailures = listOf("ILLEGAL_DESTINATION_ADDRESS (***)"),
        )
        assertTrue(SendOutcomeStatus.smsDispatched(summary))
        assertTrue(summary.contains("1 of 2"))
        assertTrue(summary.contains("1 failed before dispatch"))
        assertTrue(SendOutcomeStatus.triggered("inc-8", summary).success)
    }

    // Full dispatch keeps the exact legacy string other surfaces match on.
    @Test
    fun fullDispatch_matchesLegacyString() {
        assertEquals(
            "sent to 2 responder(s); awaiting radio results",
            SendOutcomeStatus.smsDispatchSummary(2, 2, emptyList()),
        )
    }

    @Test
    fun smsManagerUnavailable_isNotSent() {
        assertFalse(SendOutcomeStatus.triggered("inc-2", "SmsManager unavailable").success)
    }

    @Test
    fun permissionMissing_isNotSent() {
        assertFalse(SendOutcomeStatus.triggered("inc-3", "SEND_SMS permission not granted").success)
    }

    @Test
    fun emptyManagedCircle_isNotSent() {
        assertFalse(
            SendOutcomeStatus.triggered("inc-4", "not sent: the console responder circle has no enabled SMS numbers").success,
        )
    }

    @Test
    fun unknownIncidentId_isNamedUnknown() {
        val line = SendOutcomeStatus.triggered(null, "sent to 1 responder(s); awaiting radio results")
        assertTrue(line.success)
        assertTrue(line.text.contains("incident unknown"))
    }

    // Repeat-tap path: the reused-incident line must never claim SENT — this
    // tap dispatched nothing and the original batch's delivery state is only
    // knowable from the console.
    @Test
    fun reusedIncident_neverClaimsSent() {
        val line = SendOutcomeStatus.reused("inc-7")
        assertFalse(line.startsWith("SENT"))
        assertTrue(line.startsWith("ALREADY ACTIVE"))
        assertTrue(line.contains("inc-7"))
        assertTrue(line.contains("no repeat SMS sent"))
        assertFalse(SendOutcomeStatus.reused(null).contains("inc-7"))
    }

    // Offline path: header always reports NOT_SENT to server; the success
    // flag follows the handset SMS dispatch alone.
    @Test
    fun offlineDirect_dispatchedSmsIsSuccess() {
        val line = SendOutcomeStatus.offlineDirect(
            "no server URL configured; texting responders directly without an incident",
            "sent to 1 responder(s); awaiting radio results",
        )
        assertTrue(line.success)
        assertTrue(line.text.startsWith("NOT_SENT to server"))
    }

    @Test
    fun offlineDirect_noRespondersIsFailure() {
        val line = SendOutcomeStatus.offlineDirect(
            "no server URL configured; texting responders directly without an incident",
            "no responder numbers configured",
        )
        assertFalse(line.success)
    }

    // Producer/classifier lockstep: the success prefix classifies only the
    // exact dispatch string shape, and near-misses stay failures.
    @Test
    fun dispatchPrefixPinsProducerString() {
        assertEquals("sent to ", SendOutcomeStatus.SMS_DISPATCHED_PREFIX)
        assertTrue(SendOutcomeStatus.smsDispatched("sent to 3 responder(s); awaiting radio results"))
        assertFalse(SendOutcomeStatus.smsDispatched("send aborted: could not durably persist the delivery batch (see SMS_SEND_ABORTED)"))
        assertFalse(SendOutcomeStatus.smsDispatched(""))
    }

    // Radio-finalized path: every part of every responder reported RESULT_OK.
    // The line replaces "awaiting radio results" with the delivered answer.
    @Test
    fun batchOutcome_allPartsOk_isDelivered() {
        val line = SendOutcomeStatus.batchOutcome("inc-5", delivered = 2, total = 2, failures = emptyList())
        assertTrue(line.success)
        assertTrue(line.text.startsWith("DELIVERED"))
        assertTrue(line.text.contains("all 2 responder(s)"))
        assertTrue(line.text.contains("inc-5"))
    }

    // Radio-finalized path with a failure: red, names the radio error and the
    // masked recipient, and reports the partial delivery count honestly.
    @Test
    fun batchOutcome_anyFailure_isFailedWithErrorNamed() {
        val line = SendOutcomeStatus.batchOutcome(
            "inc-6",
            delivered = 1,
            total = 2,
            failures = listOf("NO_SERVICE (***)"),
        )
        assertFalse(line.success)
        assertTrue(line.text.startsWith("SMS_FAILED"))
        assertTrue(line.text.contains("1 of 2"))
        assertTrue(line.text.contains("NO_SERVICE (***)"))
        assertTrue(line.text.contains("inc-6"))
    }

    // Watchdog-closed silent radios surface as NO_RADIO_RESULT failures,
    // never as a false DELIVERED.
    @Test
    fun batchOutcome_silentRadio_isNotDelivered() {
        val line = SendOutcomeStatus.batchOutcome(null, delivered = 0, total = 1, failures = listOf("NO_RADIO_RESULT (***)"))
        assertFalse(line.success)
        assertTrue(line.text.contains("offline alert"))
        assertTrue(line.text.contains("NO_RADIO_RESULT"))
    }
}
