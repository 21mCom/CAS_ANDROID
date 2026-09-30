package com.covertalert.pixeltest

import android.content.Context
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * Push handling for two high-priority, data-only FCM messages the server
 * sends: the responder-requested capture wake and the incident-resolved
 * stand-down.
 *
 * Capture wake: when a responder creates a capture request, the message
 * wakes the phone immediately and is the documented exemption that
 * lets an idle app start the mic/camera foreground service from the
 * background. The handler deliberately reuses the polling pickup flow
 * (CaptureRequests.checkPending, via = "push") so request pickup, acks, and
 * failure reporting stay on one code path — the server journals which wake
 * path honored each request.
 *
 * Builds without a google-services.json have no Firebase configuration: the
 * service never receives a message, token registration no-ops (journaled
 * once as PUSH_UNAVAILABLE), and the polling path remains the wake
 * mechanism. The app never crashes on the missing config — the covert alert
 * kit must stay fully functional in its polling-only form.
 */
class CapturePushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        // Incident stand-down: tear the location re-capture watch down within
        // seconds of the console resolve instead of waiting for the next
        // location post to be rejected (up to one 5-minute periodic cycle on
        // a stationary phone). Only a push naming the watched incident stops
        // the watch — a stale push for an older incident is ignored.
        if (message.data["type"] == "cas-incident-resolved") {
            val resolvedIncidentId = message.data["incidentId"]
            TestStore.record(this, "RESOLVE_PUSH_RECEIVED", mapOf(
                "incidentId" to resolvedIncidentId,
            ))
            if (resolvedIncidentId != null) {
                LocationWatchdog.stopForIncident(this, resolvedIncidentId, "push")
            }
            return
        }
        if (message.data["type"] != "cas-capture-request") return
        TestStore.record(this, "CAPTURE_PUSH_RECEIVED", mapOf(
            "requestId" to message.data["requestId"],
            "incidentId" to message.data["incidentId"],
            "kind" to message.data["kind"],
        ))
        // Straight into the shared pickup flow on a worker thread; a denied
        // background start is measured and acked back to the server from
        // there, never hidden.
        Thread { CaptureRequests.checkPending(this, via = "push") }.start()
    }

    override fun onNewToken(token: String) {
        CapturePush.registerToken(this, token)
    }
}

object CapturePush {
    @Volatile private var availabilityRecorded = false

    /**
     * Refreshes this handset's FCM registration token with the CAS server.
     * Called on app resume (after the receipt/capture retry passes) and from
     * the service on rotation. No-ops, journaled once per process, when this
     * build carries no Firebase configuration.
     */
    fun syncRegistration(context: Context) {
        val messaging = try {
            FirebaseMessaging.getInstance()
        } catch (error: IllegalStateException) {
            recordUnavailableOnce(context, "no google-services.json in this build")
            return
        }
        messaging.token.addOnCompleteListener { task ->
            val token = task.result
            if (!task.isSuccessful || token.isNullOrBlank()) {
                recordUnavailableOnce(context, "token fetch failed: ${task.exception}")
                return@addOnCompleteListener
            }
            registerToken(context, token)
        }
    }

    private fun recordUnavailableOnce(context: Context, detail: String) {
        if (availabilityRecorded) return
        availabilityRecorded = true
        TestStore.record(context, "PUSH_UNAVAILABLE", mapOf("detail" to detail))
    }

    /** Registers (or rotates) the token against the enrolled credential. */
    fun registerToken(context: Context, token: String) {
        if (token == TestStore.registeredPushToken(context)) return
        val base = TestStore.alertServerUrl(context)
        // Pickup requires the enrolled credential; registration rides the
        // same gate, so a revoked (cleared) handset stops re-registering too.
        if (base.isBlank() || TestStore.enrolledDeviceToken(context).isBlank()) return
        Thread {
            val connection = ConnectionConfig.open(context, base, "/api/cas/devices/push-token")
            try {
                connection.requestMethod = "PUT"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(JSONObject().put("token", token).toString().toByteArray(Charsets.UTF_8)) }
                val code = connection.responseCode
                if (code != 200) throw IllegalStateException("Push token registration HTTP $code")
                TestStore.setRegisteredPushToken(context, token)
                TestStore.record(context, "PUSH_TOKEN_REGISTERED", mapOf("outcome" to "OK"))
            } catch (error: Exception) {
                TestStore.record(context, "PUSH_TOKEN_REGISTERED", mapOf("outcome" to "FAILED", "detail" to error.toString()))
            } finally {
                connection.disconnect()
            }
        }.start()
    }
}
