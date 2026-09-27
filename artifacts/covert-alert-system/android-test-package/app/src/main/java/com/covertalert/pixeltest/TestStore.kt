package com.covertalert.pixeltest

import android.content.Context
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject

/** Device-local, non-networked journal for the disposable hardware run. */
object TestStore {
    private const val PREFS = "gate0a-local-journal"
    private const val EVENTS = "events"
    private const val COVER_PACKAGE = "cover_package"
    private const val ALERT_SERVER_URL = "alert_server_url"
    private const val SMS_RESPONDERS = "sms_responders"
    private const val DEVICE_TOKEN = "device_access_token"
    private const val ALERT_TOKEN = "alert_token"
    private const val ENROLLED_DEVICE_TOKEN = "enrolled_device_token"
    private const val DEVICE_CREDENTIAL_PROVISIONED = "device_credential_provisioned"

    /**
     * Shared handset credential (X-CAS-Device-Token) for the console's
     * device pickup/receipt endpoints; must match the server's
     * CAS_DEVICE_TOKEN secret or those calls are refused (401).
     */
    fun setDeviceToken(context: Context, value: String) =
        storage(context).edit().putString(DEVICE_TOKEN, value.trim()).apply()

    fun deviceToken(context: Context): String =
        storage(context).getString(DEVICE_TOKEN, "").orEmpty()

    fun setAlertServerUrl(context: Context, value: String) =
        storage(context).edit().putString(ALERT_SERVER_URL, value.trim()).apply()

    fun alertServerUrl(context: Context): String =
        storage(context).getString(ALERT_SERVER_URL, "").orEmpty()

    fun setSmsResponders(context: Context, value: String) =
        storage(context).edit().putString(SMS_RESPONDERS, value.trim()).apply()

    /** Responder numbers for device-direct SMS, configured on the handset. */
    fun smsResponders(context: Context): List<String> =
        storage(context).getString(SMS_RESPONDERS, "").orEmpty()
            .split(",").map { it.trim() }.filter { it.isNotBlank() }

    // The enrollment credential (the server's CAS_ALERT_TOKEN secret). The
    // app exchanges it once at the enrollment endpoint for this handset's
    // own revocable device credential (below) and never presents it on
    // trigger calls directly. Kept in device-protected storage and never
    // written to the journal or report.
    fun setAlertToken(context: Context, value: String) =
        storage(context).edit().putString(ALERT_TOKEN, value.trim()).apply()

    fun alertToken(context: Context): String =
        storage(context).getString(ALERT_TOKEN, "").orEmpty()

    /**
     * This handset's enrolled device credential, issued once by the server's
     * enrollment endpoint in exchange for the enrollment credential above
     * and presented as Authorization: Bearer on trigger calls. Revocable per
     * device without rotating anything else; cleared whenever the enrollment
     * credential changes so the next trigger re-enrolls. Never written to
     * the journal or report.
     */
    fun setEnrolledDeviceToken(context: Context, value: String) =
        storage(context).edit().putString(ENROLLED_DEVICE_TOKEN, value.trim()).apply()

    fun enrolledDeviceToken(context: Context): String =
        storage(context).getString(ENROLLED_DEVICE_TOKEN, "").orEmpty()

    /**
     * True once this handset has completed enrollment. A provisioned handset
     * never falls back to the shared device token: if its enrolled credential
     * is rejected (revoked or unknown), pickup and receipt calls stop until
     * the operator re-enters the enrollment credential — a legacy-token
     * fallback would let a revoked phone keep mutating delivery state. Reset
     * only when the operator saves a different enrollment credential (a
     * deliberate re-enrollment).
     */
    fun setDeviceCredentialProvisioned(context: Context, value: Boolean) =
        storage(context).edit().putBoolean(DEVICE_CREDENTIAL_PROVISIONED, value).apply()

    fun deviceCredentialProvisioned(context: Context): Boolean =
        storage(context).getBoolean(DEVICE_CREDENTIAL_PROVISIONED, false)

    fun setCoverPackage(context: Context, value: String) =
        storage(context).edit().putString(COVER_PACKAGE, value.trim()).apply()

    fun coverPackage(context: Context): String =
        storage(context).getString(COVER_PACKAGE, "").orEmpty()

    // MVP alert sends happen on a worker thread while UI/receiver writes can race
    // on the main thread; the journal is a single JSON document, so serialize it.
    @Synchronized
    fun record(context: Context, type: String, fields: Map<String, Any?> = emptyMap()) {
        val prefs = storage(context)
        val event = JSONObject().put("type", type)
            .put("wallClockMs", System.currentTimeMillis())
            .put("elapsedRealtimeMs", SystemClock.elapsedRealtime())
        fields.forEach { (key, value) -> event.put(key, value ?: JSONObject.NULL) }
        val events = runCatching { JSONArray(prefs.getString(EVENTS, "[]")) }.getOrDefault(JSONArray())
        events.put(event)
        prefs.edit().putString(EVENTS, events.toString()).apply()
    }

    fun events(context: Context): JSONArray =
        runCatching { JSONArray(storage(context).getString(EVENTS, "[]")) }
            .getOrDefault(JSONArray())

    /**
     * Durable backing for the device-direct receipt queue (unfinished SMS
     * batches and not-yet-accepted receipts). Unlike the journal above, every
     * write goes through commit(): these records must reach disk
     * synchronously, because the SMS may leave the SIM — or the in-memory
     * batch be dropped — immediately after the write returns. All decision
     * logic lives in the android-free ReceiptDurability core so the
     * process-death windows are testable on the JVM
     * (scripts/test-receipt-durability.sh).
     */
    fun receiptStore(context: Context): ReceiptStore {
        val prefs = storage(context)
        return object : ReceiptStore {
            override fun read(key: String): String? = prefs.getString(key, null)
            override fun transact(puts: Map<String, String>, removes: Set<String>): Boolean {
                val editor = prefs.edit()
                puts.forEach { (key, value) -> editor.putString(key, value) }
                removes.forEach { editor.remove(it) }
                return editor.commit()
            }
        }
    }

    /**
     * Clears the journal and test configuration for a fresh hardware run, but
     * preserves the durable receipt queue (unfinished batches and
     * not-yet-accepted receipts): wiping those could silently strand a
     * console item QUEUED or enable a duplicate re-send of an SMS that
     * already left the SIM.
     */
    fun clear(context: Context) {
        val prefs = storage(context)
        val preservedBatches = prefs.getString(ReceiptDurability.BATCHES_KEY, null)
        val preservedReceipts = prefs.getString(ReceiptDurability.RECEIPTS_KEY, null)
        val editor = prefs.edit().clear()
        if (preservedBatches != null) editor.putString(ReceiptDurability.BATCHES_KEY, preservedBatches)
        if (preservedReceipts != null) editor.putString(ReceiptDurability.RECEIPTS_KEY, preservedReceipts)
        editor.commit()
    }

    private fun storage(context: Context) =
        context.createDeviceProtectedStorageContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}