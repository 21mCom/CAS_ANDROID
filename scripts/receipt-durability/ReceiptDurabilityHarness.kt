package com.covertalert.pixeltest

/**
 * Repo-only JVM harness for the ReceiptDurability core (no Android runtime).
 * Exercises the process-death windows around every persistence boundary the
 * handset relies on: batch persisted before send, the atomic batch→receipt
 * handoff at finalization, recovery after a restart, and the re-queue guard
 * that must not re-send an incident whose batch is still unfinished.
 *
 * Run via scripts/test-receipt-durability.sh — do not ship in the APK.
 */

/** In-memory ReceiptStore; transact applies all-or-nothing like a commit(). */
private class FakeStore : ReceiptStore {
    val data = mutableMapOf<String, String>()
    var failTransactions = false
    var transactCount = 0

    override fun read(key: String): String? = data[key]

    override fun transact(puts: Map<String, String>, removes: Set<String>): Boolean {
        transactCount += 1
        if (failTransactions) return false // nothing applied, like a lost write
        data.putAll(puts)
        removes.forEach { data.remove(it) }
        return true
    }
}

private var failures = 0
private var checks = 0

private fun check(name: String, condition: Boolean, detail: String = "") {
    checks += 1
    if (!condition) {
        failures += 1
        println("FAIL: $name${if (detail.isEmpty()) "" else " — $detail"}")
    }
}

private fun sampleBatch(sendId: String = "inc-1", incidentId: String? = "inc-1") = PendingBatch(
    sendId = sendId,
    incidentId = incidentId,
    remainingByRecipient = mapOf("+15551234\"'\n567" to 0, "+44 7911 123456" to 0),
    failures = mapOf("+44 7911 123456" to "RESULT_ERROR_NO_SERVICE"),
)

fun main() {
    // 1. Batch encode/decode round-trips, including hostile recipient chars.
    run {
        val store = FakeStore()
        val batch = sampleBatch()
        check("persistBatch commits", ReceiptDurability.persistBatch(store, batch))
        val loaded = ReceiptDurability.loadBatches(store)
        check("batch round-trip", loaded[batch.sendId] == batch, loaded.toString())
    }

    // 2. Receipt encode/decode round-trips.
    run {
        val store = FakeStore()
        val receipt = PendingReceipt(
            receiptId = "inc-1",
            incidentId = "inc-1",
            channel = "SMS",
            queuedAtMs = 1726000000000,
            results = listOf(Triple("+15551234567", true, null), Triple("+15557654321", false, "NO_RADIO_RESULT")),
        )
        check("enqueueReceipt commits", ReceiptDurability.enqueueReceipt(store, receipt))
        check("receipt round-trip", ReceiptDurability.loadReceipts(store) == listOf(receipt))
        val payload = receipt.toPayload()
        check("payload channel", payload.getString("channel") == "SMS")
        check("payload results", payload.getJSONArray("results").length() == 2)
        // Initial-cycle receipts carry no cycle token; the field must be
        // absent from the payload (not null) so the console's optional-field
        // schema sees it as unset.
        check("initial-cycle payload omits cycleToken", !payload.has("cycleToken"))
    }

    // 2b. Delivery-cycle token: a re-queued batch's token round-trips through
    //     persistence into the receipt and its payload — it is what lets the
    //     console reject stale receipts of a superseded batch without
    //     comparing handset and console clocks. Records persisted by older
    //     app versions (no cycleToken field) decode with a null token.
    run {
        val store = FakeStore()
        val batch = sampleBatch().copy(cycleToken = "cycle-1")
        check("token batch persists", ReceiptDurability.persistBatch(store, batch))
        check("batch token round-trips", ReceiptDurability.loadBatches(store)["inc-1"]?.cycleToken == "cycle-1")
        val receipt = ReceiptDurability.finalizeBatch(store, batch, "SMS", 1726000000005)
        check("receipt inherits batch token", receipt?.cycleToken == "cycle-1")
        check("receipt token survives reload", ReceiptDurability.loadReceipts(store).single().cycleToken == "cycle-1")
        check("payload echoes cycleToken", receipt?.toPayload()?.getString("cycleToken") == "cycle-1")

        val legacy = FakeStore()
        legacy.data[ReceiptDurability.BATCHES_KEY] =
            """{"inc-old":{"incidentId":"inc-old","remaining":{},"failures":{}}}"""
        legacy.data[ReceiptDurability.RECEIPTS_KEY] =
            """[{"receiptId":"r-old","incidentId":"inc-old","channel":"SMS","queuedAtMs":1,"results":[]}]"""
        check("legacy batch decodes with null token", ReceiptDurability.loadBatches(legacy)["inc-old"]?.cycleToken == null)
        check("legacy receipt decodes with null token", ReceiptDurability.loadReceipts(legacy).single().cycleToken == null)
    }

    // 3. Happy path: finalize hands batch off to a receipt in one write, and
    //    the receipt carries the per-recipient outcome.
    run {
        val store = FakeStore()
        val batch = sampleBatch()
        ReceiptDurability.persistBatch(store, batch)
        val before = store.transactCount
        val receipt = ReceiptDurability.finalizeBatch(store, batch, "SMS", 1726000000000)
        check("finalize returns receipt", receipt != null)
        check("finalize is one atomic write", store.transactCount == before + 1)
        check("batch dropped after finalize", ReceiptDurability.loadBatches(store).isEmpty())
        check("receipt id is sendId", receipt?.receiptId == batch.sendId)
        check(
            "receipt results derived from batch",
            receipt?.results == batch.results(),
            receipt?.results.toString(),
        )
        check("recovery has nothing to resume", ReceiptDurability.planRecovery(store).resume.isEmpty())
    }

    // 4. Process death AFTER the SMS went out but BEFORE finalize: the
    //    persisted batch is the only record and recovery must resume it.
    run {
        val store = FakeStore()
        val batch = sampleBatch()
        ReceiptDurability.persistBatch(store, batch)
        // crash here — no receipt ever persisted
        val plan = ReceiptDurability.planRecovery(store)
        check("recovery resumes orphaned batch", plan.resume == listOf(batch))
        check("recovery drops nothing", plan.dropSendIds.isEmpty())
        // recovery finalizes the resumed batch: receipt now exists
        val receipt = ReceiptDurability.finalizeBatch(store, plan.resume.single(), "SMS", 1726000000001)
        check("recovered batch finalizes", receipt != null)
        check("no batch left after recovery finalize", ReceiptDurability.planRecovery(store).resume.isEmpty())
    }

    // 5. Process death DURING the handoff: the write either landed whole or
    //    not at all — never a state with neither batch nor receipt.
    run {
        val lost = FakeStore()
        val batch = sampleBatch()
        ReceiptDurability.persistBatch(lost, batch)
        lost.failTransactions = true // write dies with the process
        val receipt = ReceiptDurability.finalizeBatch(lost, batch, "SMS", 1726000000000)
        check("failed handoff reports failure", receipt == null)
        check(
            "failed handoff keeps the batch",
            ReceiptDurability.loadBatches(lost)[batch.sendId] == batch,
        )
        check("failed handoff persisted no receipt", ReceiptDurability.loadReceipts(lost).isEmpty())
        // later recovery retries the whole handoff
        lost.failTransactions = false
        val plan = ReceiptDurability.planRecovery(lost)
        check("recovery retries lost handoff", plan.resume == listOf(batch))
        check("retried handoff succeeds", ReceiptDurability.finalizeBatch(lost, plan.resume.single(), "SMS", 1726000000002) != null)
    }

    // 6. Upgrade/edge state: a batch whose receipt already survived must be
    //    dropped, not re-finalized, so the console never gets a second batch
    //    of results from the same send.
    run {
        val store = FakeStore()
        val batch = sampleBatch()
        ReceiptDurability.persistBatch(store, batch)
        ReceiptDurability.enqueueReceipt(
            store,
            PendingReceipt(batch.sendId, batch.incidentId!!, "SMS", 1726000000000, batch.results()),
        )
        val plan = ReceiptDurability.planRecovery(store)
        check("batch with receipt is not resumed", plan.resume.isEmpty())
        check("batch with receipt is dropped", plan.dropSendIds == listOf(batch.sendId))
        check("recovery drop commits", ReceiptDurability.applyRecoveryDrops(store, plan.dropSendIds))
        check("store clean after drop", ReceiptDurability.loadBatches(store).isEmpty())
        check("receipt survives the drop", ReceiptDurability.loadReceipts(store).size == 1)
    }

    // 7. Re-queue guard: an incident with an unfinished batch (persisted or
    //    live) must not be re-fetched for re-send; a finalized one must.
    run {
        val store = FakeStore()
        ReceiptDurability.persistBatch(store, sampleBatch(sendId = "inc-a", incidentId = "inc-a"))
        val deferred = ReceiptDurability.deferRequeueIncidentIds(store, liveIncidentIds = setOf("inc-b"), channel = "SMS")
        check("persisted unfinished incident guarded", "inc-a" in deferred)
        check("live unfinished incident guarded", "inc-b" in deferred)
        check("finished incident not guarded", "inc-c" !in deferred)
        check("offline batch (no incident) guards nothing", run {
            val offline = FakeStore()
            ReceiptDurability.persistBatch(offline, sampleBatch(sendId = "offline-1", incidentId = null))
            ReceiptDurability.deferRequeueIncidentIds(offline, emptySet(), "SMS").isEmpty()
        })
    }

    // 8. Receipt lifecycle: enqueue replaces by receiptId (no duplicates on
    //    replay), ack removes only the accepted receipt.
    run {
        val store = FakeStore()
        val first = PendingReceipt("r-1", "inc-1", "SMS", 1, listOf(Triple("+15551234567", true, null)))
        val retried = first.copy(queuedAtMs = 2)
        ReceiptDurability.enqueueReceipt(store, first)
        ReceiptDurability.enqueueReceipt(store, retried)
        ReceiptDurability.enqueueReceipt(store, PendingReceipt("r-2", "inc-2", "WHATSAPP", 3, emptyList()))
        check("re-enqueue replaces", ReceiptDurability.loadReceipts(store).count { it.receiptId == "r-1" } == 1)
        check("re-enqueue kept latest", ReceiptDurability.loadReceipts(store).single { it.receiptId == "r-1" }.queuedAtMs == 2L)
        check("ack removes only accepted", ReceiptDurability.ackReceipt(store, "r-1"))
        val remaining = ReceiptDurability.loadReceipts(store)
        check("other receipt survives ack", remaining.single().receiptId == "r-2")
    }

    // 9. Offline batch (no incident): finalize cannot make a receipt and must
    //    leave the batch for the caller to drop explicitly.
    run {
        val store = FakeStore()
        val batch = sampleBatch(sendId = "offline-9", incidentId = null)
        ReceiptDurability.persistBatch(store, batch)
        check("offline finalize returns null", ReceiptDurability.finalizeBatch(store, batch, "SMS", 1) == null)
        check("offline batch still persisted", ReceiptDurability.loadBatches(store).containsKey("offline-9"))
        check("explicit drop works", ReceiptDurability.dropBatch(store, "offline-9"))
        check("offline batch gone after drop", ReceiptDurability.loadBatches(store).isEmpty())
    }

    // 10. Corrupt payloads decode to empty instead of crashing recovery.
    run {
        val store = FakeStore()
        store.data[ReceiptDurability.BATCHES_KEY] = "{not json"
        store.data[ReceiptDurability.RECEIPTS_KEY] = "[{broken"
        check("corrupt batches decode empty", ReceiptDurability.loadBatches(store).isEmpty())
        check("corrupt receipts decode empty", ReceiptDurability.loadReceipts(store).isEmpty())
    }

    // 11. Dispatch planning: the roster covers EVERY responder before any
    //     SMS goes out — recipients are split between parts and pre-send
    //     failures exactly once.
    run {
        val responders = listOf("+15550001111", "+15550002222", "+15550003333")
        val roster = ReceiptDurability.planDispatch(responders) { recipient ->
            if (recipient == "+15550002222") null else listOf("part-1", "part-2") // divide fails for one
        }
        check("every responder planned", roster.partsByRecipient.keys + roster.failures.keys == responders.toSet())
        check("divide failure recorded", roster.failures == mapOf("+15550002222" to "DIVIDE_FAILED"))
        val batch = roster.toPendingBatch("inc-d", "inc-d")
        check("roster batch counts parts", batch.remainingByRecipient["+15550001111"] == 2)
        check("roster batch zeroes failures", batch.remainingByRecipient["+15550002222"] == 0)
        check("roster batch covers all", batch.remainingByRecipient.keys == responders.toSet())
    }

    // 12. Process death mid-dispatch: the batch was persisted with the FULL
    //     roster before the first SMS went out, so even though only the first
    //     responder's radio result landed, recovery can never produce an
    //     all-success receipt for a partially attempted roster.
    run {
        val store = FakeStore()
        val responders = listOf("+15550001111", "+15550002222", "+15550003333")
        val roster = ReceiptDurability.planDispatch(responders) { listOf("only-part") }
        val batch = roster.toPendingBatch("inc-e", "inc-e")
        check("full roster persisted before send", ReceiptDurability.persistBatch(store, batch))
        // first responder's radio result lands; process dies before the rest
        // of the send loop runs
        val afterFirstResult = batch.copy(
            remainingByRecipient = batch.remainingByRecipient + ("+15550001111" to 0),
        )
        ReceiptDurability.persistBatch(store, afterFirstResult)
        // crash; recovery resumes the batch with the complete roster
        val plan = ReceiptDurability.planRecovery(store)
        check("mid-dispatch batch resumes in full", plan.resume.single().remainingByRecipient.keys == responders.toSet())
        // the watchdog finalizes the unconfirmed responders as failures
        val finalized = plan.resume.single().copy(
            remainingByRecipient = plan.resume.single().remainingByRecipient.mapValues { 0 },
            failures = mapOf(
                "+15550002222" to "NO_RADIO_RESULT",
                "+15550003333" to "NO_RADIO_RESULT",
            ),
        )
        val receipt = ReceiptDurability.finalizeBatch(store, finalized, "SMS", 1726000000003)
        check("mid-dispatch receipt covers every responder", receipt?.results?.size == 3)
        check(
            "mid-dispatch receipt is not all-success",
            receipt?.results?.count { it.second } == 1,
            receipt?.results.toString(),
        )
    }

    // 13. Initial persist failure: the write reports failure and leaves the
    //     store untouched, which is what makes the sender's abort-before-send
    //     safe to rely on.
    run {
        val store = FakeStore()
        store.failTransactions = true
        val batch = sampleBatch()
        check("failed initial persist reports false", !ReceiptDurability.persistBatch(store, batch))
        check("failed initial persist stored nothing", store.data.isEmpty())
        check("recovery sees nothing after failed persist", ReceiptDurability.planRecovery(store).resume.isEmpty())
    }

    // 14. Regression: the batch is finalized (SMS delivered, receipt
    //     persisted) but the console has NOT accepted the receipt yet — the
    //     POST failed or is still in flight, so device-pending still lists
    //     the incident. The re-queue guard must keep deferring it until the
    //     receipt is accepted, or the handset would double-text responders.
    run {
        val store = FakeStore()
        val batch = sampleBatch(sendId = "inc-f", incidentId = "inc-f")
        ReceiptDurability.persistBatch(store, batch)
        val receipt = ReceiptDurability.finalizeBatch(store, batch, "SMS", 1726000000004)
        check("handoff produced a receipt", receipt != null)
        // The window: no batch anywhere (live map empty after finalize,
        // persisted record atomically dropped), receipt still unaccepted.
        check("batch guard alone no longer applies", ReceiptDurability.loadBatches(store).isEmpty())
        val deferred = ReceiptDurability.deferRequeueIncidentIds(store, liveIncidentIds = emptySet(), channel = "SMS")
        check("pending receipt still defers re-queue", "inc-f" in deferred)
        // ...and the deferral survives a process restart mid-POST.
        val deferredAfterRestart = ReceiptDurability.deferRequeueIncidentIds(store, liveIncidentIds = emptySet(), channel = "SMS")
        check("deferral survives restart mid-post", "inc-f" in deferredAfterRestart)
        // Other channels' pending receipts must not block SMS re-sends.
        ReceiptDurability.enqueueReceipt(store, PendingReceipt("wa-1", "inc-wa", "WHATSAPP", 1, emptyList()))
        check(
            "whatsapp receipt does not block sms",
            "inc-wa" !in ReceiptDurability.deferRequeueIncidentIds(store, emptySet(), "SMS"),
        )
        // Only acceptance (ack) releases the incident.
        ReceiptDurability.ackReceipt(store, "inc-f")
        check(
            "accepted receipt releases the incident",
            "inc-f" !in ReceiptDurability.deferRequeueIncidentIds(store, emptySet(), "SMS"),
        )
    }

    if (failures > 0) {
        println("RECEIPT_DURABILITY_FAILED failures=$failures checks=$checks")
        kotlin.system.exitProcess(1)
    }
    println("RECEIPT_DURABILITY_OK checks=$checks")
}
