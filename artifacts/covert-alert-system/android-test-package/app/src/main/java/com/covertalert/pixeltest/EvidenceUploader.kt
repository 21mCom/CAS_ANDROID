package com.covertalert.pixeltest

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.UUID

/** A finished segment is staged durably before any network attempt. Only the
 * server's permanent rejection or acceptance can remove its staged bytes. */
object EvidenceUploader {
    data class Meta(
        val incidentId: String,
        val kind: String,
        val capturedAtMs: Long,
        val sequence: Int,
        val requestId: String? = null,
    ) {
        val contentType: String get() = when (kind) {
            "photo" -> "image/jpeg"
            "video" -> "video/mp4"
            "audio" -> "audio/mp4"
            else -> throw IllegalArgumentException("Unknown evidence kind: $kind")
        }
        val extension: String get() = when (kind) {
            "photo" -> "jpg"
            "video" -> "mp4"
            "audio" -> "m4a"
            else -> throw IllegalArgumentException("Unknown evidence kind: $kind")
        }
    }

    private fun directory(context: Context): File =
        File(context.createDeviceProtectedStorageContext().filesDir, "evidence-pending").also {
            if (!it.isDirectory && !it.mkdirs()) throw IOException("Cannot create evidence pending directory")
        }

    @Synchronized
    fun enqueue(context: Context, meta: Meta, bytes: ByteArray): File {
        require(meta.incidentId.isNotBlank() && meta.sequence >= 1)
        val dir = directory(context)
        val id = UUID.randomUUID().toString()
        val data = File(dir, "$id.${meta.extension}")
        val sidecar = File(dir, "$id.json")
        val dataTemp = File(dir, "$id.tmp")
        val metadataTemp = File(dir, "$id.meta-tmp")
        try {
            // temp + rename prevents a process death from exposing a partial
            // pair to uploadAll. Sync data before publishing the sidecar.
            dataTemp.also { tmp ->
                tmp.outputStream().use { stream -> stream.write(bytes); stream.fd.sync() }
                if (!tmp.renameTo(data)) throw IOException("Cannot publish evidence bytes")
            }
            val json = JSONObject().put("incidentId", meta.incidentId)
                .put("kind", meta.kind).put("capturedAtMs", meta.capturedAtMs)
                .put("sequence", meta.sequence).put("contentType", meta.contentType)
            if (meta.requestId != null) json.put("requestId", meta.requestId)
            metadataTemp.also { tmp ->
                tmp.outputStream().use { stream ->
                    stream.write(json.toString().toByteArray(Charsets.UTF_8))
                    stream.fd.sync()
                }
                if (!tmp.renameTo(sidecar)) throw IOException("Cannot publish evidence metadata")
            }
            return sidecar
        } catch (error: Exception) {
            dataTemp.delete()
            metadataTemp.delete()
            if (!sidecar.exists()) data.delete()
            throw error
        }
    }

    @Synchronized
    fun uploadAll(context: Context) {
        directory(context).listFiles { file -> file.extension == "json" }?.forEach { sidecar ->
            try { upload(context, sidecar) } catch (error: Exception) {
                TestStore.record(context, "EVIDENCE_UPLOAD", mapOf("outcome" to "RETRY_LATER", "detail" to error.toString()))
            }
        }
    }

    @Synchronized
    fun upload(context: Context, sidecar: File) {
        if (!sidecar.exists()) return
        val json = try { JSONObject(sidecar.readText()) } catch (error: Exception) {
            TestStore.record(context, "EVIDENCE_UPLOAD", mapOf("outcome" to "RETRY_LATER", "detail" to error.toString()))
            return
        }
        val kind = json.getString("kind")
        val ext = when (kind) { "audio" -> "m4a"; "photo" -> "jpg"; "video" -> "mp4"; else -> null }
        if (ext == null) {
            TestStore.record(context, "EVIDENCE_UPLOAD", mapOf("outcome" to "RETRY_LATER", "detail" to "invalid kind"))
            return
        }
        val file = File(sidecar.parentFile, "${sidecar.nameWithoutExtension}.$ext")
        if (!file.exists()) {
            TestStore.record(context, "EVIDENCE_UPLOAD", mapOf("outcome" to "RETRY_LATER", "kind" to kind, "detail" to "missing bytes"))
            return
        }
        val base = TestStore.alertServerUrl(context)
        // Evidence endpoints accept only this handset's enrolled credential;
        // with none (never enrolled, or cleared after a 401 rejection) there
        // is no credential the server would accept, so retrying is pointless.
        if (base.isBlank() || TestStore.enrolledDeviceToken(context).isBlank()) {
            TestStore.record(context, "EVIDENCE_UPLOAD", mapOf("outcome" to "DROPPED", "kind" to kind, "detail" to "no enrolled device credential; evidence endpoints require enrollment"))
            sidecar.delete()
            File(sidecar.parentFile, "${sidecar.nameWithoutExtension}.$ext").delete()
            return
        }
        val status = try {
            val incident = URLEncoder.encode(json.getString("incidentId"), "UTF-8")
            val connection = ConnectionConfig.open(context, base, "/api/cas/incidents/$incident/evidence")
            try {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", json.getString("contentType"))
                connection.setRequestProperty("X-Cas-Evidence-Kind", kind)
                connection.setRequestProperty("X-Cas-Captured-At", json.getLong("capturedAtMs").toString())
                connection.setRequestProperty("X-Cas-Sequence", json.getInt("sequence").toString())
                if (json.has("requestId")) connection.setRequestProperty("X-Cas-Capture-Request-Id", json.getString("requestId"))
                connection.setFixedLengthStreamingMode(file.length())
                connection.outputStream.use { output -> file.inputStream().use { it.copyTo(output) } }
                connection.responseCode
            } finally {
                connection.disconnect()
            }
        } catch (error: Exception) {
            TestStore.record(context, "EVIDENCE_UPLOAD", mapOf("outcome" to "RETRY_LATER", "kind" to kind, "detail" to error.toString()))
            return
        }
        if (status == 401) {
            // The server rejected this handset's enrolled credential (revoked
            // or unknown). Clear it so no evidence path keeps presenting a
            // dead credential; the endpoints accept nothing else, so capture
            // stops until the phone is re-enrolled from the console.
            TestStore.setEnrolledDeviceToken(context, "")
        }
        val outcome = when (status) {
            in 200..299 -> "UPLOADED"
            in 400..499 -> "REJECTED"
            else -> "RETRY_LATER"
        }
        TestStore.record(context, "EVIDENCE_UPLOAD", mapOf(
            "outcome" to outcome, "kind" to kind, "sizeBytes" to file.length(), "status" to status,
        ))
        if (outcome != "RETRY_LATER") {
            // The sidecar is removed first, so a crash during deletion cannot
            // replay an already accepted or permanently rejected clip.
            sidecar.delete()
            file.delete()
        }
    }
}