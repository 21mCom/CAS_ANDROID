package com.covertalert.pixeltest

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.json.JSONObject

/**
 * Device-direct WhatsApp alerting. The free WhatsApp app exposes no
 * unattended-send API (that requires the paid WhatsApp Business Platform),
 * so this opens each responder's WhatsApp chat with the alert text
 * pre-filled and the operator taps send in each chat. The console's WHATSAPP
 * outbox item is then marked from the receipt posted after the handoff;
 * SENT there means "handed to WhatsApp", not delivery-confirmed — the
 * journal wording on the console says the same.
 *
 * Package visibility for com.whatsapp is declared in the manifest; without
 * it isInstalled() would always report false on Android 11+.
 */
object WhatsAppAlerter {

    fun isInstalled(context: Context): Boolean =
        runCatching { context.packageManager.getPackageInfo("com.whatsapp", 0) }.isSuccess

    /**
     * Opens a WhatsApp chat per responder with the alert pre-filled, then
     * reports the handoff outcome to the console's device-receipt endpoint.
     * Returns a human-readable start outcome for the journal.
     */
    fun sendAlert(context: Context, incidentId: String?, body: String, cycleToken: String? = null): String {
        val responders = TestStore.smsResponders(context)
        if (responders.isEmpty()) return "no responder numbers configured"
        if (!isInstalled(context)) {
            reportOutcome(context, incidentId, responders.map { Triple(it, false, "WHATSAPP_NOT_INSTALLED") }, cycleToken)
            return "WhatsApp not installed on this handset"
        }
        val results: List<Triple<String, Boolean, String?>> = responders.map { recipient ->
            val digits = recipient.filter { it.isDigit() }
            when {
                digits.length < 5 -> Triple(recipient, false, "INVALID_NUMBER")
                else -> {
                    // wa.me deep-link into the official app with the alert
                    // pre-filled; setPackage keeps the intent out of browsers
                    // and other handlers.
                    val intent = Intent(
                        Intent.ACTION_VIEW,
                        Uri.parse("https://wa.me/$digits?text=${Uri.encode(body)}"),
                    ).setPackage("com.whatsapp").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { context.startActivity(intent) }.fold(
                        onSuccess = { Triple(recipient, true, null) },
                        onFailure = { Triple(recipient, false, "HANDOFF_FAILED") },
                    )
                }
            }
        }
        reportOutcome(context, incidentId, results, cycleToken)
        val handed = results.count { it.second }
        return "handed to WhatsApp for $handed of ${responders.size} responder(s); tap send in each chat"
    }

    /**
     * Picks up re-queued WHATSAPP deliveries from the console's
     * device-pending list and hands them to WhatsApp again. SMS items on the
     * same list are DeviceSmsSender's job.
     */
    fun sendRequeued(context: Context): String {
        val items = DeviceSmsSender.fetchPendingItems(context)
            ?: return "device-pending check failed (see REQUEUE_CHECK_OUTCOME)"
        val whatsappItems = items.filter { it.transport == "WHATSAPP" }
        for (item in whatsappItems) {
            // Echo the delivery-cycle token so the console can reject a stale
            // receipt of a superseded batch instead of marking the item SENT.
            sendAlert(context, item.incidentId, DeviceSmsSender.alertBody(item.incidentId), item.cycleToken)
        }
        TestStore.record(context, "WHATSAPP_REQUEUE_OUTCOME", mapOf("pickedUp" to whatsappItems.size))
        return "picked up ${whatsappItems.size} re-queued WhatsApp deliver${if (whatsappItems.size == 1) "y" else "ies"}"
    }

    private fun reportOutcome(context: Context, incidentId: String?, results: List<Triple<String, Boolean, String?>>, cycleToken: String? = null) {
        TestStore.record(context, "WHATSAPP_SEND_OUTCOME", mapOf(
            "incidentId" to (incidentId ?: JSONObject.NULL),
            "responders" to results.size,
            "handedOff" to results.count { it.second },
            "failures" to results.filter { !it.second }
                .joinToString("; ") { "${it.third} (${mask(it.first)})" },
        ))
        // No incident (console unreachable at trigger time) means there is no
        // outbox item to report against; the WhatsApp handoff still happened.
        if (incidentId == null) return
        DeviceSmsSender.reportChannelOutcome(context, incidentId, "WHATSAPP", results, cycleToken = cycleToken)
    }

    private fun mask(recipient: String): String {
        val digits = recipient.filter { it.isDigit() }
        return if (digits.length >= 2) "•••${digits.takeLast(2)}" else "•••"
    }
}
