package com.covertalert.pixeltest

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the post-permission-grant race classifier and retry policy used by
 * UpdateInstallReceiver. The exact refusal string comes from the first
 * physical-Pixel field journal (build 7 → 8, 2026-10-02), where the first
 * handoff failed right after the "Install unknown apps" grant with
 * "Install not allowed for file:…" and an identical retry installed
 * cleanly. Only that refusal text marks the race — the surrounding
 * INSTALL_FAILED_VERIFICATION_FAILURE code is a general verification
 * failure and must NOT be retried on its own, or genuine verifier
 * rejections would re-prompt the owner for an install that cannot pass.
 */
class UpdateInstallRaceTest {

    @Test
    fun observedPostGrantRefusal_isRetryable() {
        assertTrue(
            UpdateCheck.isPostGrantVerificationRace(
                "Install not allowed for file:///data/app/vmdl12345.tmp"
            )
        )
        assertTrue(
            UpdateCheck.isPostGrantVerificationRace(
                "INSTALL_FAILED_VERIFICATION_FAILURE: Install not allowed for file:///data/app/vmdl12345.tmp"
            )
        )
    }

    @Test
    fun otherVerificationFailures_areNotRetryable() {
        // The general verification-failure code WITHOUT the observed
        // refusal text is a genuine verifier rejection — terminal, or a
        // persistently-rejected build would re-prompt the owner forever.
        assertFalse(
            UpdateCheck.isPostGrantVerificationRace(
                "INSTALL_FAILED_VERIFICATION_FAILURE: Package verification failed"
            )
        )
        assertFalse(UpdateCheck.isPostGrantVerificationRace("INSTALL_FAILED_VERIFICATION_FAILURE"))
        assertFalse(UpdateCheck.isPostGrantVerificationRace("INSTALL_FAILED_UPDATE_INCOMPATIBLE"))
        assertFalse(UpdateCheck.isPostGrantVerificationRace("INSTALL_PARSE_FAILED_NOT_APK"))
        assertFalse(UpdateCheck.isPostGrantVerificationRace("INSTALL_FAILED_OLDER_SDK"))
        assertFalse(UpdateCheck.isPostGrantVerificationRace(""))
    }

    @Test
    fun retryStopsAfterMaxAttempts() {
        // Attempts left: retry. Exhausted: even the exact race refusal is
        // terminal — a persistently-refused install must give up, not loop.
        assertTrue(UpdateCheck.shouldRetryInstall("Install not allowed for file:///data/app/vmdl1.tmp", 1))
        assertTrue(UpdateCheck.shouldRetryInstall("Install not allowed for file:///data/app/vmdl1.tmp", UpdateCheck.INSTALL_MAX_ATTEMPTS - 1))
        assertFalse(UpdateCheck.shouldRetryInstall("Install not allowed for file:///data/app/vmdl1.tmp", UpdateCheck.INSTALL_MAX_ATTEMPTS))
        assertFalse(UpdateCheck.shouldRetryInstall("INSTALL_FAILED_UPDATE_INCOMPATIBLE", 1))
    }

    @Test
    fun handoffAcceptance_onlyCountsACommittedSession() {
        // Only the committed-session detail line means a callback will
        // follow; BLOCKED and exception lines commit nothing, so the
        // receiver must record the terminal FAILED itself.
        assertTrue(UpdateCheck.isHandoffAccepted(UpdateCheck.INSTALL_HANDOFF_ACCEPTED))
        assertFalse(UpdateCheck.isHandoffAccepted("BLOCKED: Android has not allowed this app to install updates"))
        assertFalse(UpdateCheck.isHandoffAccepted("install handoff failed: SecurityException"))
        assertFalse(UpdateCheck.isHandoffAccepted(""))
    }

    @Test
    fun retryPolicy_isBoundedAndBrief() {
        assertTrue(UpdateCheck.INSTALL_MAX_ATTEMPTS in 2..5)
        // The grant-propagation window is seconds at most; the delay must
        // stay short enough that the owner never notices.
        assertTrue(UpdateCheck.INSTALL_RETRY_DELAY_MS in 500L..5_000L)
    }
}
