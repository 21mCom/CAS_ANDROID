package com.covertalert.pixeltest

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        TestStore.record(context, "BOOT_OBSERVED", mapOf("action" to intent.action, "directBootAware" to true))
    }
}