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

    fun setAlertServerUrl(context: Context, value: String) =
        storage(context).edit().putString(ALERT_SERVER_URL, value.trim()).apply()

    fun alertServerUrl(context: Context): String =
        storage(context).getString(ALERT_SERVER_URL, "").orEmpty()

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