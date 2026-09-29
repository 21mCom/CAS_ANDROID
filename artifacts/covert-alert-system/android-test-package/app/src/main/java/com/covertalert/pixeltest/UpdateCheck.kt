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
