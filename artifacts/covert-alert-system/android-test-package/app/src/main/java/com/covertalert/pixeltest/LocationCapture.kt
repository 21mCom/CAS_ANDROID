package com.covertalert.pixeltest

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.CancellationSignal
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Bounded position capture for the alert path (the decision rules live in
 * the android-free AlertLocation core; this file is the LocationManager
 * plumbing). minSdk is 35, so LocationManager.getCurrentLocation (API 30+)
 * and the fused provider (API 31+) are always available.
 *
 * Guarantees the alert flow relies on:
 *  - Never waits longer than AlertLocation.MAX_WAIT_MS. The caller sends the
 *    alert with whatever this returns — capture can only delay the SMS by
 *    the bounded wait, never block it.
 *  - Returns instantly (null) when no location permission is granted — the
 *    alert must leave even on a fresh install where nobody granted it yet.
 *  - A fix that reaches GOOD_ACCURACY_M ends the wait early; on timeout the
 *    best fresh fix seen wins, else a last-known fix (labeled with its age),
 *    else null ("no fix captured").
 */
object LocationCapture {

    fun capture(context: Context, maxWaitMs: Long = AlertLocation.MAX_WAIT_MS): AlertLocation.Fix? {
        val fine = context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) return null
        val manager = context.getSystemService(LocationManager::class.java) ?: return null

        // Snapshot the last-known fix BEFORE waiting: it is the fallback when
        // no fresh fix arrives in time.
        val lastKnown = bestLastKnown(manager)

        val providers = buildList {
            if (manager.allProviders.contains(LocationManager.FUSED_PROVIDER)) add(LocationManager.FUSED_PROVIDER)
            if (manager.allProviders.contains(LocationManager.GPS_PROVIDER)) add(LocationManager.GPS_PROVIDER)
            if (manager.allProviders.contains(LocationManager.NETWORK_PROVIDER)) add(LocationManager.NETWORK_PROVIDER)
        }
        if (providers.isEmpty()) {
            return AlertLocation.fallbackFix(null, lastKnown, System.currentTimeMillis())
        }

        val latch = CountDownLatch(1)
        val best = AtomicReference<AlertLocation.Fix?>(null)
        // How many providers have answered (fix or null). A null answer must
        // never end the wait by itself — a fast null from fused/network must
        // not cancel a GPS request that is still acquiring a valid fix.
        val answered = AtomicInteger(0)
        val maybeRelease = {
            if (AlertLocation.captureComplete(answered.get(), providers.size, best.get())) {
                latch.countDown()
            }
        }
        val cancellation = CancellationSignal()
        val executor = context.mainExecutor
        val consumer = java.util.function.Consumer<Location?> { location ->
            if (location != null) {
                val fix = location.toFix(lastKnown = false)
                best.updateAndGet { incumbent ->
                    if (incumbent == null || AlertLocation.betterFix(fix, incumbent)) fix else incumbent
                }
            }
            answered.incrementAndGet()
            maybeRelease()
        }

        for (provider in providers) {
            runCatching {
                manager.getCurrentLocation(provider, cancellation, executor, consumer)
            }.onFailure {
                // The request itself failed (provider disabled between the
                // check and the call): it will never answer, so count it.
                answered.incrementAndGet()
                maybeRelease()
            }
        }
        runCatching { latch.await(maxWaitMs, TimeUnit.MILLISECONDS) }
        cancellation.cancel()
        return AlertLocation.fallbackFix(best.get(), lastKnown, System.currentTimeMillis())
    }

    private fun bestLastKnown(manager: LocationManager): AlertLocation.Fix? {
        var best: AlertLocation.Fix? = null
        for (provider in manager.allProviders) {
            val fix = runCatching { manager.getLastKnownLocation(provider) }.getOrNull()
                ?.toFix(lastKnown = true) ?: continue
            if (best == null || fix.capturedAtMs > best!!.capturedAtMs) best = fix
        }
        return best
    }

    private fun Location.toFix(lastKnown: Boolean): AlertLocation.Fix = AlertLocation.Fix(
        latitude = latitude,
        longitude = longitude,
        // No accuracy reading means the radius is unknown; report a
        // conservatively large value rather than pretending precision.
        accuracyM = if (hasAccuracy()) accuracy else 10_000f,
        capturedAtMs = time,
        provider = provider ?: "unknown",
        lastKnown = lastKnown,
    )
}
