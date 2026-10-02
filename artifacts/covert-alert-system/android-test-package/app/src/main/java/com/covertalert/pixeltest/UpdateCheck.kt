package com.covertalert.pixeltest

import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * Android-free decision core for the one-tap self-update flow: parse the
 * server's update manifest strictly, decide whether the running build is
 * older, and verify a downloaded APK byte-for-byte against the manifest pin
 * (size + SHA-256) BEFORE any install handoff. Everything here is plain JVM
 * (org.json + java.io) so the rules are provable without a device via
 * scripts/test-update-check.sh; the android plumbing (HttpURLConnection,
 * PackageInstaller) lives in UpdateManager.
 *
 * The pin is the contract: the server computes the hash from the bytes at
 * publish time, and a mismatch — any truncation, corruption, or swapped
 * file — aborts the flow. Android then independently rejects a cross-key
 * update at install time (the pinned signing key is the second fence).
 */
object UpdateCheck {

    data class Manifest(
        val packageName: String,
        val versionCode: Long,
        val versionName: String,
        val sha256: String,
        val sizeBytes: Long,
        val downloadPath: String,
    )

    enum class Status {
        // The published build is newer — offer the one-tap update.
        UPDATE_AVAILABLE,
        // Running build matches or exceeds the published one.
        UP_TO_DATE,
        // The manifest is malformed or for a different package: refuse it.
        // A silently accepted wrong-package or partial manifest could turn
        // into an install prompt for the wrong binary.
        REJECTED,
    }

    data class Evaluation(
        val status: Status,
        val detail: String,
        val manifest: Manifest? = null,
    )

    private val SHA256_HEX = Regex("^[0-9a-f]{64}$")

    /**
     * Strict manifest parse: every field required and well-formed, or null.
     * downloadPath must be a server-relative path ("/api/..."), never an
     * absolute URL — the handset resolves it against its own configured
     * HTTPS server, so a manifest cannot redirect the download to another
     * origin.
     */
    fun parseManifest(text: String): Manifest? {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return null
        val packageName = json.optString("packageName").orEmpty()
        val versionName = json.optString("versionName").orEmpty()
        val sha256 = json.optString("sha256").orEmpty().lowercase()
        val downloadPath = json.optString("downloadPath").orEmpty()
        if (packageName.isBlank() || versionName.isBlank()) return null
        if (!SHA256_HEX.matches(sha256)) return null
        if (!downloadPath.startsWith("/") || downloadPath.startsWith("//")) return null
        // Strict numeric fields: org.json's getLong coerces strings, so
        // inspect the raw values — a stringly or fractional versionCode/size
        // is a malformed manifest, not a number to coerce.
        val rawCode = json.opt("versionCode")
        val rawSize = json.opt("sizeBytes")
        if (rawCode !is Number || rawSize !is Number) return null
        if (rawCode.toDouble() != rawCode.toLong().toDouble() || rawSize.toDouble() != rawSize.toLong().toDouble()) return null
        val versionCode = rawCode.toLong()
        val sizeBytes = rawSize.toLong()
        if (versionCode < 1 || sizeBytes < 1) return null
        return Manifest(packageName, versionCode, versionName, sha256, sizeBytes, downloadPath)
    }

    /** Decides whether the published manifest is an update for this build. */
    fun evaluate(manifest: Manifest, currentPackageName: String, currentVersionCode: Long): Evaluation {
        if (manifest.packageName != currentPackageName) {
            return Evaluation(
                Status.REJECTED,
                "manifest is for package ${manifest.packageName}, not $currentPackageName — refusing",
            )
        }
        if (manifest.versionCode <= currentVersionCode) {
            return Evaluation(Status.UP_TO_DATE, "published build ${manifest.versionCode} is not newer than this build $currentVersionCode")
        }
        return Evaluation(
            Status.UPDATE_AVAILABLE,
            "update available: ${manifest.versionName} (build ${manifest.versionCode})",
            manifest,
        )
    }

    /**
     * The known post-permission-grant race: right after the owner grants
     * "Install unknown apps", the AppOps change has not propagated to the
     * package manager's verification path yet, so the first session commit
     * comes back refused with "Install not allowed for file:…" even though
     * the grant is in place. The identical handoff succeeds once the grant
     * settles — the first physical-Pixel field journal proved exactly that
     * (FAILED-then-clean-manual-retry).
     *
     * Only that exact refusal text marks the race. The surrounding status
     * code (INSTALL_FAILED_VERIFICATION_FAILURE) is a GENERAL verification
     * failure and also covers genuine verifier rejections, which must stay
     * terminal — retrying those would re-prompt the owner for an install
     * that can never pass.
     */
    fun isPostGrantVerificationRace(statusMessage: String): Boolean =
        statusMessage.contains("Install not allowed for file:")

    /** Total handoff attempts (first try + automatic retries) for the race. */
    const val INSTALL_MAX_ATTEMPTS = 3

    /**
     * Settle delay before an automatic retry, giving the AppOps grant time
     * to reach the verifier. The field journal showed a manual retry
     * seconds later succeeding; 1.5s covers the propagation window without
     * making the owner wait.
     */
    const val INSTALL_RETRY_DELAY_MS = 1_500L

    /** Detail line UpdateManager.install returns when a session was committed. */
    const val INSTALL_HANDOFF_ACCEPTED =
        "handed to the system installer — confirm the Android prompt to finish the update"

    /** True only while the race is retryable: right message AND attempts left. */
    fun shouldRetryInstall(statusMessage: String, attempt: Int): Boolean =
        isPostGrantVerificationRace(statusMessage) && attempt < INSTALL_MAX_ATTEMPTS

    /** True when an install() detail line means a session was actually committed. */
    fun isHandoffAccepted(detail: String): Boolean =
        detail == INSTALL_HANDOFF_ACCEPTED

    /** Streaming SHA-256 of a downloaded file as lowercase hex. */
    fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * One journaled UPDATE_DOWNLOAD beat, reduced to the fields the
     * metered-consent contract checks. Consent beats carry [consent]
     * (SHOWN / ACCEPTED / DECLINED) and no [outcome]; download-result beats
     * carry [outcome] (VERIFIED / FAILED) and no [consent]. [metered] is
     * null only on beats written by builds that predate consent journaling.
     */
    data class DownloadJournalEvent(
        val consent: String? = null,
        val outcome: String? = null,
        val metered: Boolean? = null,
    )

    /**
     * The metered-consent journal contract, as a sequence check over the
     * UPDATE_DOWNLOAD beats of a field journal: every download result over a
     * metered link must be preceded by a SHOWN prompt and an ACCEPTED
     * decision, and one consent covers exactly one download attempt — a
     * second metered download needs its own prompt. Returns the list of
     * violations (empty = the journal proves consent by itself). MainActivity
     * writes these beats; the proof pack's CaptureJournal step and the JVM
     * harness (scripts/test-update-check.sh) both pin this rule.
     */
    fun consentViolations(events: List<DownloadJournalEvent>): List<String> {
        val violations = mutableListOf<String>()
        var promptShown = false
        var accepted = false
        events.forEachIndexed { index, event ->
            val beat = "beat ${index + 1}"
            when (event.consent) {
                "SHOWN" -> {
                    promptShown = true
                    accepted = false
                }
                "ACCEPTED" -> {
                    if (!promptShown) {
                        violations += "$beat: consent ACCEPTED without a preceding SHOWN prompt"
                    } else {
                        // Only a prompt the owner actually saw can legitimize
                        // the download — a lone ACCEPTED must not.
                        accepted = true
                    }
                }
                "DECLINED" -> {
                    if (!promptShown) violations += "$beat: consent DECLINED without a preceding SHOWN prompt"
                    promptShown = false
                    accepted = false
                }
            }
            if (event.outcome != null) {
                when {
                    event.metered == null ->
                        violations += "$beat: UPDATE_DOWNLOAD ${event.outcome} carries no metered marker — the build predates consent journaling, so the proof cannot verify itself"
                    event.metered && !accepted ->
                        violations += "$beat: metered download (${event.outcome}) without a preceding SHOWN + ACCEPTED consent"
                }
                // Consent is per-attempt: any download result consumes it.
                promptShown = false
                accepted = false
            }
        }
        return violations
    }

    /**
     * The hard pin: the downloaded file must match the manifest's size AND
     * hash, or it is deleted by the caller and never reaches the installer.
     * Returns null when the file verifies, else the refusal reason.
     */
    fun verifyDownload(manifest: Manifest, file: File): String? {
        if (!file.isFile) return "download did not produce a file"
        val actualSize = file.length()
        if (actualSize != manifest.sizeBytes) {
            return "size mismatch: manifest pins ${manifest.sizeBytes} bytes, download has $actualSize"
        }
        val actualHash = sha256Hex(file)
        if (!actualHash.equals(manifest.sha256, ignoreCase = true)) {
            return "SHA-256 mismatch: manifest pins ${manifest.sha256}, download hashed to $actualHash — refusing to install"
        }
        return null
    }
}
