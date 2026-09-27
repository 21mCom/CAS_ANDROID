package com.covertalert.pixeltest

import android.content.Context
import org.json.JSONObject

/** Missing or malformed policy fields fail closed; they cannot enable capture. */
object CapturePolicy {
    enum class Setting(val wire: String) {
        OFF("off"), ON_TRIGGER("trigger"), ON_RESPONDER_REQUEST("responder");
        companion object {
            fun parse(value: String): Setting = entries.first { it.wire == value }
        }
    }
    enum class Timing(val wire: String) {
        IMMEDIATE("immediate"), SCREEN_OFF("screen-off");
        companion object {
            fun parse(value: String): Timing = entries.first { it.wire == value }
        }
    }
    data class Policy(val audio: Setting, val photo: Setting, val video: Setting, val timing: Timing)
    private val disabled = Policy(Setting.OFF, Setting.OFF, Setting.OFF, Timing.IMMEDIATE)

    private fun parse(raw: String): Policy {
        val json = JSONObject(raw)
        return Policy(
            Setting.parse(json.getString("audio")),
            Setting.parse(json.getString("photo")),
            Setting.parse(json.getString("video")),
            Timing.parse(json.getString("timing")),
        )
    }

    fun fetch(context: Context, baseUrl: String): Policy? {
        if (baseUrl.isBlank()) return null
        // Policy reads are credential-gated on the server (the policy reveals
        // the capture posture); the enrolled credential rides along, and a
        // rejected read falls back to the last cached policy.

        return try {
            val connection = ConnectionConfig.open(context, baseUrl, "/api/cas/evidence-policy")
            try {
                connection.requestMethod = "GET"
                if (connection.responseCode != 200) return null
                val raw = connection.inputStream.bufferedReader().use { it.readText() }
                val policy = parse(raw)
                TestStore.setCapturePolicyJson(context, raw)
                TestStore.record(context, "CAPTURE_POLICY", mapOf(
                    "audio" to policy.audio.wire, "photo" to policy.photo.wire,
                    "video" to policy.video.wire, "timing" to policy.timing.wire,
                ))
                policy
            } finally {
                connection.disconnect()
            }
        } catch (_: Exception) {
            null
        }
    }

    fun cached(context: Context): Policy =
        runCatching { parse(TestStore.capturePolicyJson(context) ?: return disabled) }.getOrDefault(disabled)
}