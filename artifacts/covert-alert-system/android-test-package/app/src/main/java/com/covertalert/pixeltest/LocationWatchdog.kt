package com.covertalert.pixeltest

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.LocationRequest
import android.os.Handler
import android.os.Looper

/**
 * Movement-based location re-capture while one incident is ACTIVE. The
 * trigger-time fix is a single snapshot; a real P1 response can involve the
 * handset being moved or driven away, so while the incident stays active
 * this watch posts a new fix when the device moves RECAPTURE_DISTANCE_M
 * (capped at one post per RECAPTURE_MIN_INTERVAL_MS), and re-baselines every
 * RECAPTURE_PERIODIC_MS even when stationary. The decision rules live in the
 * android-free AlertLocation core; this file is the LocationManager plumbing.
 *
 * Battery and privacy posture, by contract:
 *  - The watch exists only while an incident is active. It is started from
 *    the trigger path and stops on the first server contact after the
 *    incident resolves (the location endpoint answers 409/404 and the watch
 *    tears down immediately), bounded by the periodic cycle when the handset
 *    never moves. It is never general background tracking.
 *  - Hard cap: the watch tears itself down after RECAPTURE_MAX_DURATION_MS
 *    even if the incident never resolves.
 *  - Process death ends the watch (it is in-process by design — no
 *    foreground service, no wake locks); the handset journal records the
 *    start and stop so a silent end is never mistaken for coverage.
 *
 * Every posted fix goes to POST /api/cas/incidents/{id}/location with the
 * enrolled device credential; the server journals each accepted fix
 * (LOCATION_UPDATED) so the console shows the history, newest authoritative.
 */
object LocationWatchdog {

    @Volatile private var watchedIncidentId: String? = null
    @Volatile private var baseUrl: String? = null
    @Volatile private var anchor: AlertLocation.Fix? = null
    @Volatile private var startedAtMs: Long = 0L
    private var handler: Handler? = null
    private var manager: LocationManager? = null
    private var providers: List<String> = emptyList()
    private var postInFlight = false

    private val listener = LocationListener { location -> onMovementFix(location) }

    private val periodicTick = object : Runnable {
        override fun run() {
            val context = appContext ?: return
            if (watchedIncidentId == null) return
            val now = System.currentTimeMillis()
            if (AlertLocation.recaptureExpired(startedAtMs, now)) {
                stop(context, "duration cap reached (${AlertLocation.RECAPTURE_MAX_DURATION_MS / 60_000L} min)")
                return
            }
            val anchorFix = anchor
            if (anchorFix == null || AlertLocation.periodicRecaptureDue(anchorFix.capturedAtMs, now)) {
                // Stationary re-baseline: one bounded capture, posted whatever
                // the distance — the periodic fix proves the handset is still
                // where the last fix put it (or honestly shows drift).
                Thread {
                    val fix = LocationCapture.capture(context)
                    if (fix != null) post(context, fix, periodic = true)
                    handler?.postDelayed(this, AlertLocation.RECAPTURE_PERIODIC_MS)
                }.start()
            } else {
                handler?.postDelayed(this, AlertLocation.RECAPTURE_PERIODIC_MS)
            }
        }
    }

    private var appContext: Context? = null

    /**
     * Start (or keep) the watch for an incident. Idempotent for the same
     * incident: a repeat trigger folded into the still-active incident keeps
     * the running watch and its anchor instead of re-baselining. A different
     * incident replaces the watch.
     */
    @Synchronized
    fun start(context: Context, serverBaseUrl: String, incidentId: String) {
        if (watchedIncidentId == incidentId) return
        if (watchedIncidentId != null) stop(context, "superseded by incident $incidentId")
        val fine = context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = context.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) {
            TestStore.record(context, "LOCATION_RECAPTURE_SKIPPED", mapOf("incidentId" to incidentId, "reason" to "no location permission"))
            return
        }
        val locationManager = context.getSystemService(LocationManager::class.java) ?: return
        val active = buildList {
            if (locationManager.allProviders.contains(LocationManager.GPS_PROVIDER)) add(LocationManager.GPS_PROVIDER)
            if (locationManager.allProviders.contains(LocationManager.NETWORK_PROVIDER)) add(LocationManager.NETWORK_PROVIDER)
            if (locationManager.allProviders.contains(LocationManager.FUSED_PROVIDER)) add(LocationManager.FUSED_PROVIDER)
        }
        if (active.isEmpty()) {
            TestStore.record(context, "LOCATION_RECAPTURE_SKIPPED", mapOf("incidentId" to incidentId, "reason" to "no location providers"))
            return
        }
        appContext = context.applicationContext
        watchedIncidentId = incidentId
        baseUrl = serverBaseUrl
        anchor = null
        startedAtMs = System.currentTimeMillis()
        manager = locationManager
        providers = active
        val mainHandler = Handler(Looper.getMainLooper())
        handler = mainHandler
        registerListeners(locationManager, active, mainHandler)
        mainHandler.postDelayed(periodicTick, AlertLocation.RECAPTURE_PERIODIC_MS)
        TestStore.record(context, "LOCATION_RECAPTURE_STARTED", mapOf(
            "incidentId" to incidentId,
            "providers" to active.joinToString("+"),
            "distanceM" to AlertLocation.RECAPTURE_DISTANCE_M.toInt(),
            "minIntervalS" to AlertLocation.RECAPTURE_MIN_INTERVAL_MS / 1000L,
            "periodicS" to AlertLocation.RECAPTURE_PERIODIC_MS / 1000L,
            "maxDurationMin" to AlertLocation.RECAPTURE_MAX_DURATION_MS / 60_000L,
        ))
    }

    /** Tear the watch down. Safe to call from any thread, any number of times. */
    @Synchronized
    fun stop(context: Context?, reason: String) {
        val incidentId = watchedIncidentId ?: return
        watchedIncidentId = null
        handler?.removeCallbacks(periodicTick)
        handler = null
        val locationManager = manager
        manager = null
        providers = emptyList()
        if (locationManager != null) {
            runCatching { locationManager.removeUpdates(listener) }
        }
        val journalContext = context ?: appContext
        appContext = null
        journalContext?.let {
            TestStore.record(it, "LOCATION_RECAPTURE_STOPPED", mapOf("incidentId" to incidentId, "reason" to reason))
        }
    }

    // Permission is checked in start(); the OS cannot revoke it without
    // killing the process, which ends the watch anyway.
    @SuppressLint("MissingPermission")
    private fun registerListeners(locationManager: LocationManager, active: List<String>, mainHandler: Handler) {
        val request = LocationRequest.Builder(AlertLocation.RECAPTURE_MIN_INTERVAL_MS)
            .setMinUpdateDistanceMeters(AlertLocation.RECAPTURE_DISTANCE_M)
            .setMinUpdateIntervalMillis(AlertLocation.RECAPTURE_MIN_INTERVAL_MS)
            .build()
        val executor = java.util.concurrent.Executor { command -> mainHandler.post(command) }
        for (provider in active) {
            runCatching {
                locationManager.requestLocationUpdates(provider, request, executor, listener)
            }
        }
    }

    private fun onMovementFix(location: Location) {
        val context = appContext ?: return
        if (watchedIncidentId == null) return
        if (AlertLocation.recaptureExpired(startedAtMs, System.currentTimeMillis())) {
            stop(context, "duration cap reached (${AlertLocation.RECAPTURE_MAX_DURATION_MS / 60_000L} min)")
            return
        }
        val fix = AlertLocation.Fix(
            latitude = location.latitude,
            longitude = location.longitude,
            accuracyM = if (location.hasAccuracy()) location.accuracy else 10_000f,
            capturedAtMs = location.time,
            provider = location.provider ?: "unknown",
            lastKnown = false,
        )
        if (!AlertLocation.acceptMovementFix(anchor, fix)) return
        post(context, fix, periodic = false)
    }

    /**
     * Post one fix to the server on a worker thread. The response is the
     * handset's incident-state signal: 409/404 means the incident is no
     * longer active and the watch stops immediately; 401 means the device
     * credential was revoked (AlertSender drops it) and the watch stops —
     * a revoked phone must not keep tracking.
     */
    @Synchronized
    private fun post(context: Context, fix: AlertLocation.Fix, periodic: Boolean) {
        if (postInFlight) return
        val incidentId = watchedIncidentId ?: return
        val url = baseUrl ?: return
        postInFlight = true
        Thread {
            try {
                val result = AlertSender.postLocationUpdate(context, url, incidentId, fix)
                when (result.outcome) {
                    AlertSender.LocationPostOutcome.STORED -> {
                        anchor = fix
                        TestStore.record(context, "LOCATION_RECAPTURE_FIX", mapOf(
                            "incidentId" to incidentId,
                            "outcome" to if (periodic) "POSTED_PERIODIC" else "POSTED_MOVEMENT",
                            "accuracyM" to fix.accuracyM.toInt(),
                            "fixAgeS" to (System.currentTimeMillis() - fix.capturedAtMs) / 1000,
                            "provider" to fix.provider,
                        ))
                    }
                    AlertSender.LocationPostOutcome.STALE_IGNORED -> {
                        // A fresher fix already reached the server (e.g. the
                        // periodic capture raced a movement post): not an
                        // error, and the anchor stays the newer server-side fix.
                        anchor = fix
                        TestStore.record(context, "LOCATION_RECAPTURE_FIX", mapOf(
                            "incidentId" to incidentId,
                            "outcome" to "STALE_IGNORED",
                            "accuracyM" to fix.accuracyM.toInt(),
                            "provider" to fix.provider,
                        ))
                    }
                    AlertSender.LocationPostOutcome.INCIDENT_INACTIVE ->
                        stop(context, "incident no longer active on the server")
                    AlertSender.LocationPostOutcome.CREDENTIAL_REJECTED ->
                        stop(context, "device credential rejected")
                    AlertSender.LocationPostOutcome.FAILED ->
                        // Transient (offline, server down): keep the watch;
                        // the anchor does NOT advance, so the next movement
                        // still measures from the last fix the server has.
                        TestStore.record(context, "LOCATION_RECAPTURE_FIX", mapOf(
                            "incidentId" to incidentId,
                            "outcome" to "POST_FAILED",
                            "detail" to result.detail,
                        ))
                }
            } finally {
                postInFlight = false
            }
        }.start()
    }
}
