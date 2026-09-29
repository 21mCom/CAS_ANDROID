package com.covertalert.pixeltest

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller

/**
 * Receives the PackageInstaller commit result for a self-update. The only
 * visible UI this ever surfaces is the system's own install confirmation
 * (the one-tap prompt), and only when the OS fills in EXTRA_INTENT asking
 * for it — that handoff is the sanctioned update-flow exception to the
 * silent-channel rule (no alert path is involved; the flow starts from the
 * operator's Download & install tap on the configuration screen).
 */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    // The system's own install confirmation — the one tap.
                    context.startActivity(confirm)
                    TestStore.record(context, "UPDATE_INSTALL", mapOf("outcome" to "CONFIRM_PROMPT_SHOWN"))
                } else {
                    TestStore.record(context, "UPDATE_INSTALL", mapOf("outcome" to "FAILED", "detail" to "system asked for user action but supplied no confirmation intent"))
                }
            }
            PackageInstaller.STATUS_SUCCESS ->
                TestStore.record(context, "UPDATE_INSTALL", mapOf("outcome" to "INSTALLED"))
            else ->
                TestStore.record(context, "UPDATE_INSTALL", mapOf(
                    "outcome" to "FAILED",
                    "status" to status,
                    "detail" to message,
                ))
        }
    }
}
