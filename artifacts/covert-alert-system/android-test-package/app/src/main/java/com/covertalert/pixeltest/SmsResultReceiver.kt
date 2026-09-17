package com.covertalert.pixeltest

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Receives per-part SMS sent results for device-direct alerts and forwards
 * them to DeviceSmsSender's batch tracker. Not exported: only this app's own
 * PendingIntents may deliver results.
 */
class SmsResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != DeviceSmsSender.ACTION_SMS_SENT) return
        val sendId = intent.getStringExtra(DeviceSmsSender.EXTRA_SEND_ID) ?: return
        val recipient = intent.getStringExtra(DeviceSmsSender.EXTRA_RECIPIENT) ?: return
        DeviceSmsSender.onSendResult(context, sendId, recipient, resultCode)
    }
}
