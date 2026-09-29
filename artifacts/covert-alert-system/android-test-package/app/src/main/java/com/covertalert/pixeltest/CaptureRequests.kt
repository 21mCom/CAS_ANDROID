package com.covertalert.pixeltest

import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.net.URLEncoder

/** Polling is user-initiated/on-resume only, or woken by a high-priority FCM
 * message (CapturePushService, [via] = "push"). Android may deny a background
 * mic/camera foreground-service start; report that measured denial to CAS.
 * The server journals [via] per request, so the handoff docs can prove which
 * wake path honored each responder request. */
object CaptureRequests {
    fun checkPending(context: Context, via: String = "poll") {
        val base = TestStore.alertServerUrl(context)
        if (base.isBlank()) return
        // Pickup requires the enrolled credential; the shared device token is
        // not accepted, so a revoked (cleared) handset stops polling here.
        if (TestStore.enrolledDeviceToken(context).isBlank()) return
        val connection = ConnectionConfig.open(context, base, "/api/cas/capture-requests/pending")
        val items = try {
            connection.requestMethod = "GET"
            if (connection.responseCode != 200) throw IllegalStateException("Capture requests HTTP ${connection.responseCode}")
            JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).getJSONArray("items")
        } finally {
            connection.disconnect()
        }
        for (index in 0 until items.length()) {
            val item = items.getJSONObject(index)
            val id = item.getString("id")
            val incident = item.getString("incidentId")
            val kind = item.getString("kind")
            if (kind !in setOf("audio", "photo", "video")) {
                TestStore.record(context, "CAPTURE_REQUEST_ACK", mapOf("id" to id, "outcome" to "failed", "detail" to "Invalid kind: $kind", "via" to via))
                ack(context, base, id, "failed", "Invalid kind: $kind", via)
                continue
            }
            TestStore.record(context, "CAPTURE_REQUEST_RECEIVED", mapOf("id" to id, "kind" to kind, "incidentId" to incident, "via" to via))
            // The server's pending request is an explicit responder command;
            // the cached policy supplies timing and camera, not an ON_TRIGGER
            // override.
            val policy = CapturePolicy.cached(context)
            val failure = try {
                context.startForegroundService(Intent(context, EvidenceCaptureService::class.java).apply {
                    putExtra("incident_id", incident)
                    putExtra("kinds", arrayOf(kind))
                    putExtra("timing", policy.timing.wire)
                    putExtra("camera", policy.camera.wire)
                    putExtra("request_id", id)
                })
                null
            } catch (error: Exception) {
                "${error.javaClass.simpleName}: ${error.message}"
            }
            val outcome = if (failure == null) "started" else "failed"
            // A failed ack remains pending server-side and can be measured
            // again; never misrepresent a forbidden background start as success.
            try {
                ack(context, base, id, outcome, failure, via)
                TestStore.record(context, "CAPTURE_REQUEST_ACK", mapOf("id" to id, "outcome" to outcome, "detail" to failure, "via" to via))
            } catch (error: Exception) {
                TestStore.record(context, "CAPTURE_REQUEST_ACK", mapOf("id" to id, "outcome" to outcome, "detail" to (failure ?: error.toString()), "ackError" to error.toString(), "via" to via))
            }
        }
    }

    private fun ack(context: Context, base: String, id: String, outcome: String, detail: String?, via: String) {
        val encoded = URLEncoder.encode(id, "UTF-8")
        val connection = ConnectionConfig.open(context, base, "/api/cas/capture-requests/$encoded/ack")
        try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            val body = JSONObject().put("outcome", outcome).put("via", via)
            if (detail != null) body.put("detail", detail)
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            if (code != 200 && code != 409) throw IllegalStateException("Capture request ack HTTP $code")
        } finally {
            connection.disconnect()
        }
    }
}