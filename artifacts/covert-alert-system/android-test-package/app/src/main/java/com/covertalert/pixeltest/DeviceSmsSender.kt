package com.covertalert.pixeltest

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.telephony.SmsManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Device-direct SMS delivery: the handset itself texts responders over its own
 * SIM, then reports the outcome to the console's sms-receipt endpoint so the
 * incident's SMS outbox item leaves QUEUED. There is deliberately no
 * third-party gateway — this path still works when the phone has SMS-capable
 * signal but no data connection (the receipt then arrives late or not at all,
 * and the console honestly keeps the item QUEUED with its stuck-pipeline
 * warning).
 *
 * Each message part carries a sent-result broadcast (SmsResultReceiver); a
 * recipient is delivered only when every part reports RESULT_OK. A watchdog
 * finalizes batches whose radio results never arrive so the console is not
 * left waiting on a silent radio.
 */
object DeviceSmsSender {
    const val ACTION_SMS_SENT = "com.covertalert.pixeltest.action.SMS_SENT"
    const val EXTRA_SEND_ID = "sendId"
    const val EXTRA_RECIPIENT = "recipient"

    private const val RESULT_WATCHDOG_MS = 45_000L

    private class Batch(val sendId: String, val incidentId: String?) {
        /** Parts still awaiting a radio result, per recipient. */
        val remainingByRecipient = mutableMapOf<String, Int>()
        /** First failure per recipient; absence means delivered. */
        val failures = mutableMapOf<String, String>()
    }

    private val lock = Any()
    private val batches = mutableMapOf<String, Batch>()
    private val handler = Handler(Looper.getMainLooper())

    /** Alert text mirrors the console's buildCasAlertMessage wording. */
    fun alertBody(incidentId: String?): String {
        val timestamp = java.time.Instant.now().toString().replace("T", " ").take(16)
        return if (incidentId != null) {
            "CAS P1 alert $incidentId at ${timestamp}Z. Begin response protocol. Do not call handset. Location follows."
        } else {
            "CAS P1 alert from this handset at ${timestamp}Z (console unreachable; no incident logged). Begin response protocol."
        }
    }

    /**
     * Sends the alert SMS to every configured responder. Returns a short
     * human-readable start outcome for the journal; per-recipient delivery
     * results land in SMS_PART_RESULT / SMS_SEND_OUTCOME events.
     */
    fun sendAlert(context: Context, incidentId: String?, body: String): String {
        val responders = TestStore.smsResponders(context)
        if (responders.isEmpty()) return "no responder numbers configured"
        if (context.checkSelfPermission(android.Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            return "SEND_SMS permission not granted"
        }
        val sms = context.getSystemService(SmsManager::class.java)
            ?: return "SmsManager unavailable"
        val appContext = context.applicationContext
        val sendId = incidentId ?: "offline-${System.currentTimeMillis()}"

        val batch = Batch(sendId, incidentId)
        synchronized(lock) { batches[sendId] = batch }
        handler.postDelayed({ onWatchdog(appContext, sendId) }, RESULT_WATCHDOG_MS)

        for (recipient in responders) {
            val parts = runCatching { sms.divideMessage(body) }.getOrElse {
                recordImmediateFailure(batch, recipient, "DIVIDE_FAILED")
                continue
            }
            synchronized(lock) { batch.remainingByRecipient[recipient] = parts.size }
            val sentIntents = ArrayList<PendingIntent>(parts.size)
            for (index in parts.indices) {
                val intent = Intent(ACTION_SMS_SENT)
                    .setClass(context, SmsResultReceiver::class.java)
                    .putExtra(EXTRA_SEND_ID, sendId)
                    .putExtra(EXTRA_RECIPIENT, recipient)
                sentIntents.add(
                    PendingIntent.getBroadcast(
                        context,
                        (sendId + recipient + index).hashCode(),
                        intent,
                        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                    )
                )
            }
            try {
                sms.sendMultipartTextMessage(recipient, null, parts, sentIntents, null)
            } catch (error: IllegalArgumentException) {
                recordImmediateFailure(batch, recipient, "ILLEGAL_DESTINATION_ADDRESS")
            } catch (error: SecurityException) {
                recordImmediateFailure(batch, recipient, "PERMISSION_DENIED")
            }
        }

        TestStore.record(context, "SMS_SEND_START", mapOf(
            "sendId" to sendId,
            "incidentId" to (incidentId ?: JSONObject.NULL),
            "responders" to synchronized(lock) { batch.remainingByRecipient.size },
        ))
        finalizeIfComplete(appContext, sendId)
        return "sent to ${responders.size} responder(s); awaiting radio results"
    }

    /** Entry point for SmsResultReceiver; runs on the main thread. */
    fun onSendResult(context: Context, sendId: String, recipient: String, resultCode: Int) {
        val error = if (resultCode == Activity.RESULT_OK) null else errorName(resultCode)
        synchronized(lock) {
            val batch = batches[sendId] ?: return
            val remaining = (batch.remainingByRecipient[recipient] ?: 0) - 1
            batch.remainingByRecipient[recipient] = remaining.coerceAtLeast(0)
            if (error != null) batch.failures.putIfAbsent(recipient, error)
        }
        TestStore.record(context, "SMS_PART_RESULT", mapOf(
            "sendId" to sendId,
            "recipient" to mask(recipient),
            "result" to (error ?: "OK"),
        ))
        finalizeIfComplete(context.applicationContext, sendId)
    }

    /**
     * Picks up SMS deliveries an operator re-queued in the console and
     * re-sends them from the SIM. Runs on a background thread; journals the
     * outcome. WHATSAPP items on the same list are WhatsAppAlerter's job.
     */
    fun sendRequeued(context: Context): String {
        val items = fetchPendingItems(context)
            ?: return "device-pending check failed (see REQUEUE_CHECK_OUTCOME)"
        var pickedUp = 0
        for ((incidentId, transport) in items) {
            if (transport != "SMS") continue
            pickedUp += 1
            sendAlert(context, incidentId, alertBody(incidentId))
        }
        TestStore.record(context, "REQUEUE_CHECK_OUTCOME", mapOf("outcome" to "OK", "pickedUp" to pickedUp, "listed" to items.size))
        return "picked up $pickedUp re-queued SMS deliver${if (pickedUp == 1) "y" else "ies"}"
    }

    /**
     * Fetches the handset's pending device-delivered items as
     * (incidentId, transport) pairs from the console's device-pending list.
     * Returns null on any failure after journaling the reason. Items without
     * a transport field (older consoles) are treated as SMS.
     */
    fun fetchPendingItems(context: Context): List<Pair<String, String>>? {
        val baseUrl = TestStore.alertServerUrl(context)
        if (baseUrl.isBlank()) {
            TestStore.record(context, "REQUEUE_CHECK_OUTCOME", mapOf("outcome" to "SKIPPED", "reason" to "no alert server URL configured"))
            return null
        }
        val token = TestStore.deviceToken(context)
        if (token.isBlank()) {
            TestStore.record(context, "REQUEUE_CHECK_OUTCOME", mapOf("outcome" to "FAILED", "reason" to "no device access token configured; the console refuses pickup without it"))
            return null
        }
        val trimmed = baseUrl.trim().trimEnd('/')
        val body = runCatching {
            val connection = (URL("$trimmed/api/cas/outbox/device-pending").openConnection() as HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout = 10_000
                setRequestProperty("X-CAS-Device-Token", token)
            }
            try {
                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.bufferedReader()?.readText().orEmpty()
                if (code != 200) throw java.io.IOException("HTTP $code ${text.take(200)}")
                text
            } finally {
                connection.disconnect()
            }
        }.getOrElse { error ->
            TestStore.record(context, "REQUEUE_CHECK_OUTCOME", mapOf("outcome" to "FAILED", "detail" to (error.message ?: error.javaClass.simpleName)))
            return null
        }

        val items = runCatching { JSONObject(body).getJSONArray("items") }.getOrElse {
            TestStore.record(context, "REQUEUE_CHECK_OUTCOME", mapOf("outcome" to "FAILED", "reason" to "response had no items array"))
            return null
        }
        val pending = mutableListOf<Pair<String, String>>()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val incidentId = item.optString("incidentId")
            if (incidentId.isBlank()) continue
            pending.add(incidentId to item.optString("transport", "SMS"))
        }
        return pending
    }

    private fun recordImmediateFailure(batch: Batch, recipient: String, error: String) {
        synchronized(lock) {
            batch.remainingByRecipient[recipient] = 0
            batch.failures.putIfAbsent(recipient, error)
        }
    }

    private fun onWatchdog(context: Context, sendId: String) {
        synchronized(lock) {
            val batch = batches[sendId] ?: return
            for ((recipient, remaining) in batch.remainingByRecipient) {
                if (remaining > 0) {
                    batch.remainingByRecipient[recipient] = 0
                    batch.failures.putIfAbsent(recipient, "NO_RADIO_RESULT")
                }
            }
        }
        finalizeIfComplete(context, sendId)
    }

    private fun finalizeIfComplete(context: Context, sendId: String) {
        val complete = synchronized(lock) {
            batches[sendId]?.remainingByRecipient?.values?.all { it == 0 } == true
        }
        if (complete) finalize(context, sendId)
    }

    private fun finalize(context: Context, sendId: String) {
        val batch = synchronized(lock) { batches.remove(sendId) } ?: return
        val results = batch.remainingByRecipient.keys.map { recipient ->
            Triple(recipient, !batch.failures.containsKey(recipient), batch.failures[recipient])
        }
        val failed = results.count { !it.second }
        TestStore.record(context, "SMS_SEND_OUTCOME", mapOf(
            "sendId" to sendId,
            "incidentId" to (batch.incidentId ?: JSONObject.NULL),
            "responders" to results.size,
            "delivered" to (results.size - failed),
            "failed" to failed,
            "failures" to batch.failures.entries.joinToString("; ") { "${it.value} (${mask(it.key)})" },
        ))

        val incidentId = batch.incidentId ?: return
        // If the server URL is missing the SMS already left anyway; the
        // console keeps the item QUEUED on purpose until a receipt arrives.
        reportChannelOutcome(context, incidentId, "SMS", results)
    }

    /**
     * Shared receipt reporting for the device-delivered channels
     * (WhatsAppAlerter uses it too): posts the per-recipient outcome to the
     * console's device-receipt endpoint on a background thread. Without a
     * configured server URL the report is journaled as SKIPPED and the
     * console keeps the item QUEUED on purpose.
     */
    fun reportChannelOutcome(
        context: Context,
        incidentId: String,
        channel: String,
        results: List<Triple<String, Boolean, String?>>,
    ) {
        val baseUrl = TestStore.alertServerUrl(context)
        if (baseUrl.isBlank()) {
            TestStore.record(context, "${channel}_RECEIPT_OUTCOME", mapOf(
                "incidentId" to incidentId,
                "outcome" to "SKIPPED",
                "reason" to "no alert server URL configured",
            ))
            return
        }
        Thread { postReceipt(context, baseUrl, incidentId, channel, results) }.start()
    }

    private fun postReceipt(context: Context, baseUrl: String, incidentId: String, channel: String, results: List<Triple<String, Boolean, String?>>) {
        val trimmed = baseUrl.trim().trimEnd('/')
        val token = TestStore.deviceToken(context)
        if (token.isBlank()) {
            // The console refuses unauthenticated receipts; the item stays
            // QUEUED until a token is configured and a later report lands.
            TestStore.record(context, "${channel}_RECEIPT_OUTCOME", mapOf(
                "incidentId" to incidentId,
                "outcome" to "SKIPPED",
                "reason" to "no device access token configured; the console refuses receipts without it",
            ))
            return
        }
        val payload = JSONObject().put("channel", channel).put("results", JSONArray().apply {
            results.forEach { (recipient, ok, error) ->
                put(JSONObject().put("recipient", recipient).put("ok", ok).apply {
                    if (error != null) put("error", error)
                })
            }
        })
        val outcome = runCatching {
            val connection = (URL("$trimmed/api/cas/incidents/$incidentId/device-receipt").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 10_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("X-CAS-Device-Token", token)
            }
            try {
                connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
                val code = connection.responseCode
                if (code in 200..299) "REPORTED (HTTP $code)" else "FAILED (HTTP $code)"
            } finally {
                connection.disconnect()
            }
        }.getOrElse { "FAILED (${it.message ?: it.javaClass.simpleName})" }
        TestStore.record(context, "${channel}_RECEIPT_OUTCOME", mapOf("incidentId" to incidentId, "outcome" to outcome))
    }

    private fun errorName(code: Int): String = when (code) {
        SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "RESULT_ERROR_GENERIC_FAILURE"
        SmsManager.RESULT_ERROR_RADIO_OFF -> "RESULT_ERROR_RADIO_OFF"
        SmsManager.RESULT_ERROR_NULL_PDU -> "RESULT_ERROR_NULL_PDU"
        SmsManager.RESULT_ERROR_NO_SERVICE -> "RESULT_ERROR_NO_SERVICE"
        SmsManager.RESULT_ERROR_LIMIT_EXCEEDED -> "RESULT_ERROR_LIMIT_EXCEEDED"
        SmsManager.RESULT_ERROR_FDN_CHECK_FAILURE -> "RESULT_ERROR_FDN_CHECK_FAILURE"
        SmsManager.RESULT_ERROR_SHORT_CODE_NOT_ALLOWED -> "RESULT_ERROR_SHORT_CODE_NOT_ALLOWED"
        SmsManager.RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED -> "RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED"
        else -> "RESULT_$code"
    }

    private fun mask(recipient: String): String {
        val digits = recipient.filter { it.isDigit() }
        return if (digits.length >= 2) "•••${digits.takeLast(2)}" else "•••"
    }
}
