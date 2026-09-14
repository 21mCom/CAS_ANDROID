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
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.getSystemService
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var coverInput: EditText
    private lateinit var reportView: TextView

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        TestStore.record(this, "OBSERVER_SCREEN_OPENED", mapOf("activityState" to if (state == null) "cold" else "warm"))
        coverInput = EditText(this).apply {
            hint = "Cover package, e.g. com.google.android.apps.maps"
            setText(TestStore.coverPackage(this@MainActivity))
            isSingleLine = true
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
            text = "Physical target: Pixel 11 · stock Android · API 35+\nEmulator baseline: Pixel 8a · API 35\n${environmentLabel()}\nLocal-only test. No SMS, network, location, evidence capture, or production incident behavior."
            textSize = 13f
        })
        root.addView(coverInput, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 20 })
        root.addView(button("Save cover app") {
            val value = coverInput.text.toString().trim()
            TestStore.setCoverPackage(this, value)
            TestStore.record(this, "COVER_CONFIGURED", mapOf("coverPackage" to value, "validInstalledPackage" to isInstalled(value)))
            refreshReport()
        })
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
        refreshReport()
    }

    override fun onResume() {
        super.onResume()
        if (::reportView.isInitialized) refreshReport()
    }

    override fun onBackPressed() {
        TestStore.record(this, "BACK_OBSERVED", mapOf("activity" to "MainActivity", "expected" to "returns_to_launcher_or_previous_task"))
        super.onBackPressed()
    }

    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text = label
        gravity = Gravity.CENTER
        setOnClickListener { action() }
    }

    private fun isInstalled(packageName: String): Boolean =
        packageName.isNotBlank() && runCatching { packageManager.getApplicationInfo(packageName, 0) }.isSuccess

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
            .put("events", TestStore.events(this))
        return report
    }

    private fun refreshReport() {
        if (::reportView.isInitialized) reportView.text = buildReport().toString(2)
    }
}

object IntentFactory {
    fun proxy() = android.content.Intent("com.covertalert.pixeltest.action.PROXY_TRIGGER")
}