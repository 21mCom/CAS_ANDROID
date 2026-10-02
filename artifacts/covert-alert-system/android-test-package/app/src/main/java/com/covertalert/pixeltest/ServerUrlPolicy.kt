package com.covertalert.pixeltest

import java.net.URI

/**
 * Android-free entry-time validation for the kit's alert server URL.
 *
 * The field wedge this prevents: a pasted URL carrying trailing junk (seen
 * on the Pixel: the stored URL ended in " no" — a paste artifact) saved
 * cleanly, then every update check and trigger died inside Android's
 * networking with an "Invalid host" MalformedURLException, with nothing on
 * the save path rejecting it. Rejecting at entry keeps an unparseable or
 * whitespace-carrying URL from ever reaching the network paths.
 *
 * Plain JVM (java.net.URI only) so the rules are provable without a device
 * via scripts/test-sms-division.sh.
 */
object ServerUrlPolicy {

    // Same loopback exception AlertSender/UpdateManager apply at use time:
    // plain HTTP only for endpoints that cannot leave the local machine
    // (127.0.0.1 via adb reverse, the emulator's 10.0.2.2 host alias).
    private val LOOPBACK_HOSTS = setOf("127.0.0.1", "10.0.2.2", "localhost")

    /**
     * Returns null when [rawValue] is acceptable to store, else a
     * human-readable rejection reason for inline display. A blank value
     * stays acceptable: it clears the setting (the handset then works
     * offline, as before).
     */
    fun rejectionReason(rawValue: String): String? {
        val value = rawValue.trim()
        if (value.isEmpty()) return null
        // Whitespace ANYWHERE (internal or, after trim, embedded) can never
        // be a valid URL — this is the paste-artifact case from the field.
        if (value.any { it.isWhitespace() }) {
            return "Server URL must not contain spaces or line breaks — re-paste it (a stray paste fragment wedges update checks with 'Invalid host')"
        }
        val uri = runCatching { URI(value) }.getOrNull()
        if (uri == null || uri.scheme.isNullOrBlank() || uri.host.isNullOrBlank()) {
            return "Server URL is not parseable — expected e.g. https://your-replit-app.replit.app"
        }
        if (uri.scheme != "https" && !(uri.scheme == "http" && uri.host in LOOPBACK_HOSTS)) {
            return "Server URL must start with https:// (plain HTTP is only accepted for loopback dev endpoints: 127.0.0.1 via adb reverse, or the emulator's 10.0.2.2 host alias)"
        }
        return null
    }
}
