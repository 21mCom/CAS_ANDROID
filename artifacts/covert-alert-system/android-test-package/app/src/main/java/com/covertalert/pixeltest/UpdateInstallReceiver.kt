package com.covertalert.pixeltest

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import java.io.File

/**
 * Receives the PackageInstaller commit result for a self-update. The only
 * visible UI this ever surfaces is the system's own install confirmation
 * (the one-tap prompt), and only when the OS fills in EXTRA_INTENT asking
 * for it — that handoff is the sanctioned update-flow exception to the
 * silent-channel rule (no alert path is involved; the flow starts from the
 * operator's Download & install tap on the configuration screen).
 *
 * Post-permission-grant race: when the owner grants "Install unknown apps"
 * and immediately confirms the first update, the AppOps grant can lag the
 * verifier, so the first commit comes back INSTALL_FAILED_VERIFICATION_FAILURE
 * even though everything is in order (observed in the first physical-Pixel
 * field journal, where an identical manual retry installed cleanly). The
 * receiver detects exactly that refusal and re-hands the same verified APK
 * to the installer itself after a short settle delay — bounded by
 * UpdateCheck.INSTALL_MAX_ATTEMPTS — so the one-tap promise holds on the
 * first try. Every retry is journaled.
 */
class UpdateInstallReceiver : BroadcastReceiver() {

    companion object {
        const val EXTRA_APK_PATH = "com.covertalert.pixeltest.extra.APK_PATH"
        const val EXTRA_ATTEMPT = "com.covertalert.pixeltest.extra.INSTALL_ATTEMPT"
    }

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
            else -> {
                val attempt = intent.getIntExtra(EXTRA_ATTEMPT, 1)
                val apkPath = intent.getStringExtra(EXTRA_APK_PATH).orEmpty()
                val apk = File(apkPath)
                if (UpdateCheck.shouldRetryInstall(message, attempt) && apk.isFile) {
                    // The grant is in place but the verifier has not caught
                    // up: wait for it to settle and hand off the SAME
                    // already-verified file again — no re-download, no
                    // second owner tap. Any other failure is terminal.
                    TestStore.record(context, "UPDATE_INSTALL", mapOf(
                        "outcome" to "RETRY_SCHEDULED",
                        "attempt" to attempt,
                        "detail" to "post-grant verification race — retrying the handoff in ${UpdateCheck.INSTALL_RETRY_DELAY_MS}ms ($message)",
                    ))
                    val appContext = context.applicationContext
                    val pending = goAsync()
                    Thread {
                        try {
                            Thread.sleep(UpdateCheck.INSTALL_RETRY_DELAY_MS)
                            val handoff = UpdateManager.install(appContext, apk, attempt + 1)
                            if (UpdateCheck.isHandoffAccepted(handoff)) {
                                // Committed — the outcome now arrives as the
                                // next UPDATE_INSTALL callback.
                                TestStore.record(appContext, "UPDATE_INSTALL", mapOf(
                                    "outcome" to "RETRY_HANDOFF",
                                    "attempt" to attempt + 1,
                                    "detail" to handoff,
                                ))
                            } else {
                                // No session was committed (blocked or threw),
                                // so no further callback is coming — record
                                // the terminal failure here or the journal
                                // would end on a retry that went nowhere.
                                TestStore.record(appContext, "UPDATE_INSTALL", mapOf(
                                    "outcome" to "FAILED",
                                    "attempt" to attempt + 1,
                                    "detail" to "automatic retry handoff failed: $handoff",
                                ))
                            }
                        } finally {
                            pending.finish()
                        }
                    }.start()
                    return
                }
                TestStore.record(context, "UPDATE_INSTALL", mapOf(
                    "outcome" to "FAILED",
                    "status" to status,
                    "detail" to message,
                ))
            }
        }
    }
}
