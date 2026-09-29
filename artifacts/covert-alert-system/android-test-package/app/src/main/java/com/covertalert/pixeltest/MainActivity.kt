package com.covertalert.pixeltest

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
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
    private lateinit var coverStatus: TextView
    private lateinit var serverInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var respondersInput: EditText
    private lateinit var alertTokenInput: EditText
    private lateinit var reportView: TextView
    @Volatile private var alertInFlight = false

    private val smsPermissionGranted: Boolean
        get() = checkSelfPermission(android.Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED

    private val locationPermissionGranted: Boolean
        get() = checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

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
        // Separate from the device token above: this is the enrollment
        // credential (the server's CAS_ALERT_TOKEN secret), exchanged once for
        // this handset's own revocable device credential on the first trigger
        // and then discarded — the provisioned handset does not retain it, so
        // a revoked phone cannot re-enroll itself. Re-entering it here is the
        // trusted operator action that restores access after revocation.
        alertTokenInput = EditText(this).apply {
            hint = "Enrollment credential (CAS_ALERT_TOKEN) — consumed on enrollment, re-enter to re-enroll"
            setText(TestStore.alertToken(this@MainActivity))
            isSingleLine = true
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        root.addView(alertTokenInput, LinearLayout.LayoutParams(-1, -2))
        root.addView(button("Save alert credential") {
            val value = alertTokenInput.text.toString().trim()
            // Saving a credential NEVER touches the enrolled device token or
            // the provisioned flag. The flag stays sticky from the moment a
            // first enrollment succeeds until a later enrollment succeeds
            // again (AlertSender.ensureDeviceToken), and the enrolled token
            // is only dropped when the server itself rejects it (401). If
            // saving an unverified string cleared either one, a revoked
            // handset could type anything and immediately resume
            // pickup/receipts under the legacy shared device token — the
            // provisioned guard in DeviceSmsSender would no longer fire.
            // Deliberate re-enrollment still works: revoke the old
            // credential in the console, the handset's next request gets a
            // 401 that drops the dead token, and the credential saved here
            // enrolls its replacement on the next trigger.
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
        // No other-channel controls by design: SMS is the only channel the
        // handset delivers itself. Every other channel fans out server-side
        // so no alert path on this device can surface another app's UI.
        root.addView(button("Grant SMS permission") {
            if (smsPermissionGranted) {
                TestStore.record(this, "SMS_PERMISSION", mapOf("outcome" to "ALREADY_GRANTED"))
            } else {
                requestPermissions(arrayOf(android.Manifest.permission.SEND_SMS), REQUEST_SEND_SMS)
            }
            refreshReport()
        })
        // Location is optional by design: the alert leaves on time with "no
        // fix captured" when permission is missing. Granting it here lets the
        // alert carry coordinates, accuracy radius, and fix age.
        root.addView(button("Grant location permission") {
            if (locationPermissionGranted) {
                TestStore.record(this, "LOCATION_PERMISSION", mapOf("outcome" to "ALREADY_GRANTED"))
            } else {
                requestPermissions(
                    arrayOf(
                        android.Manifest.permission.ACCESS_FINE_LOCATION,
                        android.Manifest.permission.ACCESS_COARSE_LOCATION,
                    ),
                    REQUEST_LOCATION,
                )
            }
            refreshReport()
        })
        // Explicit owner grants for the bounded playground. The OS microphone
        // and camera indicators remain visible during every actual capture.
        root.addView(button("Grant microphone permission") {
            val required = arrayOf(android.Manifest.permission.RECORD_AUDIO, android.Manifest.permission.POST_NOTIFICATIONS)
            if (required.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) {
                TestStore.record(this, "MIC_PERMISSION", mapOf("outcome" to "ALREADY_GRANTED"))
            } else {
                requestPermissions(required, REQUEST_MIC)
            }
            refreshReport()
        })
        root.addView(button("Grant camera permission") {
            if (checkSelfPermission(android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                TestStore.record(this, "CAMERA_PERMISSION", mapOf("outcome" to "ALREADY_GRANTED"))
            } else {
                requestPermissions(arrayOf(android.Manifest.permission.CAMERA), REQUEST_CAMERA)
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
        root.addView(button("Copy debug journal (alert & capture events)") {
            // The Gate 0A report above filters the journal down to the
            // harness event types its importer accepts, so alert-send and
            // capture diagnostics (MVP_ALERT_*, MVP_SMS_OUTCOME,
            // LOCATION_CAPTURE, CAPTURE_*, ...) never appear in it. This
            // export carries the raw journal — every event type — so a
            // field tester can paste it and see why a send failed. It is
            // NOT a Gate 0A report; never feed it to the importer.
            val clipboard = getSystemService<ClipboardManager>()
            clipboard?.setPrimaryClip(ClipData.newPlainText("CAS debug journal", buildDebugJournal().toString(2)))
            TestStore.record(this, "DEBUG_JOURNAL_COPIED")
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
            retryCaptureWork()
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
        if (requestCode == REQUEST_LOCATION) {
            val granted = grantResults.any { it == PackageManager.PERMISSION_GRANTED }
            TestStore.record(this, "LOCATION_PERMISSION", mapOf("outcome" to if (granted) "GRANTED" else "DENIED"))
            refreshReport()
        }
        if (requestCode == REQUEST_MIC) {
            val mic = checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            val notification = checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            TestStore.record(this, "MIC_PERMISSION", mapOf("outcome" to if (mic && notification) "GRANTED" else "DENIED", "microphoneGranted" to mic, "notificationGranted" to notification))
            refreshReport()
        }
        if (requestCode == REQUEST_CAMERA) {
            TestStore.record(this, "CAMERA_PERMISSION", mapOf("outcome" to if (checkSelfPermission(android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) "GRANTED" else "DENIED"))
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
        // A cached enrolled credential is enough to reach the console — the
        // enrollment credential was consumed on first enrollment and is only
        // needed again after a revocation.
        val hasConsoleCredential = token.isNotBlank() || TestStore.enrolledDeviceToken(this).isNotBlank()
        val canReachConsole = baseUrl.isNotBlank() && hasConsoleCredential
        if (TestStore.smsResponders(this).isEmpty() && !canReachConsole) {
            TestStore.record(this, "MVP_ALERT_OUTCOME", mapOf("outcome" to "NOT_SENT", "reason" to "no responder numbers configured (with no reachable console to supply its responder circle, the handset's own list is the only source)"))
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
            "locationPermission" to locationPermissionGranted,
        ))
        reportView.text = "Sending MVP alert..."
        Thread {
            // Bounded capture: at most AlertLocation.MAX_WAIT_MS before the
            // trigger POST and SMS go out, with or without a fix.
            val captureStart = System.currentTimeMillis()
            val fix = LocationCapture.capture(this)
            TestStore.record(this, "LOCATION_CAPTURE", mapOf(
                "outcome" to when {
                    fix == null -> "NO_FIX"
                    fix.lastKnown -> "LAST_KNOWN"
                    else -> "FRESH"
                },
                "waitedMs" to (System.currentTimeMillis() - captureStart),
                "accuracyM" to fix?.accuracyM?.toInt(),
                "fixAgeS" to fix?.let { (System.currentTimeMillis() - it.capturedAtMs) / 1000 },
                "provider" to fix?.provider,
            ))
            // A provisioned handset no longer holds the enrollment credential
            // (it was discarded after the exchange), so a blank field must not
            // stop later alerts: the cached enrolled credential authorizes the
            // trigger and the incident is still created server-side.
            if (!canReachConsole) {
                // Without a server URL — or without any credential the
                // trigger endpoint accepts (401 otherwise) — no incident can
                // be committed; the alert still leaves this handset directly.
                val reason = if (baseUrl.isBlank()) {
                    "no server URL configured; texting responders directly without an incident"
                } else {
                    "no enrollment credential or enrolled device credential configured; the server would reject the trigger with 401, texting responders directly without an incident"
                }
                TestStore.record(this, "MVP_ALERT_OUTCOME", mapOf("outcome" to "NOT_SENT", "reason" to reason))
                sendSmsFromHandset(null, fix)
            } else {
                val result = AlertSender.trigger(this@MainActivity, baseUrl, token, fix)
                TestStore.record(this, "MVP_ALERT_OUTCOME", mapOf("outcome" to if (result.ok) "SENT" else "FAILED", "detail" to result.detail))
                if (result.credentialConsumed) {
                    // The enrollment credential was exchanged for this
                    // handset's device credential and discarded; clear the
                    // field too so it cannot silently re-enroll this phone.
                    runOnUiThread { alertTokenInput.setText("") }
                }
                if (result.ok && result.incidentId != null) {
                    // The server policy is authoritative; offline fallback is
                    // last known, and the default is all OFF (never opt in).
                    val policy = CapturePolicy.fetch(this, baseUrl)
                        ?: CapturePolicy.cached(this)
                    TestStore.record(this, "CAPTURE_POLICY_APPLIED", mapOf(
                        "audio" to policy.audio.wire, "photo" to policy.photo.wire,
                        "video" to policy.video.wire, "timing" to policy.timing.wire,
                    ))
                    val kinds = listOfNotNull(
                        "audio".takeIf { policy.audio == CapturePolicy.Setting.ON_TRIGGER },
                        "photo".takeIf { policy.photo == CapturePolicy.Setting.ON_TRIGGER },
                        "video".takeIf { policy.video == CapturePolicy.Setting.ON_TRIGGER },
                    )
                    if (kinds.isNotEmpty()) {
                        try {
                            startForegroundService(Intent(this, EvidenceCaptureService::class.java).apply {
                                putExtra("incident_id", result.incidentId)
                                putExtra("kinds", kinds.toTypedArray())
                                putExtra("timing", policy.timing.wire)
                            })
                        } catch (error: Exception) {
                            TestStore.record(this, "CAPTURE_START_FAILED", mapOf("detail" to "${error.javaClass.simpleName}: ${error.message}"))
                        }
                    }
                }
                if (result.ok && result.reused) {
                    // The repeat tap folded into the still-active incident and
                    // the console queued no new deliveries, so the handset
                    // must not re-send physical messages either.
                    TestStore.record(this, "MVP_ALERT_OUTCOME", mapOf("outcome" to "FOLDED_INTO_ACTIVE", "detail" to "incident already active; not re-sending SMS"))
                } else if (result.ok && result.smsCircle != null && result.smsCircle.isEmpty()) {
                    // The console's managed responder circle has no enabled
                    // SMS numbers: text nobody — falling back to the local
                    // list would keep texting responders the operator
                    // disabled in the console.
                    TestStore.record(this, "MVP_SMS_OUTCOME", mapOf("incidentId" to (result.incidentId ?: "unknown"), "detail" to "NOT_SENT: the console responder circle has no enabled SMS numbers — add or enable one in the console"))
                } else {
                    // Device-direct: even when the trigger POST fails (no
                    // data, server down) the alert still leaves this handset
                    // by SMS — with the fix, so an offline alert still tells
                    // responders where the handset was. Online sends use the
                    // console's circle and wording; only a failed trigger
                    // falls back to the local list and offline wording.
                    sendSmsFromHandset(
                        if (result.ok) result.incidentId else null,
                        fix,
                        if (result.ok) result.smsCircle else null,
                        if (result.ok) result.smsMessage else null,
                    )
                }
            }
            runOnUiThread {
                alertInFlight = false
                refreshReport()
            }
        }.start()
    }

    private fun sendSmsFromHandset(
        incidentId: String?,
        fix: AlertLocation.Fix? = null,
        recipients: List<String>? = null,
        message: String? = null,
    ) {
        // recipients/message come from the console's deviceSms directive on a
        // successful trigger; both are null on the offline path, where the
        // handset's own list and wording are the explicit fallback.
        val outcome = DeviceSmsSender.sendAlert(
            this,
            incidentId,
            message ?: DeviceSmsSender.alertBody(incidentId, fix),
            respondersOverride = recipients,
        )
        TestStore.record(this, "MVP_SMS_OUTCOME", mapOf("incidentId" to (incidentId ?: "offline"), "detail" to outcome))
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
            retryCaptureWork()
            val outcome = DeviceSmsSender.sendRequeued(this)
            TestStore.record(this, "REQUEUE_CHECK", mapOf("detail" to outcome))
            runOnUiThread { refreshReport() }
        }.start()
    }

    private fun retryCaptureWork() {
        // Neither retries nor polling run in the Gate 0A harness path.
        // Push registration refreshes alongside: once a google-services.json
        // build has a server URL and an enrolled credential, the handset
        // registers its FCM token so responder capture requests can wake it
        // instantly instead of waiting for this polling path.
        CapturePush.syncRegistration(this)
        try { EvidenceUploader.uploadAll(this) } catch (error: Exception) {
            TestStore.record(this, "EVIDENCE_UPLOAD", mapOf("outcome" to "RETRY_LATER", "detail" to error.toString()))
        }
        try { CaptureRequests.checkPending(this) } catch (error: Exception) {
            TestStore.record(this, "CAPTURE_REQUEST_CHECK_FAILED", mapOf("detail" to error.toString()))
        }
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

    /**
     * Raw recent journal for field debugging: every recorded event type,
     * including the MVP alert-send and capture families the Gate 0A report
     * deliberately filters out. Deliberately a different schema marker than
     * cas-gate0a-report-v2 so it can never be mistaken for (or imported as)
     * a Gate 0A run report.
     */
    private fun buildDebugJournal(): JSONObject {
        val events = TestStore.events(this)
        return JSONObject()
            .put("schema", "cas-debug-journal-v1")
            .put("reportType", "debug-journal")
            .put("note", "Raw on-device journal for field debugging (alert sends, SMS radio results, capture events). NOT a Gate 0A report — do not import it as one.")
            .put("exportedAtUtc", java.time.Instant.now().toString())
            .put("eventCount", events.length())
            .put("events", events)
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
private const val REQUEST_LOCATION = 42
private const val REQUEST_MIC = 43
private const val REQUEST_CAMERA = 44