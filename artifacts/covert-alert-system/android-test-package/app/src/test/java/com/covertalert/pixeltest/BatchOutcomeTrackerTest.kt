package com.covertalert.pixeltest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test

/**
 * Pins the ordering and attribution decisions of the Send button's inline
 * status line: the final radio outcome must win over the dispatch summary
 * however the callbacks interleave, and a finalized batch may only update
 * the line while its own attempt owns it. These mirror the exact call
 * sequence MainActivity and DeviceSmsSender make.
 */
class BatchOutcomeTrackerTest {

    private lateinit var tracker: BatchOutcomeTracker
    private val delivered = SendOutcomeStatus.batchOutcome("inc-1", delivered = 2, total = 2, failures = emptyList())
    private val failed = SendOutcomeStatus.batchOutcome("inc-1", delivered = 1, total = 2, failures = listOf("NO_SERVICE (***)"))

    @Before
    fun setUp() {
        tracker = BatchOutcomeTracker()
    }

    // Immediate finalization: fast radio callbacks (or all-immediate dispatch
    // failures) finalize the batch INSIDE sendAlert — before MainActivity can
    // attribute the attempt or post its summary. The listener fires while the
    // attempt is still unattributed (must NOT show mid-send), and when the
    // send thread settles, the final outcome wins over "awaiting radio
    // results" instead of being clobbered by it.
    @Test
    fun finalizedInsideSendAlert_finalOutcomeWinsOverSummary() {
        tracker.beginAttempt()
        tracker.record("s1", failed)
        // Listener fires before attemptSendId: nothing attributable yet.
        assertNull(tracker.showableOutcomeFor("s1"))
        // sendAlert returns; the send thread attributes, then settles.
        tracker.attemptSendId("s1")
        assertSame(failed, tracker.finalizedForCurrentAttempt())
        // Resume must not repeat the already-shown outcome.
        assertNull(tracker.resumeOutcome())
    }

    // Normal ordering: summary posts first ("awaiting radio results"), radio
    // results finalize later; the listener then replaces the line with the
    // final outcome, exactly once.
    @Test
    fun finalizedAfterSummary_listenerShowsOutcomeOnce() {
        tracker.beginAttempt()
        tracker.attemptSendId("s1")
        tracker.record("s1", delivered)
        assertSame(delivered, tracker.showableOutcomeFor("s1"))
        // A duplicate delivery of the same finalize (e.g. watchdog + last
        // part racing) must not re-post the line.
        assertNull(tracker.showableOutcomeFor("s1"))
        // Settle already happened; the precedence check stays consistent.
        assertSame(delivered, tracker.finalizedForCurrentAttempt())
    }

    // Overlapping attempts: attempt A's batch finalizes late, after attempt
    // B started ("Sending alert…" on screen). A's outcome is recorded for
    // completeness but must never overwrite B's status.
    @Test
    fun lateOutcomeFromEarlierAttempt_neverShownOverNewAttempt() {
        tracker.beginAttempt()
        tracker.attemptSendId("sA")
        tracker.beginAttempt() // attempt B tapped before A's radio answered
        tracker.record("sA", delivered)
        assertNull(tracker.showableOutcomeFor("sA"))
        // B sent nothing yet: neither settle nor resume may surface A.
        assertNull(tracker.finalizedForCurrentAttempt())
        assertNull(tracker.resumeOutcome())
    }

    // Re-queued deliveries send through DeviceSmsSender without a Send-button
    // attempt: their outcomes stay off the inline line entirely.
    @Test
    fun requeuedBatchOutcome_neverShown() {
        tracker.record("requeued-1", delivered)
        assertNull(tracker.showableOutcomeFor("requeued-1"))
        assertNull(tracker.resumeOutcome())
        // Even with an unrelated attempt in flight.
        tracker.beginAttempt()
        tracker.attemptSendId("s1")
        assertNull(tracker.showableOutcomeFor("requeued-1"))
    }

    // Backgrounded through an activity recreate: the listener was gone when
    // the batch finalized, so nothing was shown; the next resume shows the
    // final answer once, then never again.
    @Test
    fun outcomeFinalizedWhileUnwatched_shownOnceOnResume() {
        tracker.beginAttempt()
        tracker.attemptSendId("s1")
        tracker.record("s1", delivered) // listener cleared; showableOutcomeFor never called
        assertSame(delivered, tracker.resumeOutcome())
        assertNull(tracker.resumeOutcome())
    }

    // Offline sends (no incident) still get a batch and a final outcome;
    // attribution works the same.
    @Test
    fun offlineSend_outcomeShownForCurrentAttempt() {
        tracker.beginAttempt()
        tracker.attemptSendId("offline-abc")
        val line = SendOutcomeStatus.batchOutcome(null, delivered = 1, total = 1, failures = emptyList())
        tracker.record("offline-abc", line)
        assertSame(line, tracker.showableOutcomeFor("offline-abc"))
    }

    // Early-return outcomes (no responders, permission, persist abort) start
    // no batch: no outcome can ever appear for them, and the settle path
    // falls back to the summary.
    @Test
    fun attemptWithNoBatch_settleFallsBackToSummary() {
        tracker.beginAttempt()
        tracker.attemptSendId(null)
        assertNull(tracker.finalizedForCurrentAttempt())
        assertNull(tracker.resumeOutcome())
    }

    // Memory bound: remembered outcomes are capped, oldest first.
    @Test
    fun rememberedOutcomes_areBounded() {
        val bounded = BatchOutcomeTracker(maxRemembered = 2)
        bounded.record("a", delivered)
        bounded.record("b", delivered)
        bounded.record("c", delivered)
        bounded.attemptSendId("a") // oldest, evicted
        assertNull(bounded.finalizedForCurrentAttempt())
        bounded.attemptSendId("c")
        assertEquals(delivered, bounded.finalizedForCurrentAttempt())
    }
}
