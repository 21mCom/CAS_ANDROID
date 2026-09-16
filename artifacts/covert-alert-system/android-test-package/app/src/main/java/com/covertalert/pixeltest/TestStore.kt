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
    private const val WHATSAPP_ENABLED = "whatsapp_enabled"
    private const val DEVICE_TOKEN = "device_access_token"

    /** Whether alerts also hand off to WhatsApp (tap-to-send) after the SMS. */
    fun setWhatsAppEnabled(context: Context, enabled: Boolean) =
        storage(context).edit().putBoolean(WHATSAPP_ENABLED, enabled).apply()

    fun whatsAppEnabled(context: Context): Boolean =
        storage(context).getBoolean(WHATSAPP_ENABLED, false)

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

    fun clear(context: Context) = storage(context).edit().clear().apply()

    private fun storage(context: Context) =
        context.createDeviceProtectedStorageContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}