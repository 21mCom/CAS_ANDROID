package com.covertalert.pixeltest

/**
 * Decides which finalized SMS batch outcome the Send button's inline status
 * line may show, and when. Pure (no Android imports) so the ordering and
 * attribution decisions are unit-testable on the JVM; DeviceSmsSender records
 * every finalized batch here, and MainActivity only displays what this
 * returns. All methods must be called under `synchronized` on the instance.
 *
 * Two failure modes this exists to prevent:
 *
 * 1. Clobbering: a batch can finalize INSIDE sendAlert (fast radio callbacks,
 *   or every dispatch failing immediately), before the caller posts its
 *   "awaiting radio results" dispatch summary. Without a precedence rule the
 *   later summary post would replace the final answer. [attemptSendId] +
 *   [finalizedForCurrentAttempt] make the finalized outcome win regardless
 *   of callback order.
 * 2. Misattribution: re-queued deliveries and stragglers from an earlier
 *   attempt also finalize. Their outcomes are recorded (the journal remains
 *   the detailed source) but never shown over a newer attempt's status —
 *   only the attempt that currently owns the Send line may be updated.
 */
class BatchOutcomeTracker(private val maxRemembered: Int = 16) {

    private class Entry(val seq: Int, val line: SendOutcomeStatus.Line)

    /** Send id of the batch started by the current Send-button attempt; null before its sendAlert runs. */
    private var currentSendId: String? = null
    private val entries = LinkedHashMap<String, Entry>()
    private val shownSeqs = mutableSetOf<Int>()
    private var nextSeq = 0

    /** A new Send-button attempt started: the previous attempt's batch no longer owns the status line. */
    fun beginAttempt() {
        currentSendId = null
    }

    /** The current attempt's sendAlert produced this send id (null when no batch was started). */
    fun attemptSendId(sendId: String?) {
        currentSendId = sendId
    }

    /** Records a finalized batch outcome. Call for EVERY batch, shown or not. */
    fun record(sendId: String, line: SendOutcomeStatus.Line) {
        entries[sendId] = Entry(++nextSeq, line)
        while (entries.size > maxRemembered) {
            entries.remove(entries.keys.first())
        }
    }

    /**
     * Listener path: the line to show for a just-recorded outcome, or null
     * when it belongs to a re-queued delivery or a superseded attempt, or
     * was already shown. Marks a shown outcome so resume does not repeat it.
     */
    fun showableOutcomeFor(sendId: String): SendOutcomeStatus.Line? {
        if (sendId != currentSendId) return null
        val entry = entries[sendId] ?: return null
        if (!shownSeqs.add(entry.seq)) return null
        return entry.line
    }

    /**
     * Attempt-settle path: when the send thread posts its dispatch summary,
     * the final outcome wins if the batch already finalized (the summary's
     * "awaiting radio results" must never overwrite it).
     */
    fun finalizedForCurrentAttempt(): SendOutcomeStatus.Line? {
        val sendId = currentSendId ?: return null
        val entry = entries[sendId] ?: return null
        shownSeqs.add(entry.seq)
        return entry.line
    }

    /**
     * Resume path: the current attempt's final outcome if it landed while
     * the status line was unwatched (listener gone); shown once.
     */
    fun resumeOutcome(): SendOutcomeStatus.Line? {
        val sendId = currentSendId ?: return null
        val entry = entries[sendId] ?: return null
        if (!shownSeqs.add(entry.seq)) return null
        return entry.line
    }
}
