package com.covertalert.pixeltest

import android.content.Context
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection

/**
 * Android binding for the durable evidence uploader. All staging and retry
 * decisions live in the android-free [EvidenceUploadCore] so the process-death
 * windows can be exercised on the JVM (scripts/test-evidence-upload.sh); this
 * object only supplies the handset environment: device-protected storage,
 * TestStore credentials/journal, and ConnectionConfig's HTTPS-only
 * HttpURLConnection (the single place the enrolled Bearer credential is
 * attached to a request).
 */
object EvidenceUploader {
    private class AndroidJournal(private val context: Context) : EvidenceUploadCore.Journal {
        override fun record(type: String, fields: Map<String, Any?>) = TestStore.record(context, type, fields)
    }

    private class AndroidCredentials(private val context: Context) : EvidenceUploadCore.Credentials {
        override fun alertServerUrl(): String = TestStore.alertServerUrl(context)
        override fun enrolledDeviceToken(): String = TestStore.enrolledDeviceToken(context)
        override fun clearEnrolledDeviceToken() = TestStore.setEnrolledDeviceToken(context, "")
    }

    private class HttpConnection(private val connection: HttpURLConnection) : EvidenceUploadCore.Connection {
        override var requestMethod: String
            get() = connection.requestMethod
            set(value) { connection.requestMethod = value }
        override var doOutput: Boolean
            get() = connection.doOutput
            set(value) { connection.doOutput = value }
        override fun setRequestProperty(key: String, value: String) = connection.setRequestProperty(key, value)
        override fun setFixedLengthStreamingMode(contentLength: Long) =
            connection.setFixedLengthStreamingMode(contentLength)
        override val outputStream: OutputStream get() = connection.outputStream
        override val responseCode: Int get() = connection.responseCode
        override fun disconnect() = connection.disconnect()
    }

    private class AndroidEnv(private val context: Context) : EvidenceUploadCore.Env {
        override val journal = AndroidJournal(context)
        override val credentials = AndroidCredentials(context)

        override fun pendingDirectory(): File =
            File(context.createDeviceProtectedStorageContext().filesDir, "evidence-pending").also {
                if (!it.isDirectory && !it.mkdirs()) throw IOException("Cannot create evidence pending directory")
            }

        override fun openConnection(baseUrl: String, path: String): EvidenceUploadCore.Connection =
            HttpConnection(ConnectionConfig.open(context, baseUrl, path))
    }

    @Synchronized
    fun enqueue(context: Context, meta: EvidenceUploadCore.Meta, bytes: ByteArray): File =
        EvidenceUploadCore.enqueue(AndroidEnv(context), meta, bytes)

    @Synchronized
    fun uploadAll(context: Context) = EvidenceUploadCore.uploadAll(AndroidEnv(context))

    @Synchronized
    fun upload(context: Context, sidecar: File) = EvidenceUploadCore.upload(AndroidEnv(context), sidecar)
}
