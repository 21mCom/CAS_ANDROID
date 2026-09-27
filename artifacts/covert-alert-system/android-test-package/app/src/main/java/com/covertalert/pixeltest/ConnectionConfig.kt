package com.covertalert.pixeltest

import android.content.Context
import java.net.HttpURLConnection
import java.net.URL

/** Evidence traffic follows the alert sender's HTTPS-only rule; HTTP is
 * limited to the non-routable USB reverse / emulator host loopback aliases. */
object ConnectionConfig {
    fun base(url: String): String {
        val trimmed = url.trim().trimEnd('/')
        val parsed = URL(trimmed)
        val loopback = parsed.protocol == "http" &&
            parsed.host in setOf("127.0.0.1", "10.0.2.2", "localhost") &&
            parsed.userInfo == null
        require(parsed.protocol == "https" || loopback) { "Evidence server requires HTTPS (except loopback development)" }
        require(parsed.userInfo == null && parsed.query == null && parsed.ref == null) { "Invalid evidence server URL" }
        return trimmed
    }

    /**
     * Evidence traffic carries only this handset's enrolled credential as
     * Bearer. The evidence endpoints accept nothing else, so once the
     * credential is revoked every subsequent evidence request fails closed
     * — the shared device token is never offered as a fallback.
     */
    fun open(context: Context, baseUrl: String, path: String): HttpURLConnection =
        (URL("${base(baseUrl)}$path").openConnection() as HttpURLConnection).apply {
            connectTimeout = 10_000
            readTimeout = 10_000
            TestStore.enrolledDeviceToken(context).takeIf { it.isNotBlank() }
                ?.let { setRequestProperty("Authorization", "Bearer $it") }
        }
}