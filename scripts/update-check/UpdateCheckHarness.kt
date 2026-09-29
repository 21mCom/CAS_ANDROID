package com.covertalert.pixeltest

import java.io.File
import java.security.MessageDigest

/**
 * JVM harness for the android-free update-check core (UpdateCheck.kt).
 * The rules proven here are the self-update channel's safety pins: a
 * malformed or foreign-package manifest is refused, "newer" is decided
 * strictly by versionCode, and a downloaded APK that does not match the
 * manifest's size + SHA-256 pin must never reach the installer.
 *
 * Run via scripts/test-update-check.sh.
 */
private var checks = 0

private fun check(condition: Boolean, label: String) {
    checks += 1
    if (!condition) throw AssertionError("FAILED: $label")
}

private fun manifestJson(
    packageName: String = "com.covertalert.pixeltest",
    versionCode: Long = 7,
    versionName: String = "0.8.0-selfupdate",
    sha256: String = "a".repeat(64),
    sizeBytes: Long = 1234567,
    downloadPath: String = "/api/cas/app-updates/latest.apk",
): String = """
    {
      "packageName": "$packageName",
      "versionCode": $versionCode,
      "versionName": "$versionName",
      "sha256": "$sha256",
      "sizeBytes": $sizeBytes,
      "downloadPath": "$downloadPath",
      "publishedAt": "2026-09-29T00:00:00.000Z"
    }
""".trimIndent()

private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

fun main() {
    // --- parseManifest: strict or nothing ---------------------------------
    val good = UpdateCheck.parseManifest(manifestJson())
    check(good != null, "a well-formed manifest parses")
    check(good!!.versionCode == 7L && good.versionName == "0.8.0-selfupdate", "fields survive the parse")
    check(good.sizeBytes == 1234567L && good.downloadPath == "/api/cas/app-updates/latest.apk", "pin fields survive the parse")

    check(UpdateCheck.parseManifest("not json") == null, "non-JSON is refused")
    check(UpdateCheck.parseManifest("{}") == null, "empty object is refused")
    check(UpdateCheck.parseManifest("""{"packageName":"com.covertalert.pixeltest"}""") == null, "partial manifest is refused")
    check(UpdateCheck.parseManifest(manifestJson(sha256 = "abc")) == null, "a non-SHA-256 pin is refused")
    check(UpdateCheck.parseManifest(manifestJson(sha256 = "A".repeat(64))) != null, "uppercase hex pins normalize")
    check(UpdateCheck.parseManifest(manifestJson(versionCode = 0)) == null, "versionCode 0 is refused")
    check(UpdateCheck.parseManifest(manifestJson(sizeBytes = 0)) == null, "sizeBytes 0 is refused")
    check(
        UpdateCheck.parseManifest(manifestJson(downloadPath = "https://evil.example/x.apk")) == null,
        "an absolute download URL is refused — downloads stay on the configured server",
    )
    check(
        UpdateCheck.parseManifest(manifestJson(downloadPath = "//evil.example/x.apk")) == null,
        "a scheme-relative download path is refused",
    )
    check(
        UpdateCheck.parseManifest(manifestJson().replace("\"versionCode\": 7", "\"versionCode\": \"7\"")) == null,
        "a stringly versionCode is refused (strict types, no coercion)",
    )

    // --- evaluate: newer-wins is the only trigger --------------------------
    val m7 = good
    check(
        UpdateCheck.evaluate(m7, "com.covertalert.pixeltest", 6).status == UpdateCheck.Status.UPDATE_AVAILABLE,
        "published 7 over running 6 offers the update",
    )
    check(
        UpdateCheck.evaluate(m7, "com.covertalert.pixeltest", 7).status == UpdateCheck.Status.UP_TO_DATE,
        "same build is up to date",
    )
    check(
        UpdateCheck.evaluate(m7, "com.covertalert.pixeltest", 8).status == UpdateCheck.Status.UP_TO_DATE,
        "a newer running build never downgrades",
    )
    val mismatch = UpdateCheck.evaluate(m7, "com.example.other", 6)
    check(mismatch.status == UpdateCheck.Status.REJECTED, "a manifest for another package is refused")

    // --- verifyDownload: the byte-for-byte pin ------------------------------
    val dir = File(System.getProperty("java.io.tmpdir"), "update-check-harness")
    dir.deleteRecursively()
    dir.mkdirs()
    try {
        val payload = "fake apk bytes for the pin test".toByteArray()
        val pinned = UpdateCheck.Manifest(
            packageName = "com.covertalert.pixeltest",
            versionCode = 7,
            versionName = "0.8.0-selfupdate",
            sha256 = sha256Hex(payload),
            sizeBytes = payload.size.toLong(),
            downloadPath = "/api/cas/app-updates/latest.apk",
        )
        val ok = File(dir, "ok.apk").apply { writeBytes(payload) }
        check(UpdateCheck.verifyDownload(pinned, ok) == null, "a byte-exact download verifies")

        val truncated = File(dir, "truncated.apk").apply { writeBytes(payload.copyOf(payload.size - 3)) }
        val sizeRefusal = UpdateCheck.verifyDownload(pinned, truncated)
        check(sizeRefusal != null && sizeRefusal.contains("size mismatch"), "a truncated download is refused on size")

        val swapped = File(dir, "swapped.apk").apply { writeBytes("same-length but different payload!!".toByteArray().copyOf(payload.size)) }
        val hashRefusal = UpdateCheck.verifyDownload(pinned, swapped)
        check(hashRefusal != null && hashRefusal.contains("SHA-256 mismatch"), "a same-length swapped download is refused on hash")

        check(UpdateCheck.verifyDownload(pinned, File(dir, "missing.apk")) != null, "a missing file is refused")
    } finally {
        dir.deleteRecursively()
    }

    println("UPDATE_CHECK_OK checks=$checks")
}
