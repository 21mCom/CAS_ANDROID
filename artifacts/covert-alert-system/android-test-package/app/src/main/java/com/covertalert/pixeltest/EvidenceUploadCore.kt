package com.covertalert.pixeltest

import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.URLEncoder
import java.util.UUID

/**
 * Android-free decision core for durable evidence staging and upload. Every
 * finished segment is staged as a temp+rename pair (data first, sidecar last)
 * before any network attempt; only the server's permanent rejection or
 * acceptance can remove the staged bytes, and a 401 clears the enrolled
 * credential exactly once.
 *
 * Everything Android-specific (device-protected storage, TestStore,
 * ConnectionConfig's HTTPS-only HttpURLConnection) is injected through [Env]
 * so the crash windows can be exercised on the JVM: EvidenceUploader backs
 * [Env] with the real handset environment; the repo-only harness backs it
 * with a fake store and a scripted HTTP layer
 * (scripts/test-evidence-upload.sh). Nothing in this file may import
 * android.* — the harness compiles this file without an Android runtime.
 */
object EvidenceUploadCore {
    data class Meta(
        val incidentId: String,
        val kind: String,
        val capturedAtMs: Long,
        val sequence: Int,
        val requestId: String? = null,
        // Which lens a photo/video clip came from ("front" | "back"); null for
        // audio so the server stores no meaningless label.
        val camera: String? = null,
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

    /** Journal sink for upload outcomes (TestStore.record on the handset). */
    interface Journal {
        fun record(type: String, fields: Map<String, Any?>)
    }

    /** The enrolled-credential state the upload decisions depend on. */
    interface Credentials {
        fun alertServerUrl(): String
        fun enrolledDeviceToken(): String
        /** Clears the enrolled credential after the server rejects it (401). */
        fun clearEnrolledDeviceToken()
    }

    /**
     * Minimal HTTP surface one evidence POST needs. The handset backs this
     * with ConnectionConfig's HTTPS-only HttpURLConnection (which also
     * attaches the Bearer credential); the harness backs it with a scripted
     * fake. Deliberately exposes no way to set Authorization here: the
     * credential must only ever be attached by the connection factory.
     */
    interface Connection {
        var requestMethod: String
        var doOutput: Boolean
        fun setRequestProperty(key: String, value: String)
        fun setFixedLengthStreamingMode(contentLength: Long)
        val outputStream: OutputStream
        val responseCode: Int
        fun disconnect()
    }

    interface Env {
        val journal: Journal
        val credentials: Credentials

        /** The durable staging directory, created if missing. */
        fun pendingDirectory(): File

        /**
         * New file handle for a staged name inside [dir]. Production uses a
         * plain File; the harness overrides this to fail one specific write,
         * rename, or delete the way a process death or full disk would, so
         * the crash windows between the durable boundaries are exercisable.
         */
        fun stagedFile(dir: File?, name: String): File = File(dir, name)

        /** Opens the (HTTPS-only, Bearer-authorized) evidence POST connection. */
        fun openConnection(baseUrl: String, path: String): Connection
    }

    @Synchronized
    fun enqueue(env: Env, meta: Meta, bytes: ByteArray): File {
        require(meta.incidentId.isNotBlank() && meta.sequence >= 1)
        val dir = env.pendingDirectory()
        val id = UUID.randomUUID().toString()
        val data = env.stagedFile(dir, "$id.${meta.extension}")
        val sidecar = env.stagedFile(dir, "$id.json")
        val dataTemp = env.stagedFile(dir, "$id.tmp")
        val metadataTemp = env.stagedFile(dir, "$id.meta-tmp")
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
            if (meta.camera != null) json.put("camera", meta.camera)
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
    fun uploadAll(env: Env) {
        val dir = env.pendingDirectory()
        dir.listFiles { file -> file.extension == "json" }?.forEach { listed ->
            val sidecar = env.stagedFile(dir, listed.name)
            try { upload(env, sidecar) } catch (error: Exception) {
                env.journal.record("EVIDENCE_UPLOAD", mapOf("outcome" to "RETRY_LATER", "detail" to error.toString()))
            }
        }
    }

    @Synchronized
    fun upload(env: Env, sidecar: File) {
        if (!sidecar.exists()) return
        val json = try { JSONObject(sidecar.readText()) } catch (error: Exception) {
            env.journal.record("EVIDENCE_UPLOAD", mapOf("outcome" to "RETRY_LATER", "detail" to error.toString()))
            return
        }
        val kind = json.getString("kind")
        val ext = when (kind) { "audio" -> "m4a"; "photo" -> "jpg"; "video" -> "mp4"; else -> null }
        if (ext == null) {
            env.journal.record("EVIDENCE_UPLOAD", mapOf("outcome" to "RETRY_LATER", "detail" to "invalid kind"))
            return
        }
        val file = env.stagedFile(sidecar.parentFile, "${sidecar.nameWithoutExtension}.$ext")
        if (!file.exists()) {
            env.journal.record("EVIDENCE_UPLOAD", mapOf("outcome" to "RETRY_LATER", "kind" to kind, "detail" to "missing bytes"))
            return
        }
        val base = env.credentials.alertServerUrl()
        // Evidence endpoints accept only this handset's enrolled credential;
        // with none (never enrolled, or cleared after a 401 rejection) there
        // is no credential the server would accept, so retrying is pointless.
        if (base.isBlank() || env.credentials.enrolledDeviceToken().isBlank()) {
            env.journal.record("EVIDENCE_UPLOAD", mapOf("outcome" to "DROPPED", "kind" to kind, "detail" to "no enrolled device credential; evidence endpoints require enrollment"))
            sidecar.delete()
            env.stagedFile(sidecar.parentFile, "${sidecar.nameWithoutExtension}.$ext").delete()
            return
        }
        val status = try {
            val incident = URLEncoder.encode(json.getString("incidentId"), "UTF-8")
            val connection = env.openConnection(base, "/api/cas/incidents/$incident/evidence")
            try {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", json.getString("contentType"))
                connection.setRequestProperty("X-Cas-Evidence-Kind", kind)
                connection.setRequestProperty("X-Cas-Captured-At", json.getLong("capturedAtMs").toString())
                connection.setRequestProperty("X-Cas-Sequence", json.getInt("sequence").toString())
                if (json.has("requestId")) connection.setRequestProperty("X-Cas-Capture-Request-Id", json.getString("requestId"))
                if (json.has("camera")) connection.setRequestProperty("X-Cas-Evidence-Camera", json.getString("camera"))
                connection.setFixedLengthStreamingMode(file.length())
                connection.outputStream.use { output -> file.inputStream().use { it.copyTo(output) } }
                connection.responseCode
            } finally {
                connection.disconnect()
            }
        } catch (error: Exception) {
            env.journal.record("EVIDENCE_UPLOAD", mapOf("outcome" to "RETRY_LATER", "kind" to kind, "detail" to error.toString()))
            return
        }
        if (status == 401) {
            // The server rejected this handset's enrolled credential (revoked
            // or unknown). Clear it so no evidence path keeps presenting a
            // dead credential; the endpoints accept nothing else, so capture
            // stops until the phone is re-enrolled from the console.
            env.credentials.clearEnrolledDeviceToken()
        }
        val outcome = when (status) {
            in 200..299 -> "UPLOADED"
            in 400..499 -> "REJECTED"
            else -> "RETRY_LATER"
        }
        env.journal.record("EVIDENCE_UPLOAD", mapOf(
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
