package com.covertalert.pixeltest

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.ImageFormat
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.Image
import android.media.ImageReader
import android.media.MediaRecorder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.view.Surface
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.min

/**
 * Owner-visible, bounded evidence playground. No preview surface or activity
 * is opened; Android's camera/microphone indicators and service notification
 * remain visible. All capture is serialized so two recorders never fight for
 * the microphone — the "both" camera selection captures each lens in turn
 * rather than streaming them concurrently. Hardware failures are isolated
 * per kind (and per lens) and journaled.
 */
class EvidenceCaptureService : Service() {
    private val worker = Executors.newSingleThreadExecutor()
    private val callback = Handler(Looper.getMainLooper())
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("cas_evidence", "CAS test capture", NotificationManager.IMPORTANCE_LOW)
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val incident = intent?.getStringExtra("incident_id")
        val kinds = intent?.getStringArrayExtra("kinds")?.filter { it in setOf("photo", "video", "audio") }
            ?.distinct().orEmpty()
        if (incident.isNullOrBlank() || kinds.isEmpty()) {
            TestStore.record(this, "CAPTURE_START_FAILED", mapOf("detail" to "Missing incident or valid kinds"))
            stopSelf(startId)
            return START_NOT_STICKY
        }
        val type = (if ("audio" in kinds || "video" in kinds) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0) or
            (if ("photo" in kinds || "video" in kinds) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0)
        try {
            startForeground(1, Notification.Builder(this, "cas_evidence")
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setContentTitle("CAS test capture running")
                .setContentText("Bounded evidence capture in progress")
                .setOngoing(true).build(), type)
        } catch (error: Exception) {
            TestStore.record(this, "CAPTURE_START_FAILED", mapOf("detail" to error.toString()))
            stopSelf(startId)
            return START_NOT_STICKY
        }
        val timing = intent.getStringExtra("timing")
        val requestId = intent.getStringExtra("request_id")
        // back | front | both; anything missing or unknown keeps the original
        // back-camera behavior.
        val camera = intent.getStringExtra("camera") ?: "back"
        worker.execute {
            try {
                if (timing == "screen-off" && !waitForScreenOff()) return@execute
                val manager = getSystemService(PowerManager::class.java)
                val wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cas:evidence")
                // Bounded to under 3m plus hardware setup time; CPU must stay
                // awake on screen-off without turning the display back on.
                wakeLock.acquire(TimeUnit.MINUTES.toMillis(5))
                try {
                    for (kind in listOf("photo", "video", "audio")) {
                        if (kind !in kinds) continue
                        try {
                            if (kind == "audio") {
                                for (sequence in 1..6) {
                                    val start = System.currentTimeMillis()
                                    val file = File(cacheDir, "audio-$sequence.m4a")
                                    try {
                                        recordAudio(file)
                                        stage(incident, kind, start, sequence, requestId, file)
                                        TestStore.record(this, "EVIDENCE_CAPTURE", mapOf("kind" to kind, "outcome" to "CAPTURED", "detail" to "segment $sequence"))
                                    } finally {
                                        file.delete()
                                    }
                                }
                            } else {
                                val (lenses, degraded) = selectedLenses(camera)
                                if (lenses.isEmpty()) throw IOException("No camera available")
                                if (degraded) {
                                    TestStore.record(this, "EVIDENCE_CAPTURE", mapOf(
                                        "kind" to kind, "outcome" to "DEGRADED", "camera" to lenses[0].label,
                                        "detail" to "camera '$camera' requested but this device cannot honor it (missing lens or no concurrent front+back support); capturing ${lenses[0].label} only",
                                    ))
                                }
                                // Each lens gets its own artifact so the panel
                                // can label which camera the evidence came from.
                                for ((index, lens) in lenses.withIndex()) {
                                    // Covered-lens gate: a ~1 s low-res probe per lens
                                    // skips solid-black captures (pocket, box, face-down).
                                    // Probe failures fail OPEN — capture proceeds — because
                                    // losing real evidence is worse than a black artifact.
                                    val probe = runCatching { probeLens(lens) }.getOrElse { error ->
                                        TestStore.record(this, "EVIDENCE_CAPTURE", mapOf(
                                            "kind" to kind, "outcome" to "PROBE_FAILED",
                                            "camera" to lens.label, "detail" to "probe failed, capturing anyway: $error",
                                        ))
                                        null
                                    }
                                    if (probe?.covered == true) {
                                        TestStore.record(this, "EVIDENCE_CAPTURE", mapOf(
                                            "kind" to kind, "outcome" to "SKIPPED_COVERED",
                                            "camera" to lens.label, "detail" to probe.detail,
                                        ))
                                        continue
                                    }
                                    val start = System.currentTimeMillis()
                                    val file = File(cacheDir, if (kind == "photo") "photo-${lens.label}.jpg" else "video-${lens.label}.mp4")
                                    try {
                                        if (kind == "photo") photograph(file, lens.id) else recordVideo(file, lens.id)
                                        stage(incident, kind, start, index + 1, requestId, file, lens.label)
                                        TestStore.record(this, "EVIDENCE_CAPTURE", mapOf("kind" to kind, "outcome" to "CAPTURED", "camera" to lens.label, "detail" to "${file.length()} bytes"))
                                    } catch (error: Exception) {
                                        TestStore.record(this, "EVIDENCE_CAPTURE", mapOf("kind" to kind, "outcome" to "FAILED", "camera" to lens.label, "detail" to error.toString()))
                                    } finally {
                                        file.delete()
                                    }
                                }
                            }
                        } catch (error: Exception) {
                            TestStore.record(this, "EVIDENCE_CAPTURE", mapOf("kind" to kind, "outcome" to "FAILED", "detail" to error.toString()))
                        }
                    }
                } finally {
                    if (wakeLock.isHeld) wakeLock.release()
                }
            } catch (error: Exception) {
                TestStore.record(this, "CAPTURE_START_FAILED", mapOf("detail" to error.toString()))
            } finally {
                stopSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    private fun waitForScreenOff(): Boolean {
        if (!getSystemService(PowerManager::class.java).isInteractive) return true
        val latch = CountDownLatch(1)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) { latch.countDown() }
        }
        TestStore.record(this, "CAPTURE_DEFERRED_WAITING")
        registerReceiver(receiver, IntentFilter(Intent.ACTION_SCREEN_OFF), Context.RECEIVER_NOT_EXPORTED)
        try {
            // Close the race between the interactive test and registration.
            if (!getSystemService(PowerManager::class.java).isInteractive) return true
            if (latch.await(30, TimeUnit.MINUTES)) return true
            TestStore.record(this, "CAPTURE_DEFER_EXPIRED")
            return false
        } finally {
            unregisterReceiver(receiver)
        }
    }

    private fun stage(incident: String, kind: String, started: Long, sequence: Int, requestId: String?, file: File, camera: String? = null) {
        val sidecar = EvidenceUploader.enqueue(this, EvidenceUploadCore.Meta(incident, kind, started, sequence, requestId, camera), file.readBytes())
        // Upload errors cannot erase the durable pair or block the next clip.
        try { EvidenceUploader.upload(this, sidecar) } catch (error: Exception) {
            TestStore.record(this, "EVIDENCE_UPLOAD", mapOf("kind" to kind, "outcome" to "RETRY_LATER", "detail" to error.toString()))
        }
    }

    /** A lens to capture from: the console-facing label plus the camera2 id. */
    private data class Lens(val label: String, val id: String)

    private fun cameraId(facing: Int): String? {
        val manager = getSystemService(CameraManager::class.java)
        return manager.cameraIdList.firstOrNull {
            manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == facing
        }
    }

    /**
     * Resolve the camera selection ("back" | "front" | "both") to the lenses
     * to capture from. "both" is honored only when the device advertises the
     * front+back pair in its concurrent-camera combinations (API 30+; the
     * approved baseline is API 35, and Pixels support concurrent streams).
     * The boolean flags an honest degradation: the request could not be
     * honored as asked, so only the best single lens is captured and the
     * caller journals the DEGRADED outcome.
     */
    private fun selectedLenses(selection: String): Pair<List<Lens>, Boolean> {
        val back = cameraId(CameraCharacteristics.LENS_FACING_BACK)?.let { Lens("back", it) }
        val front = cameraId(CameraCharacteristics.LENS_FACING_FRONT)?.let { Lens("front", it) }
        return when (selection) {
            "front" -> if (front != null) listOf(front) to false else listOfNotNull(back) to true
            "both" -> {
                val concurrent = back != null && front != null &&
                    getSystemService(CameraManager::class.java).concurrentCameraIds
                        .any { combo -> back.id in combo && front.id in combo }
                if (concurrent) listOf(back, front) to false else listOfNotNull(back ?: front) to true
            }
            else -> listOfNotNull(back ?: front) to false
        }
    }

    private fun openCamera(id: String): CameraDevice {
        val latch = CountDownLatch(1)
        val expired = AtomicBoolean(false)
        var device: CameraDevice? = null
        var failure: String? = null
        getSystemService(CameraManager::class.java).openCamera(id, object : CameraDevice.StateCallback() {
            override fun onOpened(camera: CameraDevice) {
                if (expired.get()) camera.close() else { device = camera; latch.countDown() }
            }
            override fun onDisconnected(camera: CameraDevice) { camera.close(); failure = "Camera disconnected"; latch.countDown() }
            override fun onError(camera: CameraDevice, error: Int) { camera.close(); failure = "Camera error $error"; latch.countDown() }
        }, callback)
        if (!latch.await(10, TimeUnit.SECONDS)) {
            expired.set(true)
            // A late callback must not leak a camera after the timeout.
            callback.post { device?.close() }
            throw IOException("Camera open timed out")
        }
        return device ?: throw IOException(failure ?: "Camera unavailable")
    }

    private fun session(camera: CameraDevice, surface: Surface): CameraCaptureSession {
        val latch = CountDownLatch(1)
        val expired = AtomicBoolean(false)
        var opened: CameraCaptureSession? = null
        camera.createCaptureSession(listOf(surface), object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(value: CameraCaptureSession) {
                if (expired.get()) value.close() else { opened = value; latch.countDown() }
            }
            override fun onConfigureFailed(value: CameraCaptureSession) { value.close(); latch.countDown() }
        }, callback)
        if (!latch.await(10, TimeUnit.SECONDS)) {
            expired.set(true)
            callback.post { opened?.close() }
            throw IOException("Camera session timed out")
        }
        return opened ?: throw IOException("Camera session configuration failed")
    }

    /**
     * Every camera2 capture request (still, record, probe) is built through
     * this helper so the flash can NEVER fire: AE is pinned ON and the flash
     * is pinned OFF explicitly instead of inheriting template defaults, which
     * can differ across templates and devices.
     */
    private fun noFlashRequest(camera: CameraDevice, template: Int, target: Surface): CaptureRequest =
        camera.createCaptureRequest(template).apply {
            addTarget(target)
            set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
            set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_OFF)
        }.build()

    /**
     * Samples the light and proximity sensors during a probe window. A sensor
     * the device lacks simply stays null and the classifier treats that input
     * as unavailable (failing open toward capture).
     */
    private class SensorWindow : SensorEventListener {
        private var manager: SensorManager? = null
        private var proximityRange: Float = 0f
        @Volatile var lux: Float? = null; private set
        @Volatile var proximityNear: Boolean? = null; private set

        fun start(context: Context) {
            val sensors = context.getSystemService(SensorManager::class.java)
            manager = sensors
            sensors.getDefaultSensor(Sensor.TYPE_LIGHT)?.let {
                sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
            }
            sensors.getDefaultSensor(Sensor.TYPE_PROXIMITY)?.let {
                proximityRange = it.maximumRange
                sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
            }
        }

        fun stop() {
            manager?.unregisterListener(this)
            manager = null
        }

        override fun onSensorChanged(event: SensorEvent) {
            when (event.sensor.type) {
                // Brightest reading wins: a transient shadow must not read as dark.
                Sensor.TYPE_LIGHT -> lux = maxOf(lux ?: 0f, event.values[0])
                // Once anything was near during the window it stays "near".
                Sensor.TYPE_PROXIMITY ->
                    proximityNear = proximityNear == true || event.values[0] < proximityRange
            }
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    }

    /** Mean and population variance of the Y plane, subsampled for speed. */
    private fun frameStats(image: Image): CoveredLensClassifier.FrameStats {
        val plane = image.planes[0]
        val buffer = plane.buffer
        val width = image.width
        val height = image.height
        // Aim for ~4k samples regardless of probe resolution.
        val colStep = maxOf(1, width / 64)
        val rowStep = maxOf(1, height / 64)
        val row = ByteArray(plane.rowStride)
        var count = 0L
        var sum = 0.0
        var sumSq = 0.0
        var y = 0
        while (y < height) {
            buffer.position(y * plane.rowStride)
            buffer.get(row, 0, min(plane.rowStride, buffer.remaining()))
            var x = 0
            while (x < width) {
                val value = row[x * plane.pixelStride].toInt() and 0xFF
                count++
                sum += value
                sumSq += value.toDouble() * value
                x += colStep
            }
            y += rowStep
        }
        if (count == 0L) throw IOException("Probe frame had no samples")
        val mean = sum / count
        return CoveredLensClassifier.FrameStats(mean, sumSq / count - mean * mean)
    }

    /**
     * ~1 s per-lens luminance probe: opens the camera on a small YUV reader,
     * streams frames (flash pinned off like every request), and classifies the
     * LAST frame — by then auto-exposure has settled, so the camera's ramp-up
     * frames cannot read as a false "covered". Light and proximity sensors are
     * sampled across the same window. Runs on the serialized worker thread, so
     * it can never overlap another capture.
     */
    private fun probeLens(lens: Lens): CoveredLensClassifier.Decision {
        val map = getSystemService(CameraManager::class.java).getCameraCharacteristics(lens.id)
            .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val size = map?.getOutputSizes(ImageFormat.YUV_420_888)
            ?.minByOrNull { it.width.toLong() * it.height }
            ?: throw IOException("No YUV probe output")
        val sensors = SensorWindow()
        sensors.start(this)
        try {
            val reader = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, 4)
            try {
                val latest = AtomicReference<CoveredLensClassifier.FrameStats?>()
                val frameError = AtomicReference<Exception?>()
                reader.setOnImageAvailableListener({ source ->
                    try {
                        source.acquireLatestImage()?.use { image -> latest.set(frameStats(image)) }
                    } catch (error: Exception) {
                        frameError.set(error)
                    }
                }, callback)
                openCamera(lens.id).use { camera ->
                    session(camera, reader.surface).use { captureSession ->
                        captureSession.setRepeatingRequest(
                            noFlashRequest(camera, CameraDevice.TEMPLATE_PREVIEW, reader.surface), null, callback)
                        Thread.sleep(1_000)
                        captureSession.stopRepeating()
                    }
                }
                frameError.get()?.let { throw IOException("Probe frame failed", it) }
                val stats = latest.get() ?: throw IOException("Probe produced no frames")
                return CoveredLensClassifier.classify(stats, sensors.lux, sensors.proximityNear)
            } finally {
                reader.setOnImageAvailableListener(null, null)
                reader.close()
            }
        } finally {
            sensors.stop()
        }
    }

    private fun photograph(file: File, id: String) {
        val sizes = getSystemService(CameraManager::class.java).getCameraCharacteristics(id)
            .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)?.getOutputSizes(ImageFormat.JPEG)
            ?: throw IOException("No JPEG output")
        val size = (sizes.filter { it.width.toLong() * it.height <= 4_000_000L }
            .maxByOrNull { it.width.toLong() * it.height }
            ?: sizes.minByOrNull { it.width.toLong() * it.height })
            ?: throw IOException("No JPEG size")
        val reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2)
        try {
            val latch = CountDownLatch(1)
            var bytes: ByteArray? = null
            var imageError: Exception? = null
            reader.setOnImageAvailableListener({ source ->
                try {
                    source.acquireNextImage()?.use { image ->
                        val buffer = image.planes[0].buffer
                        bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
                        latch.countDown()
                    }
                } catch (error: Exception) {
                    imageError = error
                    latch.countDown()
                }
            }, callback)
            openCamera(id).use { camera ->
                session(camera, reader.surface).use { captureSession ->
                    captureSession.capture(
                        noFlashRequest(camera, CameraDevice.TEMPLATE_STILL_CAPTURE, reader.surface), null, callback)
                    if (!latch.await(10, TimeUnit.SECONDS)) throw IOException("JPEG capture timed out")
                    imageError?.let { throw IOException("JPEG capture failed", it) }
                    file.writeBytes(bytes ?: throw IOException("Empty JPEG"))
                }
            }
        } finally {
            reader.setOnImageAvailableListener(null, null)
            reader.close()
        }
    }

    private fun recordVideo(file: File, id: String) {
        val recorder = MediaRecorder(this)
        try {
            file.delete()
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setVideoSize(1280, 720)
            recorder.setVideoFrameRate(30)
            recorder.setVideoEncodingBitRate(4_000_000)
            recorder.setOutputFile(file.absolutePath)
            recorder.prepare()
            openCamera(id).use { camera ->
                session(camera, recorder.surface).use { captureSession ->
                    captureSession.setRepeatingRequest(
                        noFlashRequest(camera, CameraDevice.TEMPLATE_RECORD, recorder.surface), null, callback)
                    recorder.start()
                    Thread.sleep(20_000)
                    recorder.stop()
                    captureSession.stopRepeating()
                }
            }
        } finally {
            recorder.release()
        }
    }

    private fun recordAudio(file: File) {
        val recorder = MediaRecorder(this)
        try {
            file.delete()
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            recorder.setOutputFile(file.absolutePath)
            recorder.prepare()
            recorder.start()
            Thread.sleep(30_000)
            recorder.stop()
        } finally {
            recorder.release()
        }
    }

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }
}