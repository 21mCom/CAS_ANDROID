package com.covertalert.pixeltest

/**
 * JVM harness for the android-free SMS division core (SmsSegmenter.kt) and
 * the alert-server URL entry policy (ServerUrlPolicy.kt) — no Android
 * runtime.
 *
 * The segmentation proofs pin the exact limits the radio enforces: a body
 * is classified GSM-7 or Unicode, a single message carries 160 septets /
 * 70 UTF-16 units, and each concatenated segment carries 153 septets /
 * 67 units — with a GSM-7 escape pair and a Unicode surrogate pair never
 * split across segments. The divide() proofs pin the field fix: the app's
 * own segments go out even when the platform divider still throws (the
 * Pixel's divideMessage failure), the platform exception is still captured
 * for the SMS_DIVIDE_FALLBACK journal event, and a body goes out as ONE
 * part only when it genuinely fits a single segment.
 *
 * Run via scripts/test-sms-division.sh — do not ship in the APK.
 */

private var checks = 0

private fun check(condition: Boolean, label: String) {
    checks += 1
    if (!condition) throw AssertionError("FAILED: $label")
}

private fun gsm7SeptetCount(s: String): Int {
    // Independent re-count against the segmenter's own classification:
    // extension characters are exactly the ones classify() still accepts
    // but that cost 2 septets. Built from the spec tables, not from the
    // core under test.
    val basic = (
        "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./" +
            "0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿" +
            "abcdefghijklmnopqrstuvwxyzäöñüà"
        ).toSet()
    return s.fold(0) { acc, char -> acc + if (char in basic) 1 else 2 }
}

fun main() {
    // --- Classification ---------------------------------------------------
    check(SmsSegmenter.classify("CAS P1 alert inc-1. Begin response protocol.") == SmsSegmenter.Encoding.GSM7, "plain ASCII alert classifies GSM-7")
    // The real location clause carries '±' (U+00B1), which is NOT in the
    // GSM-7 table — so a fix-carrying alert body encodes as Unicode and the
    // 70/67-unit limits are the ones that matter in the field. Pinned here
    // so nobody "optimizes" the clause back under an assumed GSM-7 budget.
    check(SmsSegmenter.classify("Fix: https://maps.google.com/?q=48.1,11.5 (±30m, fix 12s old)") == SmsSegmenter.Encoding.UNICODE, "the ± in the location clause forces Unicode")
    check(SmsSegmenter.classify("https://maps.google.com/?q=48.1,11.5") == SmsSegmenter.Encoding.GSM7, "the bare maps link itself is pure GSM-7")
    check(SmsSegmenter.classify("café €5") == SmsSegmenter.Encoding.GSM7, "extension-table characters still classify GSM-7")
    check(SmsSegmenter.classify("status ✓") == SmsSegmenter.Encoding.UNICODE, "one off-table character forces Unicode")
    check(SmsSegmenter.classify("alarm 🚨") == SmsSegmenter.Encoding.UNICODE, "an emoji forces Unicode")

    // --- GSM-7 boundaries ---------------------------------------------------
    run {
        val at160 = "a".repeat(160)
        check(SmsSegmenter.plan(at160).segments == listOf(at160), "160 septets stay one segment")
        val at161 = SmsSegmenter.plan("a".repeat(161))
        check(at161.segments.size == 2, "161 septets become two segments")
        check(at161.segments.map { it.length } == listOf(153, 8), "concatenated segments hold 153 septets")
        val at306 = SmsSegmenter.plan("a".repeat(306))
        check(at306.segments.map { it.length } == listOf(153, 153), "306 septets fill exactly two segments")
        check(SmsSegmenter.plan("a".repeat(307)).segments.size == 3, "307 septets need three segments")
    }

    // --- GSM-7 escape pairs: 2 septets, never split -------------------------
    run {
        // 158 basic + one extension char = exactly 160 septets: still ONE segment.
        val fits = "a".repeat(158) + "€"
        check(SmsSegmenter.plan(fits).segments == listOf(fits), "158 basic + escape char (160 septets) stay one segment")
        // 159 basic + one extension char = 161 septets: must split, and the
        // escape pair must move to the next segment wholesale.
        val split = SmsSegmenter.plan("a".repeat(159) + "€")
        check(split.segments.size == 2, "161 septets with an escape char become two segments")
        check(split.segments[0] == "a".repeat(153), "first segment stops at 153 septets")
        check(split.segments[1] == "a".repeat(6) + "€", "the escape char travels intact into segment two")
        // Boundary stress: escape char landing exactly ON the seam — a naive
        // char-count split at 153 chars would leave its escape code orphaned.
        val seam = SmsSegmenter.plan("a".repeat(152) + "€" + "a".repeat(20))
        check(seam.segments[0] == "a".repeat(152), "the escape pair never starts at septet 153 of a segment")
        check(seam.segments[1] == "€" + "a".repeat(20), "the escape pair opens the next segment intact")
        check(seam.segments.joinToString("") == "a".repeat(152) + "€" + "a".repeat(20), "segments reassemble losslessly")
    }

    // --- Unicode boundaries ---------------------------------------------------
    run {
        val at70 = "中".repeat(70)
        check(SmsSegmenter.plan(at70).segments == listOf(at70), "70 UTF-16 units stay one segment")
        val at71 = SmsSegmenter.plan("中".repeat(71))
        check(at71.segments.size == 2 && at71.segments.map { it.length } == listOf(67, 4), "71 units split at 67")
        check(SmsSegmenter.plan("中".repeat(134)).segments.size == 2, "134 units fill exactly two segments")
        check(SmsSegmenter.plan("中".repeat(135)).segments.size == 3, "135 units need three segments")
    }

    // --- Unicode surrogate pairs never split ---------------------------------
    run {
        // 66 BMP units + one emoji (2 units) + 10 BMP units = 78 units.
        // A naive split at 67 would strand the emoji's high surrogate.
        val body = "中".repeat(66) + "🚨" + "中".repeat(10)
        val plan = SmsSegmenter.plan(body)
        check(plan.encoding == SmsSegmenter.Encoding.UNICODE, "emoji body classifies Unicode")
        check(plan.segments.size == 2, "78 units split into two segments")
        check(plan.segments[0] == "中".repeat(66), "segment one stops BEFORE the surrogate pair")
        check(plan.segments[1] == "🚨" + "中".repeat(10), "the surrogate pair opens segment two intact")
        check(plan.segments.joinToString("") == body, "unicode segments reassemble losslessly")
    }

    // --- Every segment of a long mixed body respects its encoding's limit ----
    run {
        val gsmBody = ("Begin response protocol. €100. ".repeat(30)).trim()
        val gsmPlan = SmsSegmenter.plan(gsmBody)
        check(gsmPlan.encoding == SmsSegmenter.Encoding.GSM7, "long GSM-7 body with escape chars stays GSM-7")
        check(gsmPlan.segments.size > 1, "long GSM-7 body actually concatenates")
        check(gsmPlan.segments.all { gsm7SeptetCount(it) <= SmsSegmenter.GSM7_CONCAT_LIMIT }, "every GSM-7 segment fits 153 septets")
        check(gsmPlan.segments.joinToString("") == gsmBody, "GSM-7 segments reassemble losslessly")

        val uniBody = ("移動してください 🚨 ".repeat(20)).trim()
        val uniPlan = SmsSegmenter.plan(uniBody)
        check(uniPlan.segments.size > 1, "long Unicode body actually concatenates")
        check(uniPlan.segments.all { it.length <= SmsSegmenter.UNICODE_CONCAT_LIMIT }, "every Unicode segment fits 67 units")
        check(uniPlan.segments.joinToString("") == uniBody, "Unicode segments reassemble losslessly")
    }

    // --- divide(): the field fix ---------------------------------------------
    run {
        // The Pixel path: platform divideMessage throws — the app's segments
        // still go out, and the exception text is captured for the journal.
        val broken = SmsSegmenter.divide("a".repeat(210)) { throw IllegalStateException("getGroupIdLevel1") }
        check(broken != null, "division succeeds even when the platform divider throws")
        check(broken!!.segments == SmsSegmenter.plan("a".repeat(210)).segments, "the app's segments go out when divideMessage is broken")
        check(broken.platformFailure == "getGroupIdLevel1", "the platform exception is captured for SMS_DIVIDE_FALLBACK")

        val noParts = SmsSegmenter.divide("a".repeat(210)) { emptyList() }
        check(noParts!!.platformFailure == "divideMessage returned no parts", "an empty platform result is also captured")

        // Platform works but disagrees: the app's plan still wins.
        val disagrees = SmsSegmenter.divide("a".repeat(210)) { listOf("WRONG-PART") }
        check(disagrees!!.platformFailure == null, "a working platform divider records no failure")
        check(disagrees.segments.size == 2 && disagrees.segments[0].length == 153, "the platform's parts are never used — the app's are")

        // The single-part fallback is kept ONLY for bodies that genuinely
        // fit one segment — and it is the body itself, verbatim.
        val short = "CAS P1 alert from this handset. Begin response protocol."
        val single = SmsSegmenter.divide(short) { error("even a throwing platform call is only diagnostic") }
        check(single!!.segments == listOf(short), "a short body goes out as exactly itself, one part")

        // Blank body: nothing to send — DIVIDE_FAILED for every responder.
        check(SmsSegmenter.divide("") { emptyList() } == null, "an empty body divides to nothing")
        check(SmsSegmenter.divide("   ") { emptyList() } == null, "a whitespace-only body divides to nothing")
    }

    // --- Server URL entry policy (the "Invalid host" wedge) -------------------
    run {
        check(ServerUrlPolicy.rejectionReason("https://cas.example.replit.app") == null, "a normal https URL is accepted")
        check(ServerUrlPolicy.rejectionReason("https://cas.example.replit.app/") == null, "a trailing slash is accepted")
        check(ServerUrlPolicy.rejectionReason("") == null, "blank stays accepted (clears the setting)")
        check(ServerUrlPolicy.rejectionReason("  https://cas.example.replit.app  ") == null, "outer whitespace trims away")

        // The exact field failure: a trailing paste fragment.
        val wedged = ServerUrlPolicy.rejectionReason("https://cas.example.replit.app no")
        check(wedged != null && wedged.contains("spaces"), "a trailing paste fragment is rejected on whitespace")
        check(ServerUrlPolicy.rejectionReason("https://cas.exam ple.app") != null, "internal whitespace is rejected")
        check(ServerUrlPolicy.rejectionReason("https://cas.example.replit.app\nno") != null, "an embedded line break is rejected")

        check(ServerUrlPolicy.rejectionReason("not a url") != null, "free text is rejected")
        check(ServerUrlPolicy.rejectionReason("example.com") != null, "a scheme-less host is rejected")
        check(ServerUrlPolicy.rejectionReason("https://") != null, "a hostless URL is rejected")
        check(ServerUrlPolicy.rejectionReason("https://:8080") != null, "an empty host is rejected")

        val plain = ServerUrlPolicy.rejectionReason("http://cas.example.com")
        check(plain != null && plain.contains("https://"), "plain HTTP to a real host keeps the https rule")
        check(ServerUrlPolicy.rejectionReason("http://127.0.0.1:5055") == null, "adb-reverse loopback HTTP stays accepted")
        check(ServerUrlPolicy.rejectionReason("http://10.0.2.2:5055") == null, "emulator host-alias HTTP stays accepted")
        check(ServerUrlPolicy.rejectionReason("http://localhost:5055") == null, "localhost HTTP stays accepted")
        check(ServerUrlPolicy.rejectionReason("http://192.168.1.10:5055") != null, "a LAN address is NOT loopback and stays rejected")
    }

    println("SMS_DIVISION_OK checks=$checks")
}
