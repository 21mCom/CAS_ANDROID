package com.covertalert.pixeltest

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.ConnectivityManager
import androidx.core.content.getSystemService
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Android plumbing for the one-tap self-update flow (the decisions live in
 * the android-free UpdateCheck core). Transport contract, same as
 * AlertSender: HTTPS-only (loopback dev endpoints excepted), redirects are
 * never followed, and the manifest's size + SHA-256 pin the download — a
 * mismatch deletes the file and aborts before PackageInstaller sees it.
 *
 * Auth: the manifest and download endpoints take the handset's enrolled
 * device credential. A 401 means it was revoked: drop the cached token,
 * never re-enroll from storage (same rule as the alert path), and updates
 * simply stop until the operator re-enrolls the phone.
 *
 * Install: PackageInstaller commit hands the verified file to the OS, which
 * shows the single system confirmation prompt (fully silent updates are
 * impossible without Play or device-owner mode; one tap is the floor) and
 * independently enforces the pinned signing key. The commit result comes
 * back through UpdateInstallReceiver.
 */
object UpdateManager {

    enum class CheckOutcome {
        UPDATE_AVAILABLE,
        UP_TO_DATE,
        NO_UPDATE_PUBLISHED,
        // No server URL or no enrolled credential: Gate 0A harness runs stay
        // local-only, so the check simply never happens.
        NOT_CONFIGURED,
        CREDENTIAL_REJECTED,
        FAILED,
    }

    data class CheckResult(
        val outcome: CheckOutcome,
        val detail: String,
        val manifest: UpdateCheck.Manifest? = null,
    )

    data class DownloadResult(
        val ok: Boolean,
        val detail: String,
        val file: File? = null,
    )

    /** True when a server URL and an enrolled credential both exist. */
    fun configured(context: Context): Boolean =
        TestStore.alertServerUrl(context).isNotBlank() &&
            TestStore.enrolledDeviceToken(context).isNotBlank()

    fun currentVersionCode(context: Context): Long {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return info.longVersionCode
    }

    /** Polls the update manifest. Never throws; call off the UI thread. */
    fun checkNow(context: Context, baseUrl: String): CheckResult {
        val trimmed = baseUrl.trim().trimEnd('/')
        if (!trimmed.startsWith("https://") && !isDevLoopback(trimmed)) {
            return CheckResult(CheckOutcome.FAILED, "Server URL must start with https:// (plain HTTP is only accepted for loopback dev endpoints)")
        }
        val token = TestStore.enrolledDeviceToken(context)
        if (token.isBlank()) {
            return CheckResult(CheckOutcome.NOT_CONFIGURED, "no enrolled device credential — update checks start after first enrollment")
        }
        return runCatching {
            val connection = open(trimmed, "/api/cas/app-updates/manifest", token)
            try {
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.bufferedReader()?.readText().orEmpty()
                when {
                    code in 200..299 -> {
                        val manifest = UpdateCheck.parseManifest(body)
                            ?: return CheckResult(CheckOutcome.FAILED, "HTTP $code but the manifest was malformed — refusing it")
                        val evaluation = UpdateCheck.evaluate(manifest, context.packageName, currentVersionCode(context))
                        when (evaluation.status) {
                            UpdateCheck.Status.UPDATE_AVAILABLE ->
                                CheckResult(CheckOutcome.UPDATE_AVAILABLE, evaluation.detail, manifest)
                            UpdateCheck.Status.UP_TO_DATE ->
                                CheckResult(CheckOutcome.UP_TO_DATE, evaluation.detail)
                            UpdateCheck.Status.REJECTED ->
                                CheckResult(CheckOutcome.FAILED, evaluation.detail)
                        }
                    }
                    code == 404 -> CheckResult(CheckOutcome.NO_UPDATE_PUBLISHED, "the server has no published build yet")
                    code == 401 -> {
                        // Revoked or unknown credential: same rule as the
                        // trigger path — drop the dead token, never re-enroll
                        // from storage.
                        TestStore.setEnrolledDeviceToken(context, "")
                        TestStore.record(context, "DEVICE_CREDENTIAL_REJECTED", mapOf("revokedOrUnknown" to true, "during" to "update-check"))
                        CheckResult(CheckOutcome.CREDENTIAL_REJECTED, "HTTP 401 credential revoked or unknown — re-enroll to resume update checks")
                    }
                    else -> CheckResult(CheckOutcome.FAILED, "HTTP $code ${body.take(200)}")
                }
            } finally {
                connection.disconnect()
            }
        }.getOrElse { CheckResult(CheckOutcome.FAILED, "Update check failed: ${it.message ?: it.javaClass.simpleName}") }
    }

    /**
     * True when the current network is metered (mobile data). Downloads wait
     * for explicit owner consent on a metered link — an update must never
     * silently burn the field phone's data plan.
     */
    fun isMetered(context: Context): Boolean {
        // Conservative: any failure to read the network state is treated as
        // metered, so the owner is asked rather than a download starting
        // silently on an unknown link.
        val manager = context.getSystemService<ConnectivityManager>() ?: return true
        return runCatching { manager.isActiveNetworkMetered }.getOrDefault(true)
    }

    /**
     * Downloads the pinned APK into the update cache and verifies it against
     * the manifest (size + SHA-256) before returning it. A failed pin deletes
     * the file — an unverified APK never reaches PackageInstaller. Call off
     * the UI thread.
     */
    fun download(context: Context, baseUrl: String, manifest: UpdateCheck.Manifest): DownloadResult {
        val trimmed = baseUrl.trim().trimEnd('/')
        if (!trimmed.startsWith("https://") && !isDevLoopback(trimmed)) {
            return DownloadResult(false, "Server URL must start with https://")
        }
        val token = TestStore.enrolledDeviceToken(context)
        if (token.isBlank()) {
            return DownloadResult(false, "no enrolled device credential — cannot download")
        }
        val dir = File(context.cacheDir, "updates").apply { mkdirs() }
        // Keyed by the pinned hash: a re-download of the same build reuses
        // the verified file, and a changed manifest can never collide with it.
        val target = File(dir, "cas-update-${manifest.sha256}.apk")
        if (target.isFile && UpdateCheck.verifyDownload(manifest, target) == null) {
            return DownloadResult(true, "already downloaded and verified (${manifest.sizeBytes} bytes)", target)
        }
        target.delete()
        val partial = File(dir, "cas-update-${manifest.sha256}.part")
        return runCatching {
            val connection = open(trimmed, manifest.downloadPath, token)
            try {
                val code = connection.responseCode
                if (code !in 200..299) {
                    val error = connection.errorStream?.bufferedReader()?.readText().orEmpty()
                    return DownloadResult(false, "HTTP $code ${error.take(200)}")
                }
                connection.inputStream.use { input ->
                    partial.outputStream().use { output -> input.copyTo(output) }
                }
                if (!partial.renameTo(target)) {
                    partial.delete()
                    return DownloadResult(false, "could not finalize the downloaded file")
                }
                val refusal = UpdateCheck.verifyDownload(manifest, target)
                if (refusal != null) {
                    target.delete()
                    return DownloadResult(false, refusal)
                }
                DownloadResult(true, "downloaded and verified ${manifest.sizeBytes} bytes, SHA-256 ${manifest.sha256.take(12)}…", target)
            } finally {
                connection.disconnect()
                partial.delete()
            }
        }.getOrElse {
            partial.delete()
            target.delete()
            DownloadResult(false, "Download failed: ${it.message ?: it.javaClass.simpleName}")
        }
    }

    /** False until the owner grants "install unknown apps" for this app. */
    fun canRequestInstalls(context: Context): Boolean =
        context.packageManager.canRequestPackageInstalls()

    /**
     * Hands the verified APK to PackageInstaller; the OS shows the single
     * confirmation prompt and enforces the pinned signing key. The outcome
     * arrives in UpdateInstallReceiver. Returns the immediate detail line.
     *
     * The status intent carries the APK path and the attempt number so the
     * receiver can retry the handoff itself when Android loses the known
     * post-permission-grant race (see UpdateCheck.isPostGrantVerificationRace)
     * instead of making the owner tap Download & install a second time.
     */
    fun install(context: Context, file: File, attempt: Int = 1): String {
        if (!canRequestInstalls(context)) {
            return "BLOCKED: Android has not allowed this app to install updates — in Settings → Apps → CAS Pixel Gate 0A enable 'Install unknown apps', then tap Download & install again"
        }
        return runCatching {
            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite("cas-update.apk", 0, file.length()).use { out ->
                    file.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val statusIntent = Intent(context, UpdateInstallReceiver::class.java)
                    .putExtra(UpdateInstallReceiver.EXTRA_APK_PATH, file.absolutePath)
                    .putExtra(UpdateInstallReceiver.EXTRA_ATTEMPT, attempt)
                // MUTABLE: PackageInstaller fills in the status extras.
                val pending = PendingIntent.getBroadcast(
                    context,
                    sessionId,
                    statusIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                session.commit(pending.intentSender)
            }
            UpdateCheck.INSTALL_HANDOFF_ACCEPTED
        }.getOrElse { "install handoff failed: ${it.message ?: it.javaClass.simpleName}" }
    }

    private fun open(baseUrl: String, path: String, token: String): HttpURLConnection =
        (URL("$baseUrl$path").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 30_000
            // Provider-delivery contract: never follow redirects — a redirect
            // can forward the credential or swap the payload origin.
            instanceFollowRedirects = false
            setRequestProperty("Authorization", "Bearer $token")
        }

    /**
     * Same loopback exception as AlertSender: plain HTTP only for endpoints
     * that cannot leave the local machine (adb reverse / emulator host alias).
     */
    private fun isDevLoopback(url: String): Boolean =
        url == "http://10.0.2.2" || url.startsWith("http://10.0.2.2:") ||
            url == "http://127.0.0.1" || url.startsWith("http://127.0.0.1:") ||
            url == "http://localhost" || url.startsWith("http://localhost:")
}
