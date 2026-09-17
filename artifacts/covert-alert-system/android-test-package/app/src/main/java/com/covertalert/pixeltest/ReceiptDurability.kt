package com.covertalert.pixeltest

import org.json.JSONArray
import org.json.JSONObject

/**
 * Minimal synchronous key-value persistence the durable receipt queue needs.
 * TestStore backs this with SharedPreferences; the repo-only harness backs it
 * with an in-memory map so the process-death windows can be exercised on the
 * JVM (scripts/test-receipt-durability.sh).
 */
interface ReceiptStore {
    fun read(key: String): String?

    /**
     * Applies every put and remove as ONE durable, atomic write and returns
     * false when the write did not reach storage. The batch→receipt handoff
     * relies on this atomicity: a process death must never observe a state
     * where the batch is gone but its receipt was never persisted.
     */
    fun transact(puts: Map<String, String>, removes: Set<String>): Boolean
}

/** Persisted form of an unfinished SMS delivery batch. */
data class PendingBatch(
    val sendId: String,
    val incidentId: String?,
    val remainingByRecipient: Map<String, Int>,
    val failures: Map<String, String>,
    /**
     * The console's delivery-cycle token picked up from device-pending with a
     * re-queued item; null for locally triggered initial-cycle sends. Echoed
     * in the receipt so the console can reject receipts of superseded batches
     * instead of letting them mark a re-queued item SENT.
     */
    val cycleToken: String? = null,
) {
    /** Per-recipient outcome exactly as the console's device-receipt endpoint expects it. */
    fun results(): List<Triple<String, Boolean, String?>> =
        remainingByRecipient.keys.map { recipient ->
            Triple(recipient, !failures.containsKey(recipient), failures[recipient])
        }
}

/**
 * The complete dispatch plan for one alert, computed BEFORE anything is
 * persisted or sent. Every responder appears exactly once across
 * [partsByRecipient] and [failures], so the durable batch record always
 * covers the full roster: a process death mid-dispatch can never turn a
 * partially attempted roster into an all-success receipt.
 */
class DispatchRoster(
    /** Recipients with their computed message parts, ready to send. */
    val partsByRecipient: Map<String, List<String>>,
    /** Recipients that failed before any part could be dispatched. */
    val failures: Map<String, String>,
) {
    fun toPendingBatch(sendId: String, incidentId: String?): PendingBatch = PendingBatch(
        sendId = sendId,
        incidentId = incidentId,
        remainingByRecipient = partsByRecipient.mapValues { it.value.size } +
            failures.keys.associateWith { 0 },
        failures = failures,
    )
}

/** Persisted form of a delivery receipt the console has not accepted yet. */
data class PendingReceipt(
    val receiptId: String,
    val incidentId: String,
    val channel: String,
    val queuedAtMs: Long,
    val results: List<Triple<String, Boolean, String?>>,
    /** The delivery-cycle token of the batch this receipt reports (see PendingBatch.cycleToken). */
    val cycleToken: String? = null,
) {
    /**
     * POST body for the console's device-receipt endpoint. The cycleToken
     * (when the batch had one) lets the console tell the current delivery
     * cycle's receipt apart from a stale one left over from before an
     * operator re-queue — without comparing handset and console clocks.
     */
    fun toPayload(): JSONObject = JSONObject()
        .put("channel", channel)
        .apply { if (cycleToken != null) put("cycleToken", cycleToken) }
        .put("results", JSONArray().apply {
            results.forEach { (recipient, ok, error) ->
                put(JSONObject().put("recipient", recipient).put("ok", ok).apply {
                    if (error != null) put("error", error)
                })
            }
        })
}

/**
 * Android-free decision core for durable device-direct receipts. All
 * read-modify-write sequences go through [ReceiptStore.transact] and are
 * serialized on [lock], so a batch and its receipt can never be lost between
 * two writes, and concurrent receipt posts cannot drop each other's updates.
 */
object ReceiptDurability {
    const val BATCHES_KEY = "sms_batches"
    const val RECEIPTS_KEY = "pending_receipts"

    private val lock = Any()

    /** What a restarted process must do with each persisted batch. */
    class RecoveryPlan(
        /** Batches with no persisted receipt: resume tracking and finalize them. */
        val resume: List<PendingBatch>,
        /** Batches whose receipt already survived: drop the stale batch record. */
        val dropSendIds: List<String>,
    )

    /**
     * Computes the full dispatch roster for one alert: message parts for
     * every reachable responder and a DIVIDE_FAILED entry for every responder
     * whose message cannot be split. Pure and android-free so the harness can
     * prove the roster is always complete before any SMS goes out.
     */
    fun planDispatch(responders: List<String>, divide: (String) -> List<String>?): DispatchRoster {
        val parts = linkedMapOf<String, List<String>>()
        val failures = linkedMapOf<String, String>()
        for (recipient in responders) {
            val divided = divide(recipient)
            if (divided.isNullOrEmpty()) {
                failures[recipient] = "DIVIDE_FAILED"
            } else {
                parts[recipient] = divided
            }
        }
        return DispatchRoster(parts, failures)
    }

    fun loadBatches(store: ReceiptStore): Map<String, PendingBatch> =
        decodeBatches(store.read(BATCHES_KEY))

    fun loadReceipts(store: ReceiptStore): List<PendingReceipt> =
        decodeReceipts(store.read(RECEIPTS_KEY))

    fun persistBatch(store: ReceiptStore, batch: PendingBatch): Boolean = synchronized(lock) {
        val batches = loadBatches(store) + (batch.sendId to batch)
        store.transact(mapOf(BATCHES_KEY to encodeBatches(batches)), emptySet())
    }

    fun dropBatch(store: ReceiptStore, sendId: String): Boolean = synchronized(lock) {
        val batches = loadBatches(store) - sendId
        store.transact(mapOf(BATCHES_KEY to encodeBatches(batches)), emptySet())
    }

    /** Enqueues a receipt, replacing any existing entry with the same receiptId. */
    fun enqueueReceipt(store: ReceiptStore, receipt: PendingReceipt): Boolean = synchronized(lock) {
        val receipts = loadReceipts(store).filterNot { it.receiptId == receipt.receiptId } + receipt
        store.transact(mapOf(RECEIPTS_KEY to encodeReceipts(receipts)), emptySet())
    }

    /** Removes a receipt the console has accepted (any 2xx, replay included). */
    fun ackReceipt(store: ReceiptStore, receiptId: String): Boolean = synchronized(lock) {
        val receipts = loadReceipts(store).filterNot { it.receiptId == receiptId }
        store.transact(mapOf(RECEIPTS_KEY to encodeReceipts(receipts)), emptySet())
    }

    /**
     * Lossless batch→receipt handoff: the receipt is enqueued and the batch
     * record dropped in ONE atomic write, so a process death in the handoff
     * leaves either the batch (recovery finalizes it again — replay-safe
     * server-side) or the receipt (retried until accepted), never neither.
     * Returns the receipt to post, or null when the write failed (the batch
     * is still persisted and recovery will retry the handoff).
     */
    fun finalizeBatch(store: ReceiptStore, batch: PendingBatch, channel: String, nowMs: Long): PendingReceipt? = synchronized(lock) {
        val incidentId = batch.incidentId ?: return null
        val receipt = PendingReceipt(
            receiptId = batch.sendId,
            incidentId = incidentId,
            channel = channel,
            queuedAtMs = nowMs,
            results = batch.results(),
            cycleToken = batch.cycleToken,
        )
        val batches = loadBatches(store) - batch.sendId
        val receipts = loadReceipts(store).filterNot { it.receiptId == receipt.receiptId } + receipt
        val committed = store.transact(
            mapOf(
                BATCHES_KEY to encodeBatches(batches),
                RECEIPTS_KEY to encodeReceipts(receipts),
            ),
            emptySet(),
        )
        if (committed) receipt else null
    }

    /**
     * Incident ids the re-queue check must NOT re-send for [channel]: every
     * incident with an unfinished batch (persisted or live in this process —
     * its SMS may already have left the SIM with the receipt still coming),
     * plus every incident with a persisted, not-yet-accepted receipt for that
     * channel. The receipt half closes the window where the batch is already
     * finalized (so the batch guard no longer applies) but the console still
     * lists the item as pending because the receipt POST failed or is still
     * in flight. An incident leaves this set only when the console accepts
     * the receipt and the durable record is removed.
     */
    fun deferRequeueIncidentIds(store: ReceiptStore, liveIncidentIds: Set<String>, channel: String): Set<String> =
        liveIncidentIds +
            loadBatches(store).values.mapNotNull { it.incidentId } +
            loadReceipts(store).filter { it.channel == channel }.map { it.incidentId }

    /**
     * Splits persisted batches after a process restart into batches to resume
     * (no receipt persisted yet) and stale batch records to drop (the receipt
     * already survived, so the receipt retry owns the report). Dropping is a
     * single atomic write together with no other change.
     */
    fun planRecovery(store: ReceiptStore): RecoveryPlan = synchronized(lock) {
        val batches = loadBatches(store)
        val receiptIds = loadReceipts(store).map { it.receiptId }.toSet()
        val resume = batches.values.filter { it.sendId !in receiptIds }
        val dropSendIds = batches.keys.filter { it in receiptIds }
        RecoveryPlan(resume, dropSendIds)
    }

    /** Drops the stale batch records named by a RecoveryPlan in one write. */
    fun applyRecoveryDrops(store: ReceiptStore, dropSendIds: List<String>): Boolean = synchronized(lock) {
        if (dropSendIds.isEmpty()) return true
        val batches = loadBatches(store) - dropSendIds.toSet()
        store.transact(mapOf(BATCHES_KEY to encodeBatches(batches)), emptySet())
    }

    fun decodeBatches(raw: String?): Map<String, PendingBatch> {
        val json = runCatching { JSONObject(raw ?: "{}") }.getOrDefault(JSONObject())
        val batches = mutableMapOf<String, PendingBatch>()
        for (sendId in json.keys()) {
            val entry = json.optJSONObject(sendId) ?: continue
            val remaining = mutableMapOf<String, Int>()
            entry.optJSONObject("remaining")?.let { remainingJson ->
                for (recipient in remainingJson.keys()) {
                    remaining[recipient] = remainingJson.optInt(recipient, 0)
                }
            }
            val failures = mutableMapOf<String, String>()
            entry.optJSONObject("failures")?.let { failuresJson ->
                for (recipient in failuresJson.keys()) {
                    failures[recipient] = failuresJson.optString(recipient)
                }
            }
            batches[sendId] = PendingBatch(
                sendId = sendId,
                incidentId = entry.optString("incidentId").takeIf { it.isNotBlank() },
                remainingByRecipient = remaining,
                failures = failures,
                // Absent in records persisted by older app versions.
                cycleToken = entry.optString("cycleToken").takeIf { it.isNotBlank() },
            )
        }
        return batches
    }

    fun encodeBatches(batches: Map<String, PendingBatch>): String {
        val json = JSONObject()
        batches.forEach { (sendId, batch) ->
            json.put(sendId, JSONObject()
                .put("incidentId", batch.incidentId ?: JSONObject.NULL)
                .put("cycleToken", batch.cycleToken ?: JSONObject.NULL)
                .put("remaining", JSONObject().apply {
                    batch.remainingByRecipient.forEach { (recipient, remaining) -> put(recipient, remaining) }
                })
                .put("failures", JSONObject().apply {
                    batch.failures.forEach { (recipient, error) -> put(recipient, error) }
                }))
        }
        return json.toString()
    }

    fun decodeReceipts(raw: String?): List<PendingReceipt> {
        val json = runCatching { JSONArray(raw ?: "[]") }.getOrDefault(JSONArray())
        return (0 until json.length()).mapNotNull { index ->
            val entry = json.optJSONObject(index) ?: return@mapNotNull null
            val receiptId = entry.optString("receiptId")
            val incidentId = entry.optString("incidentId")
            val channel = entry.optString("channel")
            if (receiptId.isBlank() || incidentId.isBlank() || channel.isBlank()) return@mapNotNull null
            val results = mutableListOf<Triple<String, Boolean, String?>>()
            entry.optJSONArray("results")?.let { resultsJson ->
                for (resultIndex in 0 until resultsJson.length()) {
                    val result = resultsJson.optJSONObject(resultIndex) ?: continue
                    results.add(Triple(
                        result.optString("recipient"),
                        result.optBoolean("ok"),
                        if (result.has("error")) result.optString("error") else null,
                    ))
                }
            }
            PendingReceipt(
                receiptId = receiptId,
                incidentId = incidentId,
                channel = channel,
                queuedAtMs = entry.optLong("queuedAtMs"),
                results = results,
                // Absent in receipts persisted by older app versions.
                cycleToken = entry.optString("cycleToken").takeIf { it.isNotBlank() },
            )
        }
    }

    fun encodeReceipts(receipts: List<PendingReceipt>): String {
        val json = JSONArray()
        receipts.forEach { receipt ->
            json.put(JSONObject()
                .put("receiptId", receipt.receiptId)
                .put("incidentId", receipt.incidentId)
                .put("channel", receipt.channel)
                .put("queuedAtMs", receipt.queuedAtMs)
                .put("cycleToken", receipt.cycleToken ?: JSONObject.NULL)
                .put("results", JSONArray().apply {
                    receipt.results.forEach { (recipient, ok, error) ->
                        put(JSONObject().put("recipient", recipient).put("ok", ok).apply {
                            if (error != null) put("error", error)
                        })
                    }
                }))
        }
        return json.toString()
    }
}
