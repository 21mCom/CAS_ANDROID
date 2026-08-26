package com.covertalert.pixeltest

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Gate 0A proxy: records before forwarding to the selected app's normal launcher intent.
 * It intentionally does not start services, send messages, capture evidence, or access location.
 */
class TriggerActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val selected = TestStore.coverPackage(this)
        val launch = packageManager.getLaunchIntentForPackage(selected)
        TestStore.record(this, "PROXY_TRIGGER", mapOf(
            "coverPackage" to selected,
            "coverConfigured" to selected.isNotBlank(),
            "coverIntentAvailable" to (launch != null),
            "activityState" to if (state == null) "cold" else "warm"
        ))
        if (launch == null) {
            TestStore.record(this, "COVER_LAUNCH_OUTCOME", mapOf("outcome" to "NOT_LAUNCHED", "reason" to "No selected cover launcher intent"))
        } else {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val started = runCatching { startActivity(launch); true }.getOrDefault(false)
            TestStore.record(this, "COVER_LAUNCH_OUTCOME", mapOf("outcome" to if (started) "STARTED" else "FAILED", "coverPackage" to selected))
        }
        finish()
    }
}