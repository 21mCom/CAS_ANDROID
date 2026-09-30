package com.covertalert.pixeltest

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the push-before-start race on the location re-capture watch: the
 * incident-resolved FCM message can arrive BEFORE the trigger response
 * reaches the phone (a responder acks and resolves mid-send), and a late
 * LocationWatchdog.start for that incident must be blocked — otherwise a
 * stationary phone keeps tracking until the next 5-minute periodic post is
 * rejected. These mirror the exact guard calls LocationWatchdog makes.
 */
class ResolvedWatchGuardTest {

    private val t0 = 1_700_000_000_000L

    @Test
    fun `push before start blocks the late watch start`() {
        val guard = ResolvedWatchGuard()
        // Arrival order 1: resolved push lands first, start comes later.
        guard.markResolved("inc-1", t0)
        assertTrue(guard.blocksStart("inc-1", t0 + 2_000L))
    }

    @Test
    fun `no push means start is allowed`() {
        val guard = ResolvedWatchGuard()
        // Arrival order 2: start runs before any push — nothing blocks it;
        // the later push stops the running watch via stopForIncident.
        assertFalse(guard.blocksStart("inc-1", t0))
        guard.markResolved("inc-1", t0 + 5_000L)
        assertTrue(guard.blocksStart("inc-1", t0 + 6_000L))
    }

    @Test
    fun `a resolved push for one incident never blocks another`() {
        val guard = ResolvedWatchGuard()
        guard.markResolved("inc-1", t0)
        assertFalse(guard.blocksStart("inc-2", t0 + 1_000L))
    }

    @Test
    fun `markers expire so nothing is blocked forever`() {
        val guard = ResolvedWatchGuard()
        guard.markResolved("inc-1", t0)
        assertTrue(guard.blocksStart("inc-1", t0 + AlertLocation.RESOLVED_MARKER_TTL_MS - 1_000L))
        assertFalse(guard.blocksStart("inc-1", t0 + AlertLocation.RESOLVED_MARKER_TTL_MS + 1_000L))
    }

    @Test
    fun `a repeated push refreshes the marker instead of doubling it`() {
        val guard = ResolvedWatchGuard()
        guard.markResolved("inc-1", t0)
        guard.markResolved("inc-1", t0 + 30_000L)
        assertTrue(guard.blocksStart("inc-1", t0 + 30_000L + AlertLocation.RESOLVED_MARKER_TTL_MS - 1_000L))
        assertFalse(guard.blocksStart("inc-1", t0 + 30_000L + AlertLocation.RESOLVED_MARKER_TTL_MS + 1_000L))
    }
}
