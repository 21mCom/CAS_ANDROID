package com.covertalert.pixeltest

/**
 * Android-free SMS segmentation core. The app — not the platform — owns
 * dividing an alert body into valid SMS segments, because
 * SmsManager.divideMessage is NOT reliable on every handset/Android build
 * (field-observed on a Pixel running Android 17 / API 37: it throws for
 * every recipient). The old stopgap of sending the whole body as ONE part
 * dies on the radio with RESULT_ERROR_GENERIC_FAILURE once the body outgrew
 * a single segment (~210 chars with the location clause), so this core
 * replaces the platform divider for deciding what goes out over the air.
 *
 * Segmentation follows 3GPP TS 23.038 / 23.040: a body is classified as
 * GSM-7 (every character in the basic or extension table) or Unicode, then
 * split to the single-message limit (160 septets / 70 UTF-16 units) or, for
 * concatenated messages, the per-segment limit (153 septets / 67 units) —
 * the missing 7 septets / 3 units are the concatenation header the radio
 * fills in. A GSM-7 extension character costs TWO septets (escape + code)
 * and the pair is never split across segments; a Unicode surrogate pair is
 * likewise never split. Multi-part headers themselves stay the radio's job
 * (sendMultipartTextMessage); this core only guarantees every part fits.
 *
 * Everything here is plain JVM so the boundary lengths, escape handling,
 * and the divideMessage-still-broken path are provable without a device via
 * scripts/test-sms-division.sh.
 */
object SmsSegmenter {

    enum class Encoding { GSM7, UNICODE }

    /** How one alert body goes out: the exact parts handed to the radio. */
    class Plan(
        val encoding: Encoding,
        /** Never empty for a non-empty body. */
        val segments: List<String>,
    )

    /**
     * The send-time division decision: [segments] is ALWAYS the app-owned
     * plan's output — the platform divider's parts are never used.
     * [platformFailure] is diagnostic context only: why the platform's
     * divideMessage failed (exception text, or a no-parts note), null when
     * it worked. DeviceSmsSender journals it as SMS_DIVIDE_FALLBACK so
     * field reports keep showing whether the platform bug is still live.
     */
    class Division(
        val segments: List<String>,
        val encoding: Encoding,
        val platformFailure: String?,
    )

    // Septet limits: a standalone message carries 160 GSM-7 septets; each
    // segment of a concatenated message carries 153 (7 septets of user-data
    // header). Unicode carries 70 / 67 UTF-16 code units (6 bytes of UDH).
    const val GSM7_SINGLE_LIMIT = 160
    const val GSM7_CONCAT_LIMIT = 153
    const val UNICODE_SINGLE_LIMIT = 70
    const val UNICODE_CONCAT_LIMIT = 67

    // GSM-7 basic character table (TS 23.038): each of these is one septet.
    private val GSM7_BASIC: Set<Char> = (
        "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./" +
            "0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿" +
            "abcdefghijklmnopqrstuvwxyzäöñüà"
        ).toSet()

    // GSM-7 extension table: each of these is TWO septets (escape + code)
    // and the pair must stay inside one segment.
    private val GSM7_EXTENDED: Set<Char> = "^{}\\[~]|€".toSet()

    /** GSM-7 when every character fits the basic or extension table, else Unicode. */
    fun classify(body: String): Encoding =
        if (body.all { it in GSM7_BASIC || it in GSM7_EXTENDED }) Encoding.GSM7 else Encoding.UNICODE

    /** Septet cost of one GSM-7 character (extension characters cost 2). */
    private fun gsm7Septets(char: Char): Int = if (char in GSM7_EXTENDED) 2 else 1

    private fun gsm7Septets(body: String): Int = body.sumOf { gsm7Septets(it) }

    /**
     * Splits [body] into radio-ready segments. An empty body yields no
     * segments (the caller treats blank bodies as DIVIDE_FAILED before ever
     * calling this). A body that fits a single segment is returned as
     * exactly itself — the single-part path — never re-wrapped.
     */
    fun plan(body: String): Plan {
        val encoding = classify(body)
        if (body.isEmpty()) return Plan(encoding, emptyList())
        return when (encoding) {
            Encoding.GSM7 ->
                if (gsm7Septets(body) <= GSM7_SINGLE_LIMIT) Plan(encoding, listOf(body))
                else Plan(encoding, splitGsm7(body))
            Encoding.UNICODE ->
                if (body.length <= UNICODE_SINGLE_LIMIT) Plan(encoding, listOf(body))
                else Plan(encoding, splitUnicode(body))
        }
    }

    private fun splitGsm7(body: String): List<String> {
        val segments = mutableListOf<String>()
        val current = StringBuilder()
        var currentSeptets = 0
        for (char in body) {
            val cost = gsm7Septets(char)
            // An extension character that would straddle the boundary moves
            // wholesale to the next segment — its escape pair never splits.
            if (currentSeptets + cost > GSM7_CONCAT_LIMIT) {
                segments.add(current.toString())
                current.clear()
                currentSeptets = 0
            }
            current.append(char)
            currentSeptets += cost
        }
        if (current.isNotEmpty()) segments.add(current.toString())
        return segments
    }

    private fun splitUnicode(body: String): List<String> {
        val segments = mutableListOf<String>()
        var start = 0
        var index = 0
        var currentUnits = 0
        while (index < body.length) {
            // A surrogate pair is one unit for splitting purposes: it must
            // never be divided across segments.
            val unitLength =
                if (body[index].isHighSurrogate() && index + 1 < body.length && body[index + 1].isLowSurrogate()) 2 else 1
            if (currentUnits + unitLength > UNICODE_CONCAT_LIMIT) {
                segments.add(body.substring(start, index))
                start = index
                currentUnits = 0
            }
            currentUnits += unitLength
            index += unitLength
        }
        if (start < body.length) segments.add(body.substring(start))
        return segments
    }

    /**
     * The division decision sendAlert relies on. Returns null only for a
     * blank body (DIVIDE_FAILED for every responder — an empty alert must
     * never dispatch). Otherwise the app-owned [plan] is authoritative and
     * [platformDivide] is invoked ONLY to capture diagnostic context: its
     * failure (throw or empty result) is reported via Division.platformFailure
     * for the SMS_DIVIDE_FALLBACK journal event, and its parts are ignored.
     */
    fun divide(body: String, platformDivide: (String) -> List<String>): Division? {
        if (body.isBlank()) return null
        val platformFailure = runCatching { platformDivide(body) }.fold(
            onSuccess = { parts -> if (parts.isEmpty()) "divideMessage returned no parts" else null },
            onFailure = { it.message ?: it.javaClass.simpleName },
        )
        val plan = plan(body)
        return Division(plan.segments, plan.encoding, platformFailure)
    }
}
