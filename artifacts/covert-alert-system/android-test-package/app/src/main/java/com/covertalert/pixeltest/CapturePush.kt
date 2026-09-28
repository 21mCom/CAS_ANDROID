package com.covertalert.pixeltest

import android.content.Context
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * Responder-requested capture wake. The server sends a high-priority,
 * data-only FCM message when a responder creates a capture request; the
 * message wakes the phone immediately and is the documented exemption that
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
