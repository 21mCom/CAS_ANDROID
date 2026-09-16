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
 * deliver for the alert (always SMS here, plus WHATSAPP when the operator
 * enabled the checkbox), so the console only queues deliveries someone will
 * carry out. `reused` in the response means the trigger folded into an
 * already-active incident and the console queued nothing new — the handset
 * must not re-send physical messages either.
 */
object AlertSender {
    data class Result(val ok: Boolean, val detail: String, val incidentId: String? = null, val reused: Boolean = false)

    fun trigger(context: Context, baseUrl: String): Result {
        val trimmed = baseUrl.trim().trimEnd('/')
        if (!trimmed.startsWith("https://")) {
            return Result(false, "Server URL must start with https://")
        }
        val channels = buildList {
            add("SMS")
            if (TestStore.whatsAppEnabled(context)) add("WHATSAPP")
        }
        val payload = JSONObject().put("deviceChannels", JSONArray(channels)).toString()
        return runCatching {
            val connection = (URL("$trimmed/api/cas/incidents/trigger").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 10_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            try {
                connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.bufferedReader()?.readText().orEmpty()
                if (code in 200..299) {
                    // A 2xx without a usable incident id means something else answered
                    // (proxy fallback, HTML page) and no incident was committed.
                    val parsed = runCatching { JSONObject(body) }.getOrNull()
                    val id = parsed?.optString("id").orEmpty()
                    if (id.isNotBlank()) {
                        Result(true, "HTTP $code incident=$id", id, parsed?.optBoolean("reused") == true)
                    } else {
                        Result(false, "HTTP $code but no incident id in response")
                    }
                } else {
                    // A 409 here means the console does not have a requested
                    // channel enabled; the caller still sends the alert
                    // directly and journals the mismatch.
                    Result(false, "HTTP $code ${body.take(200)}")
                }
            } finally {
                connection.disconnect()
            }
        }.getOrElse { Result(false, "Request failed: ${it.message ?: it.javaClass.simpleName}") }
    }
}
