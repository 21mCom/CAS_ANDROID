package com.covertalert.pixeltest

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.telephony.SmsManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Device-direct SMS delivery: the handset itself texts responders over its own
 * SIM, then reports the outcome to the console's sms-receipt endpoint so the
 * incident's SMS outbox item leaves QUEUED. There is deliberately no
 * third-party gateway — this path still works when the phone has SMS-capable
 * signal but no data connection (the receipt then arrives late, retried until
 * the console accepts it).
 *
 * Each message part carries a sent-result broadcast (SmsResultReceiver); a
 * recipient is delivered only when every part reports RESULT_OK. A watchdog
 * finalizes batches whose radio results never arrive so the console is not
 * left waiting on a silent radio.
 *
 * Receipts are durable: unfinished batches and not-yet-accepted receipts are
 * persisted in device-local storage via the android-free ReceiptDurability
 * core (synchronous, atomic writes), so a process restart or a data outage
 * right after the SMS left the SIM cannot make a delivered alert look
 * undelivered forever. App resume and the re-queue check retry pending
 * receipts until the console accepts them (replays of an already-SENT item
 * are a cheap 200 no-op server-side), and the re-queue check never re-sends
 * an incident that still has an unfinished batch.
 *
 * A receipt can also outlive its batch: every operator re-queue mints a
 * fresh delivery-cycle token on the console, handed to the handset via
 * device-pending and echoed back in the receipt. A receipt echoing an
 * older token (or none, from a pre-re-queue batch) is rejected with
 * 410 Gone and the persisted copy is dropped instead of retried forever —
 * the replacement send reports its own receipt under the new token.
 */
object DeviceSmsSender {
    const val ACTION_SMS_SENT = "com.covertalert.pixeltest.action.SMS_SENT"
    const val EXTRA_SEND_ID = "sendId"
    const val EXTRA_RECIPIENT = "recipient"

    private const val RESULT_WATCHDOG_MS = 45_000L

    private class Batch(val sendId: String, val incidentId: String?, val cycleToken: String?) {
        /** Parts still awaiting a radio result, per recipient. */
        val remainingByRecipient = mutableMapOf<String, Int>()
        /** First failure per recipient; absence means delivered. */
        val failures = mutableMapOf<String, String>()
        /**
         * In-memory only: true once the send loop has dispatched every part.
         * A fast radio callback must never finalize a partially registered
         * batch mid-loop. Recovered batches are complete by definition — the
         * dispatch loop died with the process and cannot resume.
         */
        var dispatchComplete = false

        fun toPending(): PendingBatch = PendingBatch(
            sendId = sendId,
            incidentId = incidentId,
            remainingByRecipient = remainingByRecipient.toMap(),
            failures = failures.toMap(),
            cycleToken = cycleToken,
        )

        companion object {
            fun fromPending(pending: PendingBatch): Batch {
                val batch = Batch(pending.sendId, pending.incidentId, pending.cycleToken)
                batch.remainingByRecipient.putAll(pending.remainingByRecipient)
                batch.failures.putAll(pending.failures)
                batch.dispatchComplete = true
                return batch
            }
        }
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
    fun sendAlert(context: Context, incidentId: String?, body: String, cycleToken: String? = null): String {
        val responders = TestStore.smsResponders(context)
        if (responders.isEmpty()) return "no responder numbers configured"
        if (context.checkSelfPermission(android.Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            return "SEND_SMS permission not granted"
        }
        val sms = context.getSystemService(SmsManager::class.java)
            ?: return "SmsManager unavailable"
        val appContext = context.applicationContext
        val store = TestStore.receiptStore(appContext)
        // Unique per send batch, not per incident (a UUID, so uniqueness does
        // not depend on the handset clock): after an operator re-queue the
        // replacement send gets a fresh id under the new cycle token.
        val sendId = "${incidentId ?: "offline"}-${java.util.UUID.randomUUID()}"

        // Compute the FULL roster before persisting or sending anything: the
        // durable record must cover every responder, so a process death
        // mid-dispatch can never finalize a partially attempted roster into
        // an all-success receipt that marks the console's item SENT.
        val roster = ReceiptDurability.planDispatch(responders) { recipient ->
            runCatching { sms.divideMessage(body) }.getOrNull()
        }
        val batch = Batch(sendId, incidentId, cycleToken)
        batch.remainingByRecipient.putAll(roster.partsByRecipient.mapValues { it.value.size })
        roster.failures.keys.forEach { batch.remainingByRecipient[it] = 0 }
        batch.failures.putAll(roster.failures)

        synchronized(lock) {
            batches[sendId] = batch
            // Durable BEFORE the first part goes out; if the record cannot
            // reach disk, nothing may be sent — an unrecorded delivery is
            // exactly the lost receipt this guard exists to prevent.
            if (!ReceiptDurability.persistBatch(store, batch.toPending())) {
                batches.remove(sendId)
                TestStore.record(context, "SMS_SEND_ABORTED", mapOf(
                    "sendId" to sendId,
                    "reason" to "could not durably persist the full delivery batch before sending; nothing was sent",
                ))
                return "send aborted: could not durably persist the delivery batch (see SMS_SEND_ABORTED)"
            }
        }
        handler.postDelayed({ onWatchdog(appContext, sendId) }, RESULT_WATCHDOG_MS)

        for ((recipient, parts) in roster.partsByRecipient) {
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
                sms.sendMultipartTextMessage(recipient, null, ArrayList(parts), sentIntents, null)
            } catch (error: IllegalArgumentException) {
                recordImmediateFailure(appContext, store, batch, recipient, "ILLEGAL_DESTINATION_ADDRESS")
            } catch (error: SecurityException) {
                recordImmediateFailure(appContext, store, batch, recipient, "PERMISSION_DENIED")
            }
        }

        // Dispatch is done: only now may a completion check finalize the
        // batch, however fast the radio callbacks arrived during the loop.
        synchronized(lock) { batch.dispatchComplete = true }
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
        val appContext = context.applicationContext
        val store = TestStore.receiptStore(appContext)
        synchronized(lock) {
            // A late radio result can restart the process; rehydrate the
            // persisted batch so its receipt is still finalized and posted.
            val batch = batches[sendId] ?: rehydrateBatchLocked(appContext, store, sendId) ?: return
            val remaining = (batch.remainingByRecipient[recipient] ?: 0) - 1
            batch.remainingByRecipient[recipient] = remaining.coerceAtLeast(0)
            if (error != null) batch.failures.putIfAbsent(recipient, error)
            persistBatchLocked(appContext, store, batch)
        }
        TestStore.record(context, "SMS_PART_RESULT", mapOf(
            "sendId" to sendId,
            "recipient" to mask(recipient),
            "result" to (error ?: "OK"),
        ))
        finalizeIfComplete(appContext, sendId)
    }

    /**
     * Picks up SMS deliveries an operator re-queued in the console and
     * re-sends them from the SIM. Runs on a background thread; journals the
     * outcome. WHATSAPP items on the same list are WhatsAppAlerter's job.
     *
     * Items are skipped while this handset still owes them an answer: an
     * unfinished batch (their SMS may already have left the SIM with the
     * receipt still coming) or a persisted receipt the console has not
     * accepted yet (the SMS DID leave; the console still lists the item only
     * because the receipt POST failed or is in flight). Re-sending either
     * would double-text the responder.
     */
    fun sendRequeued(context: Context): String {
        val items = fetchPendingItems(context)
            ?: return "device-pending check failed (see REQUEUE_CHECK_OUTCOME)"
        val store = TestStore.receiptStore(context.applicationContext)
        val liveIncidentIds = synchronized(lock) { batches.values.mapNotNull { it.incidentId }.toSet() }
        val deferredIds = ReceiptDurability.deferRequeueIncidentIds(store, liveIncidentIds, "SMS")
        var pickedUp = 0
        var deferred = 0
        for (item in items) {
            if (item.transport != "SMS") continue
            if (item.incidentId in deferredIds) {
                deferred += 1
                continue
            }
            pickedUp += 1
            // The cycle token is persisted with the batch and echoed in the
            // receipt, so the console can reject stale receipts of the
            // superseded batch instead of letting them mark the item SENT.
            sendAlert(context, item.incidentId, alertBody(item.incidentId), item.cycleToken)
        }
        TestStore.record(context, "REQUEUE_CHECK_OUTCOME", mapOf(
            "outcome" to "OK",
            "pickedUp" to pickedUp,
            "listed" to items.size,
            "deferredUnfinished" to deferred,
        ))
        return "picked up $pickedUp re-queued SMS deliver${if (pickedUp == 1) "y" else "ies"}" +
            if (deferred > 0) "; deferred $deferred still owed a receipt by this handset" else ""
    }

    /** One item from the console's device-pending list. */
    data class PendingItem(
        val incidentId: String,
        val transport: String,
        /** Current delivery-cycle token; null while the item is in its initial cycle or on older consoles. */
        val cycleToken: String?,
    )

    /**
     * Fetches the handset's pending device-delivered items from the console's
     * device-pending list. Returns null on any failure after journaling the
     * reason. Items without a transport field (older consoles) are treated as
     * SMS.
     */
    fun fetchPendingItems(context: Context): List<PendingItem>? {
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
        val pending = mutableListOf<PendingItem>()
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val incidentId = item.optString("incidentId")
            if (incidentId.isBlank()) continue
            pending.add(PendingItem(
                incidentId = incidentId,
                transport = item.optString("transport", "SMS"),
                cycleToken = item.optString("cycleToken").takeIf { it.isNotBlank() },
            ))
        }
        return pending
    }

    private fun recordImmediateFailure(context: Context, store: ReceiptStore, batch: Batch, recipient: String, error: String) {
        synchronized(lock) {
            batch.remainingByRecipient[recipient] = 0
            batch.failures.putIfAbsent(recipient, error)
            persistBatchLocked(context, store, batch)
        }
    }

    /** Caller must hold [lock]. */
    private fun persistBatchLocked(context: Context, store: ReceiptStore, batch: Batch) {
        if (!ReceiptDurability.persistBatch(store, batch.toPending())) {
            TestStore.record(context, "SMS_BATCH_PERSIST_FAILED", mapOf("sendId" to batch.sendId))
        }
    }

    /**
     * Caller must hold [lock]. Restores a persisted batch into the live map
     * (e.g. after a process restart) and re-arms its watchdog, since the
     * original handler callback died with the process. Returns null when no
     * such batch was persisted.
     */
    private fun rehydrateBatchLocked(context: Context, store: ReceiptStore, sendId: String): Batch? {
        val pending = ReceiptDurability.loadBatches(store)[sendId] ?: return null
        val batch = Batch.fromPending(pending)
        batches[sendId] = batch
        handler.postDelayed({ onWatchdog(context, sendId) }, RESULT_WATCHDOG_MS)
        TestStore.record(context, "SMS_BATCH_REHYDRATED", mapOf("sendId" to sendId))
        return batch
    }

    private fun onWatchdog(context: Context, sendId: String) {
        val store = TestStore.receiptStore(context.applicationContext)
        synchronized(lock) {
            val batch = batches[sendId] ?: return
            if (!batch.dispatchComplete) {
                // The send loop is still dispatching parts; radio results are
                // not late yet. Re-arm instead of marking honest sends as
                // NO_RADIO_RESULT.
                handler.postDelayed({ onWatchdog(context, sendId) }, RESULT_WATCHDOG_MS)
                return
            }
            for ((recipient, remaining) in batch.remainingByRecipient) {
                if (remaining > 0) {
                    batch.remainingByRecipient[recipient] = 0
                    batch.failures.putIfAbsent(recipient, "NO_RADIO_RESULT")
                }
            }
            persistBatchLocked(context, store, batch)
        }
        finalizeIfComplete(context, sendId)
    }

    private fun finalizeIfComplete(context: Context, sendId: String) {
        val complete = synchronized(lock) {
            val batch = batches[sendId]
            batch != null && batch.dispatchComplete && batch.remainingByRecipient.values.all { it == 0 }
        }
        if (complete) finalize(context, sendId)
    }

    private fun finalize(context: Context, sendId: String) {
        val batch = synchronized(lock) { batches.remove(sendId) } ?: return
        val store = TestStore.receiptStore(context.applicationContext)
        val pending = batch.toPending()
        val failed = pending.failures.size
        TestStore.record(context, "SMS_SEND_OUTCOME", mapOf(
            "sendId" to sendId,
            "incidentId" to (pending.incidentId ?: JSONObject.NULL),
            "responders" to pending.remainingByRecipient.size,
            "delivered" to (pending.remainingByRecipient.size - failed),
            "failed" to failed,
            "failures" to pending.failures.entries.joinToString("; ") { "${it.value} (${mask(it.key)})" },
        ))

        if (pending.incidentId == null) {
            // Offline send with no console incident: nothing to report, just
            // drop the durable batch record.
            ReceiptDurability.dropBatch(store, sendId)
            return
        }
        // Lossless handoff: the receipt is enqueued and the batch record
        // dropped in ONE atomic write. A process death here leaves either the
        // batch (recovery finalizes it again — replay-safe server-side) or
        // the receipt (retried until accepted), never neither.
        val receipt = ReceiptDurability.finalizeBatch(store, pending, "SMS", System.currentTimeMillis())
        if (receipt == null) {
            TestStore.record(context, "SMS_RECEIPT_OUTCOME", mapOf(
                "incidentId" to pending.incidentId,
                "outcome" to "FAILED",
                "reason" to "could not durably persist the receipt; the batch stays queued for recovery",
            ))
            return
        }
        Thread { postReceipt(context, receipt) }.start()
    }

    /**
     * Shared receipt reporting for the device-delivered channels
     * (WhatsAppAlerter uses it too): durably persists the per-recipient
     * outcome first, then posts it to the console's device-receipt endpoint
     * on a background thread. The persisted copy is removed only when the
     * console accepts the receipt (any 2xx, including the replay of an
     * already-SENT item); a data outage or process death in between leaves it
     * queued for retryPendingReceipts.
     */
    fun reportChannelOutcome(
        context: Context,
        incidentId: String,
        channel: String,
        results: List<Triple<String, Boolean, String?>>,
        sendId: String? = null,
        cycleToken: String? = null,
    ) {
        val receipt = PendingReceipt(
            receiptId = sendId ?: "$channel-$incidentId-${java.util.UUID.randomUUID()}",
            incidentId = incidentId,
            channel = channel,
            queuedAtMs = System.currentTimeMillis(),
            results = results,
            cycleToken = cycleToken,
        )
        val store = TestStore.receiptStore(context.applicationContext)
        if (!ReceiptDurability.enqueueReceipt(store, receipt)) {
            TestStore.record(context, "${channel}_RECEIPT_OUTCOME", mapOf(
                "incidentId" to incidentId,
                "outcome" to "FAILED",
                "reason" to "could not durably persist the receipt",
            ))
            return
        }
        Thread { postReceipt(context, receipt) }.start()
    }

    /**
     * Retries every persisted receipt the console has not accepted yet.
     * Called on app resume and from the re-queue check, so a receipt that
     * lost the data race right after the SMS left still lands once the phone
     * is back online. Runs on the caller's thread; call from a background
     * thread. Returns a human-readable summary, or null when nothing was
     * pending.
     */
    fun retryPendingReceipts(context: Context): String? {
        val store = TestStore.receiptStore(context.applicationContext)
        val pending = ReceiptDurability.loadReceipts(store)
        if (pending.isEmpty()) return null
        var reported = 0
        var stillPending = 0
        for (receipt in pending) {
            if (postReceipt(context, receipt)) reported += 1 else stillPending += 1
        }
        val summary = "retried ${pending.size} pending receipt(s): $reported accepted, $stillPending still pending"
        TestStore.record(context, "RECEIPT_RETRY_OUTCOME", mapOf(
            "retried" to pending.size,
            "reported" to reported,
            "stillPending" to stillPending,
        ))
        return summary
    }

    /**
     * Restores unfinished SMS batches that survived a process restart and
     * re-arms their watchdogs, so a batch whose radio results died with the
     * process still finalizes (honest NO_RADIO_RESULT) and reports its
     * receipt instead of leaving the console's item QUEUED forever. Late
     * radio results rehydrate on their own via onSendResult. Batches whose
     * receipt already persisted are dropped — the receipt retry owns them.
     * Returns the number of batches recovered.
     */
    fun recoverUnfinishedBatches(context: Context): Int {
        val appContext = context.applicationContext
        val store = TestStore.receiptStore(appContext)
        val plan = ReceiptDurability.planRecovery(store)
        if (plan.dropSendIds.isNotEmpty()) {
            ReceiptDurability.applyRecoveryDrops(store, plan.dropSendIds)
        }
        var recovered = 0
        for (pending in plan.resume) {
            synchronized(lock) {
                if (!batches.containsKey(pending.sendId)) {
                    batches[pending.sendId] = Batch.fromPending(pending)
                    recovered += 1
                    handler.postDelayed({ onWatchdog(appContext, pending.sendId) }, RESULT_WATCHDOG_MS)
                }
            }
        }
        if (recovered > 0 || plan.dropSendIds.isNotEmpty()) {
            TestStore.record(context, "SMS_BATCH_RECOVERY", mapOf(
                "recovered" to recovered,
                "droppedAlreadyReported" to plan.dropSendIds.size,
            ))
        }
        return recovered
    }

    /**
     * Posts one persisted receipt; removes it from the pending store when
     * the console accepts it (any 2xx — a receipt replayed against an
     * already-SENT or already-acted-on item is a 200 no-op server-side) or
     * permanently rejects it (410 Gone: the batch predates the latest
     * re-queue, so retrying can never succeed and must stop). Every other
     * failure keeps the receipt queued for the next retry. Returns whether
     * the receipt was accepted.
     */
    private fun postReceipt(context: Context, receipt: PendingReceipt): Boolean {
        val channel = receipt.channel
        val baseUrl = TestStore.alertServerUrl(context)
        if (baseUrl.isBlank()) {
            // The SMS already left anyway; the receipt stays queued until a
            // server URL is configured and a later retry lands it.
            TestStore.record(context, "${channel}_RECEIPT_OUTCOME", mapOf(
                "incidentId" to receipt.incidentId,
                "outcome" to "SKIPPED",
                "reason" to "no alert server URL configured; receipt kept for retry",
            ))
            return false
        }
        val token = TestStore.deviceToken(context)
        if (token.isBlank()) {
            // The console refuses unauthenticated receipts; the item stays
            // QUEUED until a token is configured and a later retry lands.
            TestStore.record(context, "${channel}_RECEIPT_OUTCOME", mapOf(
                "incidentId" to receipt.incidentId,
                "outcome" to "SKIPPED",
                "reason" to "no device access token configured; the console refuses receipts without it; receipt kept for retry",
            ))
            return false
        }
        val trimmed = baseUrl.trim().trimEnd('/')
        val responseCode = runCatching {
            val connection = (URL("$trimmed/api/cas/incidents/${receipt.incidentId}/device-receipt").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 10_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("X-CAS-Device-Token", token)
            }
            try {
                connection.outputStream.use { it.write(receipt.toPayload().toString().toByteArray(Charsets.UTF_8)) }
                connection.responseCode
            } finally {
                connection.disconnect()
            }
        }.getOrElse { -1 }
        // 410 Gone is a permanent rejection: the console re-queued the item
        // since this receipt's batch started, so the receipt echoes a
        // superseded cycle token and will never be accepted. Drop it instead
        // of retrying forever — the replacement send posts its own receipt.
        // Every other non-2xx (outage, 401, transient 409) stays retryable.
        val stale = responseCode == 410
        val accepted = responseCode in 200..299
        TestStore.record(context, "${channel}_RECEIPT_OUTCOME", buildMap {
            put("incidentId", receipt.incidentId)
            put("outcome", when {
                accepted -> "REPORTED"
                stale -> "DROPPED_STALE"
                else -> "FAILED; receipt kept for retry"
            })
            if (stale) {
                put("reason", "console rejected the receipt as stale (410): its batch belongs to a superseded delivery cycle; the replacement send reports its own receipt")
            }
        })
        if (accepted || stale) {
            ReceiptDurability.ackReceipt(TestStore.receiptStore(context.applicationContext), receipt.receiptId)
        }
        return accepted
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
