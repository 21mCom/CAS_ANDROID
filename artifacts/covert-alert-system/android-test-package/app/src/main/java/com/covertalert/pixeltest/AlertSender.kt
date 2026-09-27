package com.covertalert.pixeltest

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * MVP alert sender: one HTTPS POST to the CAS API trigger endpoint.
 * Deliberately minimal - no retries, no location, no evidence capture, no SMS.
 * Gate 0A harness runs never call this; it is only invoked from the MVP button.
 *
 * The POST body declares which device channels this handset will actually
 * deliver for the alert (always SMS here — it is the only device-direct
 * channel; every other channel fans out server-side so no alert path on
 * this handset can surface another app's UI), so the console only queues
 * deliveries someone will carry out. `reused` in the response means the
 * trigger folded into an already-active incident and the console queued
 * nothing new — the handset must not re-send physical messages either.
 *
 * The trigger endpoint is gated on per-device enrolled credentials: the
 * operator enters the shared enrollment credential (the server's
 * CAS_ALERT_TOKEN secret), this sender exchanges it once at the enrollment
 * endpoint for this handset's own revocable device token, and the enrollment
 * credential is then DISCARDED from device storage — the provisioned handset
 * no longer holds it. A 401 means the device credential was revoked (or never
 * enrolled): the cached token is dropped, but the handset does NOT re-enroll
 * itself — that would defeat revocation. Regaining access requires the
 * trusted operator action of re-entering the enrollment credential.
 */
object AlertSender {
    data class Result(
        val ok: Boolean,
        val detail: String,
        val incidentId: String? = null,
        val reused: Boolean = false,
        // True when this call enrolled and the entered enrollment credential
        // was consumed (discarded from storage); callers clear their input
        // field so the credential is not silently reused for a re-enrollment.
        val credentialConsumed: Boolean = false,
    )

    private data class Enrollment(val token: String?, val error: String?, val freshlyEnrolled: Boolean = false)

    fun trigger(context: Context, baseUrl: String, enrollmentCredential: String, fix: AlertLocation.Fix? = null): Result {
        val trimmed = baseUrl.trim().trimEnd('/')
        if (!trimmed.startsWith("https://") && !isDevLoopback(trimmed)) {
            return Result(false, "Server URL must start with https:// (plain HTTP is only accepted for loopback dev endpoints that cannot leave the machine: 127.0.0.1 via adb reverse, or the emulator's 10.0.2.2 host alias)")
        }
        val enrollment = enrollmentCredential.trim()
        if (enrollment.isEmpty()) {
            return Result(false, "Enrollment credential required - save the credential before sending")
        }
        val enrolled = ensureDeviceToken(context, trimmed, enrollment)
        if (enrolled.token == null) {
            return Result(false, enrolled.error ?: "Device enrollment failed")
        }
        val credentialConsumed = enrolled.freshlyEnrolled
        // The fix rides the trigger so the incident record carries the same
        // coordinates, accuracy, and capture time the SMS states.
        val payload = JSONObject().put("deviceChannels", JSONArray(listOf("SMS")))
        if (fix != null) payload.put("location", AlertLocation.toTriggerJson(fix))
        val payloadText = payload.toString()
        return runCatching {
            val connection = (URL("$trimmed/api/cas/incidents/trigger").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 10_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer ${enrolled.token}")
            }
            try {
                connection.outputStream.use { it.write(payloadText.toByteArray(Charsets.UTF_8)) }
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.bufferedReader()?.readText().orEmpty()
                if (code in 200..299) {
                    // A 2xx without a usable incident id means something else answered
                    // (proxy fallback, HTML page) and no incident was committed.
                    val parsed = runCatching { JSONObject(body) }.getOrNull()
                    val id = parsed?.optString("id").orEmpty()
                    if (id.isNotBlank()) {
                        Result(true, "HTTP $code incident=$id", id, parsed?.optBoolean("reused") == true, credentialConsumed)
                    } else {
                        Result(false, "HTTP $code but no incident id in response", credentialConsumed = credentialConsumed)
                    }
                } else {
                    if (code == 401) {
                        // Revoked or unknown device credential: drop the
                        // cached token, but do NOT re-enroll from any stored
                        // credential (there is none after provisioning) —
                        // regaining access is a trusted operator action:
                        // re-entering the enrollment credential.
                        TestStore.setEnrolledDeviceToken(context, "")
                        TestStore.record(context, "DEVICE_CREDENTIAL_REJECTED", mapOf("revokedOrUnknown" to true))
                    }
                    // A 409 here means the console does not have a requested
                    // channel enabled; the caller still sends the alert
                    // directly and journals the mismatch.
                    Result(false, "HTTP $code ${body.take(200)}", credentialConsumed = credentialConsumed)
                }
            } finally {
                connection.disconnect()
            }
        }.getOrElse { Result(false, "Request failed: ${it.message ?: it.javaClass.simpleName}") }
    }

    /**
     * Returns this handset's enrolled device credential, enrolling first when
     * none is cached: one POST to the enrollment endpoint with the shared
     * enrollment credential, whose response token is shown exactly once and
     * cached in device-protected storage. On success the enrollment
     * credential is DISCARDED from storage: the provisioned handset must not
     * retain the power to enroll again, or revoking its credential would be
     * undone by the next trigger. Only the enrolled device's id is journaled,
     * never either credential.
     */
    private fun ensureDeviceToken(context: Context, baseUrl: String, enrollmentCredential: String): Enrollment {
        val cached = TestStore.enrolledDeviceToken(context)
        if (cached.isNotBlank()) return Enrollment(cached, null)
        return runCatching {
            val connection = (URL("$baseUrl/api/cas/devices/enroll").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 10_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $enrollmentCredential")
            }
            try {
                val label = JSONObject().put("label", "handset-${android.os.Build.MODEL}").toString()
                connection.outputStream.use { it.write(label.toByteArray(Charsets.UTF_8)) }
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.bufferedReader()?.readText().orEmpty()
                if (code in 200..299) {
                    val parsed = runCatching { JSONObject(body) }.getOrNull()
                    val token = parsed?.optString("token").orEmpty()
                    val deviceId = parsed?.optJSONObject("device")?.optString("id").orEmpty()
                    if (token.isNotBlank()) {
                        TestStore.setEnrolledDeviceToken(context, token)
                        // Consume the enrollment credential: a provisioned
                        // handset keeps only its own revocable device token,
                        // so a revoked phone cannot silently re-enroll.
                        TestStore.setAlertToken(context, "")
                        TestStore.record(context, "DEVICE_CREDENTIAL_ENROLLED", mapOf("deviceId" to deviceId, "enrollmentCredentialDiscarded" to true))
                        Enrollment(token, null, freshlyEnrolled = true)
                    } else {
                        Enrollment(null, "Enrollment HTTP $code but no device token in response")
                    }
                } else {
                    Enrollment(null, "Enrollment HTTP $code ${body.take(200)}")
                }
            } finally {
                connection.disconnect()
            }
        }.getOrElse { Enrollment(null, "Enrollment request failed: ${it.message ?: it.javaClass.simpleName}") }
    }

    /**
     * Plain HTTP is only tolerated for endpoints that cannot leave the local
     * machine: 127.0.0.1 reaches a dev API forwarded over USB/emulator via
     * `adb reverse` (used by the emulator CI job and for field debugging
     * against a laptop), and 10.0.2.2 is the emulator's alias for the host
     * machine's loopback, which does not route on physical hardware.
     * Everything else stays HTTPS-only.
     */
    private fun isDevLoopback(url: String): Boolean =
        url == "http://10.0.2.2" || url.startsWith("http://10.0.2.2:") ||
            url == "http://127.0.0.1" || url.startsWith("http://127.0.0.1:") ||
            url == "http://localhost" || url.startsWith("http://localhost:")
}
