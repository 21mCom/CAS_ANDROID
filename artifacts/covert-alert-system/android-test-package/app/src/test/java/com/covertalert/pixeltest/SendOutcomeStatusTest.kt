package com.covertalert.pixeltest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the inline Send-button outcome decision: a committed incident must
 * never read as a green SENT unless message parts were actually handed to
 * the radio. These are the exact strings DeviceSmsSender.sendAlert returns;
 * the producer builds its success string from SMS_DISPATCHED_PREFIX, so a
 * drift between producer and classifier fails here.
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
}
