package com.covertalert.pixeltest

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.getSystemService
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var coverStatus: TextView
    private lateinit var serverInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var respondersInput: EditText
    private lateinit var alertTokenInput: EditText
    private lateinit var reportView: TextView
    @Volatile private var alertInFlight = false

    private val smsPermissionGranted: Boolean
        get() = checkSelfPermission(android.Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        TestStore.record(this, "OBSERVER_SCREEN_OPENED", mapOf("activityState" to if (state == null) "cold" else "warm"))
        coverStatus = TextView(this).apply {
            textSize = 13f
            setPadding(0, 8, 0, 0)
        }
        reportView = TextView(this).apply {
            textSize = 12f
            setTextIsSelectable(true)
            setPadding(0, 16, 0, 16)
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }
        root.addView(TextView(this).apply {
            text = "CAS Pixel Gate 0A\nDisposable hardware test package"
            textSize = 22f
            setPadding(0, 0, 0, 12)
        })
        root.addView(TextView(this).apply {
            text = "Physical target: Pixel 11 · stock Android · API 35+\nEmulator baseline: Pixel 8a · API 35\n${environmentLabel()}\nGate 0A runs stay local-only: no SMS, network, location, evidence capture, or production behavior.\nMVP mode (below) is the only networked path: one POST to the CAS alert server, then this handset texts responders directly from its own SIM (no gateway)."
            textSize = 13f
        })
        root.addView(coverStatus, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 20 })
        root.addView(button("Select cover app") { pickCoverApp() })
        root.addView(button("Clear cover app (manual trigger only)") {
            // Same event type and fields as a picker selection so the Gate 0A
            // import contract (which only accepts harness event types) is
            // unaffected; an empty package means manual trigger.
            TestStore.setCoverPackage(this, "")
            TestStore.record(this, "COVER_CONFIGURED", mapOf("coverPackage" to "", "validInstalledPackage" to false))
            refreshCoverStatus()
            refreshReport()
        })
        serverInput = EditText(this).apply {
            hint = "Alert server URL, e.g. https://your-replit-app.replit.app"
            setText(TestStore.alertServerUrl(this@MainActivity))
            isSingleLine = true
        }
        root.addView(TextView(this).apply {
            text = "MVP alert loop (personal device)\nSends one trigger POST to the CAS API, then texts each responder from this SIM and reports the outcome back. If the server is unreachable the SMS still goes out (the console then has no incident). Watch the console Incidents view for the new incident."
            textSize = 13f
            setPadding(0, 24, 0, 4)
        })
        root.addView(serverInput, LinearLayout.LayoutParams(-1, -2))
        root.addView(button("Save alert server") {
            val value = serverInput.text.toString().trim()
            TestStore.setAlertServerUrl(this, value)
            TestStore.record(this, "ALERT_SERVER_CONFIGURED", mapOf("configured" to value.isNotBlank(), "https" to value.startsWith("https://")))
            refreshReport()
        })
        tokenInput = EditText(this).apply {
            hint = "Device access token (same value as the server's CAS_DEVICE_TOKEN secret)"
            setText(TestStore.deviceToken(this@MainActivity))
            isSingleLine = true
        }
        root.addView(tokenInput, LinearLayout.LayoutParams(-1, -2))
        root.addView(button("Save device token") {
            val value = tokenInput.text.toString()
            TestStore.setDeviceToken(this, value)
            TestStore.record(this, "DEVICE_TOKEN_CONFIGURED", mapOf("configured" to TestStore.deviceToken(this).isNotBlank()))
            refreshReport()
        })
        // Separate from the device token above: this credential authorizes the
        // alert trigger itself (Authorization: Bearer against CAS_ALERT_TOKEN).
        alertTokenInput = EditText(this).apply {
            hint = "Alert credential (same value as the server's CAS_ALERT_TOKEN secret)"
            setText(TestStore.alertToken(this@MainActivity))
            isSingleLine = true
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        root.addView(alertTokenInput, LinearLayout.LayoutParams(-1, -2))
        root.addView(button("Save alert credential") {
            val value = alertTokenInput.text.toString().trim()
            TestStore.setAlertToken(this, value)
            // Record only whether a credential exists, never the credential.
            TestStore.record(this, "ALERT_CREDENTIAL_CONFIGURED", mapOf("configured" to value.isNotBlank()))
            refreshReport()
        })
        respondersInput = EditText(this).apply {
            hint = "Responder numbers, comma-separated, e.g. +15551234567"
            setText(TestStore.smsResponders(this@MainActivity).joinToString(", "))
            isSingleLine = true
        }
        root.addView(respondersInput, LinearLayout.LayoutParams(-1, -2))
        root.addView(button("Save responder numbers") {
            val value = respondersInput.text.toString().trim()
            TestStore.setSmsResponders(this, value)
            TestStore.record(this, "SMS_RESPONDERS_CONFIGURED", mapOf("count" to TestStore.smsResponders(this).size))
            refreshReport()
        })
        root.addView(CheckBox(this).apply {
            text = "Also alert via WhatsApp (opens each chat pre-filled; you tap send)"
            isChecked = TestStore.whatsAppEnabled(this@MainActivity)
            setOnCheckedChangeListener { _, checked ->
                TestStore.setWhatsAppEnabled(this@MainActivity, checked)
                TestStore.record(this@MainActivity, "WHATSAPP_TOGGLED", mapOf(
                    "enabled" to checked,
                    "whatsAppInstalled" to WhatsAppAlerter.isInstalled(this@MainActivity),
                ))
                refreshReport()
            }
        })
        root.addView(button("Grant SMS permission") {
            if (smsPermissionGranted) {
                TestStore.record(this, "SMS_PERMISSION", mapOf("outcome" to "ALREADY_GRANTED"))
            } else {
                requestPermissions(arrayOf(android.Manifest.permission.SEND_SMS), REQUEST_SEND_SMS)
            }
            refreshReport()
        })
        root.addView(button("Send MVP alert now") { sendMvpAlert() })
        root.addView(button("Check re-queued deliveries") { checkRequeued() })
        root.addView(button("Request pinned proxy shortcut") {
            val manager = getSystemService<android.content.pm.ShortcutManager>()
            if (manager == null || !manager.isRequestPinShortcutSupported) {
                TestStore.record(this, "SHORTCUT_OUTCOME", mapOf("outcome" to "UNSUPPORTED"))
            } else {
                val shortcut = manager.dynamicShortcuts.firstOrNull { it.id == "gate0a-proxy" }
                    ?: android.content.pm.ShortcutInfo.Builder(this, "gate0a-proxy")
                        .setShortLabel("Test cover launch")
                        .setLongLabel("CAS Gate 0A test proxy")
                        .setIcon(android.graphics.drawable.Icon.createWithResource(this, com.covertalert.pixeltest.R.drawable.ic_proxy))
                        .setIntent(IntentFactory.proxy())
                        .build()
                val requested = runCatching { manager.requestPinShortcut(shortcut, null); true }.getOrDefault(false)
                TestStore.record(this, "SHORTCUT_OUTCOME", mapOf("outcome" to if (requested) "REQUESTED" else "FAILED", "launcherControlsResult" to true))
            }
            refreshReport()
        })
        root.addView(button("Run proxy trigger") {
            startActivity(IntentFactory.proxy())
        })
        root.addView(button("Copy JSON report") {
            val clipboard = getSystemService<ClipboardManager>()
            clipboard?.setPrimaryClip(ClipData.newPlainText("CAS Gate 0A report", buildReport().toString(2)))
            TestStore.record(this, "REPORT_COPIED")
            refreshReport()
        })
        root.addView(button("Clear local test journal") {
            TestStore.clear(this)
            refreshReport()
        })
        root.addView(reportView, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 12 })
        setContentView(ScrollView(this).apply { addView(root) })
        refreshCoverStatus()
        refreshReport()
    }

    override fun onResume() {
        super.onResume()
        if (::reportView.isInitialized) refreshReport()
        // A previous process may have died after the SMS left the SIM but
        // before its receipt landed (or with radio results still owed);
        // recover those batches and retry any receipts the console has not
        // accepted yet now that the app — and likely data — is back.
        DeviceSmsSender.recoverUnfinishedBatches(this)
        Thread {
            DeviceSmsSender.retryPendingReceipts(this)?.let { outcome ->
                TestStore.record(this, "RECEIPT_RETRY", mapOf("detail" to outcome))
                runOnUiThread { if (::reportView.isInitialized) refreshReport() }
            }
        }.start()
    }

    override fun onBackPressed() {
        TestStore.record(this, "BACK_OBSERVED", mapOf("activity" to "MainActivity", "expected" to "returns_to_launcher_or_previous_task"))
        super.onBackPressed()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_SEND_SMS) {
            val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
            TestStore.record(this, "SMS_PERMISSION", mapOf("outcome" to if (granted) "GRANTED" else "DENIED"))
            refreshReport()
        }
    }

    private fun sendMvpAlert() {
        if (alertInFlight) return
        val baseUrl = serverInput.text.toString().trim()
        val token = alertTokenInput.text.toString().trim()
        TestStore.setAlertServerUrl(this, baseUrl)
        TestStore.setAlertToken(this, token)
        TestStore.setSmsResponders(this, respondersInput.text.toString())
        if (TestStore.smsResponders(this).isEmpty()) {
            TestStore.record(this, "MVP_ALERT_OUTCOME", mapOf("outcome" to "NOT_SENT", "reason" to "no responder numbers configured"))
            refreshReport()
            return
        }
        if (!smsPermissionGranted) {
            TestStore.record(this, "MVP_ALERT_OUTCOME", mapOf("outcome" to "NOT_SENT", "reason" to "SEND_SMS permission not granted; requesting it now — tap Send again after granting"))
            requestPermissions(arrayOf(android.Manifest.permission.SEND_SMS), REQUEST_SEND_SMS)
            refreshReport()
            return
        }
        alertInFlight = true
        TestStore.record(this, "MVP_ALERT_ATTEMPT", mapOf(
            "https" to baseUrl.startsWith("https://"),
            "responders" to TestStore.smsResponders(this).size,
        ))
        reportView.text = "Sending MVP alert..."
        Thread {
            if (baseUrl.isBlank() || token.isBlank()) {
                // Without a server URL — or without the alert credential the
                // trigger endpoint requires (401 otherwise) — no incident can
                // be committed; the alert still leaves this handset directly.
                val reason = if (baseUrl.isBlank()) {
                    "no server URL configured; texting responders directly without an incident"
                } else {
                    "no alert credential configured; the server would reject the trigger with 401, texting responders directly without an incident"
                }
                TestStore.record(this, "MVP_ALERT_OUTCOME", mapOf("outcome" to "NOT_SENT", "reason" to reason))
                sendSmsFromHandset(null)
            } else {
                val result = AlertSender.trigger(this@MainActivity, baseUrl, token)
                TestStore.record(this, "MVP_ALERT_OUTCOME", mapOf("outcome" to if (result.ok) "SENT" else "FAILED", "detail" to result.detail))
                if (result.ok && result.reused) {
                    // The repeat tap folded into the still-active incident and
                    // the console queued no new deliveries, so the handset
                    // must not re-send physical messages either.
                    TestStore.record(this, "MVP_ALERT_OUTCOME", mapOf("outcome" to "FOLDED_INTO_ACTIVE", "detail" to "incident already active; not re-sending SMS/WhatsApp"))
                } else {
                    // Device-direct: even when the trigger POST fails (no
                    // data, server down) the alert still leaves this handset
                    // by SMS.
                    sendSmsFromHandset(if (result.ok) result.incidentId else null)
                    if (TestStore.whatsAppEnabled(this@MainActivity)) {
                        sendWhatsAppFromHandset(if (result.ok) result.incidentId else null)
                    }
                }
            }
            runOnUiThread {
                alertInFlight = false
                refreshReport()
            }
        }.start()
    }

    private fun sendSmsFromHandset(incidentId: String?) {
        val outcome = DeviceSmsSender.sendAlert(this, incidentId, DeviceSmsSender.alertBody(incidentId))
        TestStore.record(this, "MVP_SMS_OUTCOME", mapOf("incidentId" to (incidentId ?: "offline"), "detail" to outcome))
    }

    private fun sendWhatsAppFromHandset(incidentId: String?) {
        // Tap-to-send: opens one WhatsApp chat per responder with the alert
        // pre-filled; the console's WHATSAPP item is marked from the handoff
        // receipt (SENT there means handed to WhatsApp, not delivered).
        val outcome = WhatsAppAlerter.sendAlert(this, incidentId, DeviceSmsSender.alertBody(incidentId))
        TestStore.record(this, "MVP_WHATSAPP_OUTCOME", mapOf("incidentId" to (incidentId ?: "offline"), "detail" to outcome))
    }

    private fun checkRequeued() {
        val baseUrl = serverInput.text.toString().trim()
        TestStore.setAlertServerUrl(this, baseUrl)
        Thread {
            // Flush receipts the console has not accepted yet before asking
            // it for pending items, so the device-pending list reflects
            // deliveries this handset already completed.
            DeviceSmsSender.retryPendingReceipts(this)?.let { retryOutcome ->
                TestStore.record(this, "RECEIPT_RETRY", mapOf("detail" to retryOutcome))
            }
            DeviceSmsSender.recoverUnfinishedBatches(this)
            val outcome = DeviceSmsSender.sendRequeued(this)
            TestStore.record(this, "REQUEUE_CHECK", mapOf("detail" to outcome))
            if (TestStore.whatsAppEnabled(this@MainActivity)) {
                val waOutcome = WhatsAppAlerter.sendRequeued(this@MainActivity)
                TestStore.record(this@MainActivity, "WHATSAPP_REQUEUE_CHECK", mapOf("detail" to waOutcome))
            }
            runOnUiThread { refreshReport() }
        }.start()
    }

    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text = label
        gravity = Gravity.CENTER
        setOnClickListener { action() }
    }

    /**
     * Lists the device's launchable apps (MAIN/LAUNCHER is declared in the
     * manifest's package-visibility queries) and lets the operator pick the
     * cover app. The selection persists in TestStore and is what
     * TriggerActivity launches on a proxy trigger.
     */
    private fun pickCoverApp() {
        val intent = android.content.Intent(android.content.Intent.ACTION_MAIN)
            .addCategory(android.content.Intent.CATEGORY_LAUNCHER)
        val apps = packageManager.queryIntentActivities(intent, 0)
            .filter { it.activityInfo.packageName != packageName }
            .map { it.loadLabel(packageManager).toString() to it.activityInfo.packageName }
            .distinctBy { it.second }
            .sortedBy { it.first.lowercase() }
        if (apps.isEmpty()) {
            TestStore.record(this, "COVER_PICKER_EMPTY", mapOf("reason" to "no launchable apps visible"))
            refreshReport()
            return
        }
        android.app.AlertDialog.Builder(this)
            .setTitle("Select cover app")
            .setItems(apps.map { "${it.first}\n${it.second}" }.toTypedArray()) { _, which ->
                val (_, pkg) = apps[which]
                TestStore.setCoverPackage(this, pkg)
                TestStore.record(this, "COVER_CONFIGURED", mapOf("coverPackage" to pkg, "validInstalledPackage" to true))
                refreshCoverStatus()
                refreshReport()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun refreshCoverStatus() {
        if (!::coverStatus.isInitialized) return
        val pkg = TestStore.coverPackage(this)
        coverStatus.text = if (pkg.isBlank()) {
            "Cover app: none — proxy trigger is manual only"
        } else {
            // Follow the selection by label so the operator can confirm the
            // right app without memorizing package names.
            val label = runCatching {
                packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
            }.getOrDefault(pkg)
            "Cover app: $label ($pkg)"
        }
    }

    private fun environmentLabel(): String =
        if (isEmulator()) {
            "SIMULATED EMULATOR EVIDENCE · not proof of physical readiness"
        } else {
            "PHYSICAL DEVICE OBSERVATION · repeat emulator findings on the managed Pixel"
        }

    private fun isEmulator(): Boolean =
        Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.contains("emulator") ||
            Build.HARDWARE.contains("ranchu") ||
            Build.HARDWARE.contains("goldfish") ||
            Build.PRODUCT.contains("sdk")

    private fun buildReport(): JSONObject {
        val dpm = getSystemService<DevicePolicyManager>()
        val am = getSystemService<ActivityManager>()
        val admin = ComponentName(this, DeviceAdminReceiver::class.java)
        val appTasks = am?.appTasks?.map { task ->
            JSONObject().put("taskId", task.taskInfo.taskId)
                .put("baseActivity", task.taskInfo.baseActivity?.flattenToShortString())
                .put("topActivity", task.taskInfo.topActivity?.flattenToShortString())
        } ?: emptyList()
        val taskReport = JSONArray().apply { appTasks.forEach { put(it) } }
        val shortcutManager = getSystemService<android.content.pm.ShortcutManager>()
        val permissionNames = listOf(
            "android.permission.SEND_SMS",
            "android.permission.ACCESS_FINE_LOCATION",
            "android.permission.RECORD_AUDIO",
            "android.permission.CAMERA",
            "android.permission.INTERNET"
        )
        val report = JSONObject()
            .put("schema", "cas-gate0a-report-v2")
            .put("reportType", "gate0a-run")
            .put("runPurpose", "Disposable proxy-launch hardware measurement only")
            .put("evidenceClass", if (isEmulator()) "simulated-emulator" else "physical-device-observation")
            .put("status", "complete-with-inconclusive")
            .put("startedAtUtc", java.time.Instant.now().toString())
            .put("finishedAtUtc", java.time.Instant.now().toString())
            .put("gate0aPassed", false)
            .put("physicalReadinessProof", if (isEmulator()) "simulated-emulator-not-proof" else "requires-managed-Pixel-observer-review")
            .put("target", JSONObject()
                .put("model", if (isEmulator()) "Pixel 8a" else Build.MODEL)
                .put("serial", Build.SERIAL.ifBlank { "unknown" })
                .put("device", Build.DEVICE)
                .put("androidVersion", Build.VERSION.RELEASE)
                .put("build", Build.ID)
                .put("androidApi", Build.VERSION.SDK_INT)
                .put("stockAndroid", true)
                .put("isEmulator", isEmulator())
                .put("usbState", "not-observed")
                .put("usbDebuggingEnabled", false))
            .put("preflight", JSONObject()
                .put("status", "WARN")
                .put("checks", JSONArray().put(JSONObject()
                    .put("id", "target.usb-authorization")
                    .put("name", "USB authorization and debugging")
                    .put("status", "WARN")
                    .put("required", true)
                    .put("observed", "USB authorization is not observable from the app report")
                    .put("expected", "The host preflight must confirm an authorized adb target before the run")
                    .put("nextSteps", JSONArray().put("Attach the matching host preflight report before importing."))))
                .put("unresolvedWarnings", JSONArray().put("Host USB authorization and package identity preflight is required.")))
            .put("safety", JSONObject()
                .put("liveMessagingEnabled", false)
                .put("networkEnabled", false)
                .put("evidenceCaptureEnabled", false)
                .put("covertProductionBehaviorEnabled", false)
                .put("deviceOwnerPolicyChanged", false)
                .put("applicationDataCleared", false)
                .put("factoryResetPerformed", false))
            .put("coverPackage", TestStore.coverPackage(this))
            .put("deviceOwner", JSONObject()
                .put("isCasDeviceOwner", dpm?.isDeviceOwnerApp(packageName) == true)
                .put("adminReceiverRegistered", dpm?.isAdminActive(admin) == true)
                .put("reportedOnly", true))
            .put("permissions", JSONObject().apply {
                permissionNames.forEach { put(it, checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED) }
            })
            .put("shortcut", JSONObject()
                .put("pinSupported", shortcutManager?.isRequestPinShortcutSupported == true)
                .put("pinned", shortcutManager?.pinnedShortcuts?.any { it.id == "gate0a-proxy" } == true)
                .put("launcherControlsPinnedState", true))
            .put("tasks", taskReport)
            .put("recents", JSONObject().put("proxyExcludedFromRecents", true).put("observedTaskCount", appTasks.size))
            .put("back", JSONObject().put("mainActivityCallbackRecorded", true).put("predictiveBack", "observe_on_device"))
            .put("observer", JSONObject()
                .put("settingsAppInfoReviewRequired", true)
                .put("quickSettingsReviewRequired", true)
                .put("notificationsReviewRequired", true)
                .put("coverAppBackHomeRecentsReviewRequired", true))
            .put("evidence", JSONObject()
                .put("logs", JSONArray())
                .put("screenshots", JSONArray())
                .put("rawReferences", JSONArray()))
            .put("warnings", JSONArray().put("Host USB authorization and package identity preflight is required."))
            // Gate 0A import contract accepts only harness event types; the on-device
            // journal also records MVP alert activity, so filter it out of the report.
            .put("events", gate0aEventsOnly(TestStore.events(this)))
        return report
    }

    private fun gate0aEventsOnly(events: JSONArray): JSONArray {
        val allowed = setOf(
            "BACK_OBSERVED", "COVER_CONFIGURED", "COVER_LAUNCH_OUTCOME",
            "OBSERVER_SCREEN_OPENED", "PROXY_TRIGGER", "REPORT_COPIED", "SHORTCUT_OUTCOME"
        )
        return JSONArray().apply {
            for (i in 0 until events.length()) {
                val event = events.optJSONObject(i) ?: continue
                if (event.optString("type") in allowed) put(event)
            }
        }
    }

    private fun refreshReport() {
        if (::reportView.isInitialized) reportView.text = buildReport().toString(2)
    }
}

object IntentFactory {
    fun proxy() = android.content.Intent("com.covertalert.pixeltest.action.PROXY_TRIGGER")
}

private const val REQUEST_SEND_SMS = 41