package com.covertalert.pixeltest

import org.json.JSONObject

/**
 * JVM harness for the android-free alert-location core (AlertLocation.kt).
 * The rules proven here decide what responders read about where the handset
 * was: which fix the bounded wait settles on, and that the SMS clause always
 * carries accuracy radius and fix age — a stale or coarse fix must never
 * read as current truth.
 *
 * Run via scripts/test-alert-location.sh.
 */
private var checks = 0

private fun check(condition: Boolean, label: String) {
    checks += 1
    if (!condition) throw AssertionError("FAILED: $label")
}

private fun fix(
    lat: Double = 52.5163,
    lng: Double = 13.3777,
    accuracy: Float = 12f,
    capturedAtMs: Long = 1_000_000L,
    provider: String = "gps",
    lastKnown: Boolean = false,
) = AlertLocation.Fix(lat, lng, accuracy, capturedAtMs, provider, lastKnown)

fun main() {
    val now = 2_000_000L

    // --- betterFix: accuracy wins, ties go to the fresher fix --------------
    check(AlertLocation.betterFix(fix(accuracy = 5f), fix(accuracy = 30f)), "tighter accuracy replaces a coarser fix")
    check(!AlertLocation.betterFix(fix(accuracy = 30f), fix(accuracy = 5f)), "coarser fix never replaces a tighter one")
    check(
        AlertLocation.betterFix(fix(accuracy = 10f, capturedAtMs = now), fix(accuracy = 10f, capturedAtMs = now - 1)),
        "equal accuracy: the fresher fix wins",
    )
    check(
        !AlertLocation.betterFix(fix(accuracy = 10f, capturedAtMs = now - 1), fix(accuracy = 10f, capturedAtMs = now)),
        "equal accuracy: an older fix never replaces a newer one",
    )

    // --- fallbackFix: what the alert carries when the wait expires ---------
    check(AlertLocation.fallbackFix(null, null, now) == null, "no fresh fix and no last-known: alert goes out with no fix")
    val fresh = fix(accuracy = 300f, capturedAtMs = now - 4_000L)
    check(AlertLocation.fallbackFix(fresh, null, now) == fresh, "a coarse fresh fix still ships when nothing better exists")

    // A last-known fix fresher than the best fresh fix wins — but it is
    // labeled as last-known so the wording cannot pass it off as live GPS.
    val lastKnown = fix(accuracy = 20f, capturedAtMs = now - 2_000L, provider = "network")
    val chosen = AlertLocation.fallbackFix(fresh, lastKnown, now)
    check(chosen != null && chosen.lastKnown && chosen.provider == "network+last-known", "fresher last-known wins and is labeled")
    check(AlertLocation.fallbackFix(fresh, lastKnown.copy(capturedAtMs = now - 10_000L), now) == fresh, "older last-known loses to the fresh fix")

    // An ancient last-known fix is worth less than nothing — a 7-hour-old
    // position in a distress alert would send responders to the wrong place.
    val ancient = lastKnown.copy(capturedAtMs = now - AlertLocation.MAX_LAST_KNOWN_AGE_MS - 1)
    check(AlertLocation.fallbackFix(null, ancient, now) == null, "ancient last-known fix is dropped entirely")
    // A last-known fix from "the future" (clock skew) is nonsense, not fresh.
    check(AlertLocation.fallbackFix(null, lastKnown.copy(capturedAtMs = now + 60_000L), now) == null, "future-dated last-known fix is dropped")

    // --- captureComplete: when the bounded wait may end ---------------------
    // Null-first, GPS-later: a fast null from fused/network must NOT release
    // the wait while GPS is still acquiring (the review-caught regression).
    check(!AlertLocation.captureComplete(answeredProviders = 1, requestedProviders = 3, best = null), "one null answer must not end the wait while other providers acquire")
    check(!AlertLocation.captureComplete(answeredProviders = 2, requestedProviders = 3, best = null), "two null answers must not end the wait while one provider still acquires")
    check(AlertLocation.captureComplete(answeredProviders = 3, requestedProviders = 3, best = null), "the wait ends once every provider has answered, even with all nulls")
    check(AlertLocation.captureComplete(answeredProviders = 1, requestedProviders = 3, best = fix(accuracy = 12f)), "a good fix ends the wait immediately, even with providers outstanding")
    check(!AlertLocation.captureComplete(answeredProviders = 1, requestedProviders = 3, best = fix(accuracy = 300f)), "a coarse fix does not end the wait early — a better one may still arrive")
    check(AlertLocation.captureComplete(answeredProviders = 3, requestedProviders = 3, best = fix(accuracy = 300f)), "a coarse fix ships once every provider answered (or the deadline hits)")
    check(!AlertLocation.captureComplete(answeredProviders = 0, requestedProviders = 0, best = null), "no requested providers never counts as complete")

    // --- formatAge ----------------------------------------------------------
    check(AlertLocation.formatAge(now, now - 5_000L) == "5s", "seconds under 90s")
    check(AlertLocation.formatAge(now, now - 89_999L) == "89s", "just under the minute cutoff")
    check(AlertLocation.formatAge(now, now - 90_000L) == "2min", "90s rounds to 2min")
    check(AlertLocation.formatAge(now, now - 3 * 3_600_000L) == "180min", "hours render as minutes")
    check(AlertLocation.formatAge(now, now + 10_000L) == "0s", "negative age (clock skew) clamps to 0s")

    // --- smsLocationClause: the exact wording responders read ---------------
    check(
        AlertLocation.smsLocationClause(null, now) == "Location: no fix captured for this alert.",
        "no fix says so instead of promising one",
    )
    check(
        AlertLocation.smsLocationClause(fix(accuracy = 12.5f, capturedAtMs = now - 30_000L), now) ==
            "Location: https://maps.google.com/?q=52.51630,13.37770 (±13m, fix 30s old).",
        "fix carries maps link, accuracy radius, and age",
    )
    check(
        AlertLocation.smsLocationClause(fix(lat = -33.8568, lng = 151.2153, accuracy = 800f, capturedAtMs = now - 3 * 3_600_000L), now) ==
            "Location: https://maps.google.com/?q=-33.85680,151.21530 (±800m, fix 180min old).",
        "stale coarse fix keeps its age in the wording (and locale can never mangle the coordinates)",
    )

    // --- toTriggerJson: the shape the server persists -----------------------
    // 2025-09-27T12:00:00Z — a fixed instant so the ISO string is asserted exactly.
    val json = AlertLocation.toTriggerJson(fix(lat = 48.8566, lng = 2.3522, accuracy = 30f, capturedAtMs = 1_758_974_400_000L, provider = "fused"))
    check(json.getDouble("latitude") == 48.8566 && json.getDouble("longitude") == 2.3522, "trigger JSON carries coordinates")
    check(json.getDouble("accuracyM") == 30.0, "trigger JSON carries accuracy")
    check(json.getString("capturedAt") == "2025-09-27T12:00:00Z", "trigger JSON carries ISO capture time")
    check(json.getString("provider") == "fused", "trigger JSON carries provider")
    // Round-trip: the server's zod schema must accept this exact shape.
    val parsed = JSONObject(json.toString())
    check(parsed.getDouble("latitude") in -90.0..90.0 && parsed.getDouble("longitude") in -180.0..180.0, "trigger JSON round-trips within server bounds")

    println("ALERT_LOCATION_OK checks=$checks")
}
