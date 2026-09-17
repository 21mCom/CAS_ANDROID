package com.covertalert.pixeltest

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle

/**
 * Headless entry point for the device-direct SMS flow (trigger -> send ->
 * receipt -> re-queue pickup), driven by the emulator CI job
 * (.github/workflows/android-test-package-build.yml, job sms-receipt-flow-test)
 * through .github/scripts/verify-sms-flow.sh. The interactive MainActivity
 * buttons drive the same code paths by hand on the field Pixel; this activity
 * exists so an emulator can drive them without UI taps:
 *
 *   adb shell am start -n com.covertalert.pixeltest/.SmsFlowActivity \
 *     --es mode alert|requeue \
 *     --es serverUrl http://127.0.0.1:<port> \
 *     --es deviceToken <shared CAS_DEVICE_TOKEN> \
 *     --es alertToken <shared CAS_ALERT_TOKEN> \
 *     --es responders "+15551234567"
 *
 * (the harness tunnels the runner's dev API into the device with
 * `adb reverse`, so 127.0.0.1:<port> works on emulators and USB devices)
 *
 * SECURITY: this activity lives in the debug source set and is
 * android:exported="false". Other apps cannot start it, and on API 35 the
 * plain adb shell user cannot either — the harness runs `adb root` first
 * (root is exempt from the exported check). It accepts caller-controlled
 * responder numbers and its requeue mode reuses the stored device
 * credential — it must never be exported or shipped in a release build, or
 * any installed app could make this handset send arbitrary SMS and misreport
 * deliveries.
 *
 * Provided extras are persisted to TestStore before the mode runs, so the
 * harness can swap the responder list between the alert phase (deliberately
 * broken number -> console DEAD_LETTER) and the re-queue phase (fixed number
 * -> console SENT). All outcomes land in the on-device journal as SMS_FLOW_*
 * events, which the harness reads for evidence; the durable assertion is the
 * console's outbox state observed through the API.
 */
class SmsFlowActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val extras = intent.extras
        extras?.getString("serverUrl")?.let { TestStore.setAlertServerUrl(this, it) }
        extras?.getString("deviceToken")?.let { TestStore.setDeviceToken(this, it) }
        extras?.getString("alertToken")?.let { TestStore.setAlertToken(this, it) }
        extras?.getString("responders")?.let { TestStore.setSmsResponders(this, it) }
        val mode = extras?.getString("mode").orEmpty()
        TestStore.record(this, "SMS_FLOW_INVOKED", mapOf(
            "mode" to mode,
            "serverConfigured" to TestStore.alertServerUrl(this).isNotBlank(),
            "devLoopback" to TestStore.alertServerUrl(this).let {
                it.startsWith("http://127.0.0.1") || it.startsWith("http://10.0.2.2")
            },
            "tokenConfigured" to TestStore.deviceToken(this).isNotBlank(),
            "alertTokenConfigured" to TestStore.alertToken(this).isNotBlank(),
            "responders" to TestStore.smsResponders(this).size,
        ))
        when (mode) {
            "alert" -> runAlert()
            "requeue" -> runRequeue()
            else -> TestStore.record(this, "SMS_FLOW_OUTCOME", mapOf(
                "outcome" to "FAILED",
                "reason" to "unknown or missing mode extra",
            ))
        }
        // The work continues on background threads and via the SmsResultReceiver
        // broadcasts; finishing here does not stop either.
        finish()
    }

    /** Mirrors MainActivity.sendMvpAlert's SMS path: trigger, then text from the SIM. */
    private fun runAlert() {
        if (checkSelfPermission(android.Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            TestStore.record(this, "SMS_FLOW_OUTCOME", mapOf(
                "outcome" to "NOT_SENT",
                "reason" to "SEND_SMS permission not granted",
            ))
            return
        }
        if (TestStore.smsResponders(this).isEmpty()) {
            TestStore.record(this, "SMS_FLOW_OUTCOME", mapOf(
                "outcome" to "NOT_SENT",
                "reason" to "no responder numbers configured",
            ))
            return
        }
        Thread {
            val baseUrl = TestStore.alertServerUrl(this)
            val alertToken = TestStore.alertToken(this)
            if (baseUrl.isBlank()) {
                // Same no-data fallback as the MVP button: the SMS still leaves.
                TestStore.record(this, "SMS_FLOW_TRIGGER_OUTCOME", mapOf(
                    "outcome" to "SKIPPED",
                    "reason" to "no server URL configured",
                ))
                sendSms(null)
            } else if (alertToken.isBlank()) {
                // The trigger endpoint rejects unauthenticated calls (401);
                // without the credential no incident can be committed, but
                // the alert still leaves this handset directly.
                TestStore.record(this, "SMS_FLOW_TRIGGER_OUTCOME", mapOf(
                    "outcome" to "NOT_SENT",
                    "reason" to "no alert credential configured; the server would reject the trigger with 401",
                ))
                sendSms(null)
            } else {
                val result = AlertSender.trigger(this, baseUrl, alertToken)
                TestStore.record(this, "SMS_FLOW_TRIGGER_OUTCOME", mapOf(
                    "outcome" to if (result.ok) "SENT" else "FAILED",
                    "detail" to result.detail,
                    "reused" to result.reused,
                ))
                if (result.ok && result.reused) {
                    // The trigger folded into the still-active incident and the
                    // console queued nothing new, so the handset must not
                    // re-send physical messages either.
                    TestStore.record(this, "SMS_FLOW_OUTCOME", mapOf("outcome" to "FOLDED_INTO_ACTIVE"))
                } else {
                    sendSms(if (result.ok) result.incidentId else null)
                }
            }
        }.start()
    }

    /** Mirrors MainActivity's "Check re-queued deliveries" button (SMS only). */
    private fun runRequeue() {
        Thread {
            val outcome = DeviceSmsSender.sendRequeued(this)
            TestStore.record(this, "SMS_FLOW_REQUEUE_OUTCOME", mapOf("detail" to outcome))
        }.start()
    }

    private fun sendSms(incidentId: String?) {
        val outcome = DeviceSmsSender.sendAlert(this, incidentId, DeviceSmsSender.alertBody(incidentId))
        TestStore.record(this, "SMS_FLOW_SMS_START", mapOf(
            "incidentId" to (incidentId ?: "offline"),
            "detail" to outcome,
        ))
    }
}
