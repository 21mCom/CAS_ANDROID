package com.covertalert.pixeltest

/**
 * Prints byte-exact durable-store fixtures produced by the production
 * ReceiptDurability encoders, for the emulator kill harness's seeded
 * scenarios (.github/scripts/verify-receipt-durability-kill.sh, scenarios
 * B/C). Routing the fixtures through the real encoder keeps the seeded
 * records in lockstep with the app's on-disk format — when a field is added
 * (as cycleToken was with delivery-cycle tokens) the fixtures change with it
 * instead of silently drifting into legacy-decoding territory.
 *
 * Compiled and run by the kill harness with the same pinned kotlinc/org.json
 * toolchain as scripts/test-receipt-durability.sh.
 *
 * Usage: SeedFixtureGeneratorKt batch <incidentId>
 *        SeedFixtureGeneratorKt receipt <incidentId> <queuedAtMs>
 */
fun main(args: Array<String>) {
    require(args.size >= 2) { "usage: batch <incidentId> | receipt <incidentId> <queuedAtMs>" }
    val incidentId = args[1]
    when (args[0]) {
        // The exact record persistBatch writes for one recipient with one
        // part still awaiting a radio result (kill mid-dispatch).
        "batch" -> print(
            ReceiptDurability.encodeBatches(
                mapOf(
                    "seed-$incidentId" to PendingBatch(
                        sendId = "seed-$incidentId",
                        incidentId = incidentId,
                        remainingByRecipient = mapOf("+15550100" to 1),
                        failures = emptyMap(),
                    ),
                ),
            ),
        )
        // The receipt an all-success batch would have persisted.
        "receipt" -> {
            require(args.size >= 3) { "receipt mode needs <queuedAtMs>" }
            print(
                ReceiptDurability.encodeReceipts(
                    listOf(
                        PendingReceipt(
                            receiptId = "seed-$incidentId",
                            incidentId = incidentId,
                            channel = "SMS",
                            queuedAtMs = args[2].toLong(),
                            results = listOf(Triple("+15550100", true, null)),
                        ),
                    ),
                ),
            )
        }
        else -> error("unknown mode ${args[0]}")
    }
}
