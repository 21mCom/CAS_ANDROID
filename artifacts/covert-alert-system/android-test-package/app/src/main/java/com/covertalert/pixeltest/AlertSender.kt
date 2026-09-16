package com.covertalert.pixeltest

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * MVP alert sender: one HTTPS POST to the CAS API trigger endpoint.
 * Deliberately minimal - no retries, no location, no evidence capture, no SMS.
 * Gate 0A harness runs never call this; it is only invoked from the MVP button.
 */
object AlertSender {
    data class Result(val ok: Boolean, val detail: String)

    fun trigger(baseUrl: String): Result {
        val trimmed = baseUrl.trim().trimEnd('/')
        if (!trimmed.startsWith("https://")) {
            return Result(false, "Server URL must start with https://")
        }
        return runCatching {
            val connection = (URL("$trimmed/api/cas/incidents/trigger").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 10_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            try {
                connection.outputStream.use { it.write("{}".toByteArray(Charsets.UTF_8)) }
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.bufferedReader()?.readText().orEmpty()
                if (code in 200..299) {
                    // A 2xx without a usable incident id means something else answered
                    // (proxy fallback, HTML page) and no incident was committed.
                    val id = runCatching { JSONObject(body).optString("id") }.getOrDefault("")
                    if (id.isNotBlank()) {
                        Result(true, "HTTP $code incident=$id")
                    } else {
                        Result(false, "HTTP $code but no incident id in response")
                    }
                } else {
                    Result(false, "HTTP $code ${body.take(200)}")
                }
            } finally {
                connection.disconnect()
            }
        }.getOrElse { Result(false, "Request failed: ${it.message ?: it.javaClass.simpleName}") }
    }
}
