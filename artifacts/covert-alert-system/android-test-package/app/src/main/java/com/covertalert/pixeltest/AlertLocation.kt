package com.covertalert.pixeltest

import kotlin.math.roundToInt
import org.json.JSONObject
import java.util.Locale

/**
 * Android-free core for the alert location fix: the value object, the
 * accuracy/timeout selection rules, and the exact SMS wording. Keeping this
 * free of android.* imports lets scripts/test-alert-location.sh exercise the
 * decision logic on the JVM (same pattern as ReceiptDurability.kt), so the
 * rules that decide what responders read are provable without an emulator.
 *
 * Contract this core enforces:
 *  - A fix always travels with its accuracy radius and capture time; the SMS
 *    clause states the fix's age so a stale fix is never read as current.
 *  - The bounded wait prefers a fresh fix with good accuracy; when the wait
 *    expires, the best fresh fix seen (however coarse) beats a last-known
 *    fix only if it is actually fresher — age, not recency of arrival,
 *    decides. All timestamps are wall-clock milliseconds (Location.getTime()
 *    is UTC ms), so age is computed against System.currentTimeMillis().
 */
object AlertLocation {
    /** Fixes at least this accurate end the capture wait immediately. */
    const val GOOD_ACCURACY_M = 50f

    /** Hard cap on the capture wait; the alert never waits longer for GPS. */
    const val MAX_WAIT_MS = 8_000L

    /** A last-known fix older than this is not worth sending at all. */
    const val MAX_LAST_KNOWN_AGE_MS = 6L * 60L * 60L * 1000L // 6 h

    data class Fix(
        val latitude: Double,
        val longitude: Double,
        val accuracyM: Float,
        val capturedAtMs: Long,
        /** "gps" / "network" / "fused"; "+last-known" when no fresh fix arrived in time. */
        val provider: String,
        val lastKnown: Boolean,
    )

    /**
     * True when the candidate should replace the incumbent while waiting for
     * a good fix: lower accuracy wins; ties go to the fresher fix.
     */
    fun betterFix(candidate: Fix, incumbent: Fix): Boolean =
        candidate.accuracyM < incumbent.accuracyM ||
            (candidate.accuracyM == incumbent.accuracyM && candidate.capturedAtMs > incumbent.capturedAtMs)

    /**
     * The fix to send when the bounded wait expired without a good fix: the
     * best fresh fix seen during the wait, unless a last-known fix is both
     * fresher and not ancient. Either way the SMS clause labels the age.
     */
    fun fallbackFix(bestFresh: Fix?, lastKnown: Fix?, nowMs: Long): Fix? {
        val usableLastKnown = lastKnown
            ?.takeIf { nowMs - it.capturedAtMs in 0..MAX_LAST_KNOWN_AGE_MS }
            ?.copy(provider = lastKnown.provider + "+last-known", lastKnown = true)
        return when {
            bestFresh == null -> usableLastKnown
            usableLastKnown == null -> bestFresh
            usableLastKnown.capturedAtMs > bestFresh.capturedAtMs -> usableLastKnown
            else -> bestFresh
        }
    }

    /**
     * True when the bounded capture wait may end: a fix at or inside
     * GOOD_ACCURACY_M arrived, or every requested provider has answered.
     * A null answer (provider off / no visibility) counts toward completion
     * but must never end the wait by itself — a fast null from fused or
     * network must not cancel a GPS request that is still acquiring.
     */
    fun captureComplete(answeredProviders: Int, requestedProviders: Int, best: Fix?): Boolean =
        (best != null && best.accuracyM <= GOOD_ACCURACY_M) ||
            (requestedProviders > 0 && answeredProviders >= requestedProviders)

    /** Human fix age, matching the console's buildLocationClause phrasing. */
    fun formatAge(nowMs: Long, capturedAtMs: Long): String {
        val ageSeconds = maxOf(0L, (nowMs - capturedAtMs) / 1000L)
        return if (ageSeconds < 90) "${ageSeconds}s" else "${(ageSeconds + 30) / 60}min"
    }

    fun mapsLink(latitude: Double, longitude: Double): String =
        "https://maps.google.com/?q=" +
            String.format(Locale.US, "%.5f,%.5f", latitude, longitude)

    /**
     * The location sentence of the alert SMS. Mirrors the console's
     * buildLocationClause in delivery-providers.ts — keep the two in sync.
     */
    fun smsLocationClause(fix: Fix?, nowMs: Long): String {
        if (fix == null) return "Location: no fix captured for this alert."
        // Round like the server's buildLocationClause (Math.round), not
        // truncate — the handset and console must state the same radius.
        val accuracy = fix.accuracyM.roundToInt()
        return "Location: ${mapsLink(fix.latitude, fix.longitude)} " +
            "(±${accuracy}m, fix ${formatAge(nowMs, fix.capturedAtMs)} old)."
    }

    /** Trigger-POST shape consumed by the server's triggerLocationSchema. */
    fun toTriggerJson(fix: Fix): JSONObject = JSONObject()
        .put("latitude", fix.latitude)
        .put("longitude", fix.longitude)
        .put("accuracyM", fix.accuracyM.toDouble())
        .put("capturedAt", java.time.Instant.ofEpochMilli(fix.capturedAtMs).toString())
        .put("provider", fix.provider)
}
