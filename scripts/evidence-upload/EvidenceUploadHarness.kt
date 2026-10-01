package com.covertalert.pixeltest

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream

/**
 * Repo-only JVM harness for the EvidenceUploadCore staging/retry decisions
 * (no Android runtime). Exercises every process-death window the handset
 * relies on: the temp+rename publish order in enqueue (data before sidecar),
 * the sidecar-first delete order on a terminal outcome, RETRY_LATER pair
 * preservation, and the exactly-once enrolled-credential clear on a 401.
 *
 * Run via scripts/test-evidence-upload.sh — do not ship in the APK.
 */

/** In-memory journal; each entry is the (type, fields) pair TestStore would persist. */
private class FakeJournal : EvidenceUploadCore.Journal {
    val entries = mutableListOf<Pair<String, Map<String, Any?>>>()
    override fun record(type: String, fields: Map<String, Any?>) {
        entries.add(type to fields)
    }
    fun outcomes(): List<String> = entries.filter { it.first == "EVIDENCE_UPLOAD" }.map { it.second["outcome"] as String }
}

/** In-memory credential state; counts clears so "exactly once" is provable. */
private class FakeCredentials : EvidenceUploadCore.Credentials {
    var serverUrl = "https://console.example.test"
    var token = "enrolled-device-credential"
    var clearCount = 0
    override fun alertServerUrl(): String = serverUrl
    override fun enrolledDeviceToken(): String = token
    override fun clearEnrolledDeviceToken() {
        clearCount += 1
        token = ""
    }
}

/** Scripted HTTP response: either a status code or a thrown failure. */
private sealed class Script {
    class Status(val code: Int) : Script()
    class BlowUp(val error: Exception) : Script()
}

private class FakeConnection(private val script: Script) : EvidenceUploadCore.Connection {
    var method: String? = null
    val headers = linkedMapOf<String, String>()
    val body = ByteArrayOutputStream()
    var fixedLength: Long = -1
    var disconnected = false

    override var requestMethod: String
        get() = method ?: "GET"
        set(value) { method = value }
    override var doOutput: Boolean = false
    override fun setRequestProperty(key: String, value: String) { headers[key] = value }
    override fun setFixedLengthStreamingMode(contentLength: Long) { fixedLength = contentLength }
    override val outputStream: OutputStream
        get() = when (script) {
            is Script.Status -> body
            is Script.BlowUp -> throw script.error
        }
    override val responseCode: Int
        get() = when (script) {
            is Script.Status -> script.code
            is Script.BlowUp -> throw script.error
        }
    override fun disconnect() { disconnected = true }
}

/**
 * File handle that records delete order and can fail one scripted operation
 * the way a process death (or full disk) would. The harness selects behavior
 * per file name so a crash lands on exactly one durable boundary.
 */
private open class RecordingFile(
    parent: File?,
    name: String,
    private val env: FakeEnv,
) : File(parent, name) {
    override fun renameTo(dest: File): Boolean {
        // Abrupt process death: an Error the core's `catch (Exception)` cannot
        // see, so NO cleanup runs — the partial on-disk state survives as-is.
        if (env.dieRenameFor?.let(name::endsWith) == true) throw SimulatedDeath("process died renaming $name")
        if (env.failRenameFor?.let(name::endsWith) == true) return false
        return super.renameTo(dest)
    }
    override fun delete(): Boolean {
        env.deleteLog.add(name)
        if (env.failDeleteFor == name) return false
        return super.delete()
    }
}

/** Thrown where the harness simulates an abrupt process death (no cleanup). */
private class SimulatedDeath(message: String) : Error(message)

private class FakeEnv(
    val root: File,
    private val scripts: List<Script> = emptyList(),
) : EvidenceUploadCore.Env {
    override val journal = FakeJournal()
    override val credentials = FakeCredentials()
    val requests = mutableListOf<FakeConnection>()
    val deleteLog = mutableListOf<String>()
    val requestedPaths = mutableListOf<String>()
    /** Suffix of the staged name whose rename dies abruptly (no cleanup). */
    var dieRenameFor: String? = null
    /** Suffix of the staged name whose rename fails (process stays alive). */
    var failRenameFor: String? = null
    /** Exact staged name whose delete fails (simulates a mid-delete death). */
    var failDeleteFor: String? = null
    private var scriptIndex = 0

    override fun pendingDirectory(): File = File(root, "evidence-pending").also {
        if (!it.isDirectory && !it.mkdirs()) throw java.io.IOException("Cannot create evidence pending directory")
    }
    override fun stagedFile(dir: File?, name: String): File = RecordingFile(dir, name, this)
    override fun openConnection(baseUrl: String, path: String): EvidenceUploadCore.Connection {
        requestedPaths.add(path)
        // An attempt beyond the script is an unexpected upload: fail the whole
        // harness rather than letting upload()'s Exception catch mask it.
        if (scriptIndex >= scripts.size) throw AssertionError("unexpected evidence upload attempt ${scriptIndex + 1}")
        val connection = FakeConnection(scripts[scriptIndex])
        scriptIndex += 1
        requests.add(connection)
        return connection
    }

    fun stagedNames(): List<String> = pendingDirectory().list()?.sorted() ?: emptyList()
}

private var failures = 0
private var checks = 0

private fun check(name: String, condition: Boolean, detail: String = "") {
    checks += 1
    if (!condition) {
        failures += 1
        println("FAIL: $name${if (detail.isEmpty()) "" else " — $detail"}")
    }
}

private fun tempRoot(): File {
    val dir = java.nio.file.Files.createTempDirectory("evidence-upload-harness").toFile()
    dir.deleteOnExit()
    return dir
}

private fun sampleMeta(
    incidentId: String = "inc-1",
    kind: String = "video",
    requestId: String? = "req-1",
    camera: String? = "back",
) = EvidenceUploadCore.Meta(incidentId, kind, 1726000000000, 3, requestId, camera)

private const val SENTINEL_BYTES = "clip-bytes-0123456789"

fun main() {
    // 1. Meta maps kinds to the wire content type and staged extension;
    //    unknown kinds are rejected before anything touches disk.
    run {
        check("photo meta", EvidenceUploadCore.Meta("i", "photo", 1, 1).let {
            it.contentType == "image/jpeg" && it.extension == "jpg"
        })
        check("video meta", EvidenceUploadCore.Meta("i", "video", 1, 1).let {
            it.contentType == "video/mp4" && it.extension == "mp4"
        })
        check("audio meta", EvidenceUploadCore.Meta("i", "audio", 1, 1).let {
            it.contentType == "audio/mp4" && it.extension == "m4a"
        })
        check("unknown kind throws", runCatching {
            EvidenceUploadCore.Meta("i", "notes", 1, 1).contentType
        }.isFailure)
    }

    // 2. Happy-path enqueue: the pair lands with no temp residue and the
    //    sidecar carries every upload field.
    run {
        val env = FakeEnv(tempRoot())
        val bytes = SENTINEL_BYTES.toByteArray()
        val sidecar = EvidenceUploadCore.enqueue(env, sampleMeta(), bytes)
        check("enqueue returns the sidecar", sidecar.extension == "json", sidecar.name)
        val names = env.stagedNames()
        check("pair staged with no temp residue", names.size == 2 && names.none { it.endsWith(".tmp") || it.endsWith(".meta-tmp") }, names.toString())
        val id = sidecar.nameWithoutExtension
        check("data bytes intact", File(sidecar.parentFile, "$id.mp4").readBytes().contentEquals(bytes))
        val json = org.json.JSONObject(sidecar.readText())
        check("sidecar fields", json.getString("incidentId") == "inc-1" &&
            json.getString("kind") == "video" &&
            json.getLong("capturedAtMs") == 1726000000000L &&
            json.getInt("sequence") == 3 &&
            json.getString("contentType") == "video/mp4" &&
            json.getString("requestId") == "req-1" &&
            json.getString("camera") == "back", json.toString())
        check("audio omits the camera label", run {
            val audioEnv = FakeEnv(tempRoot())
            val audioSidecar = EvidenceUploadCore.enqueue(audioEnv, sampleMeta(kind = "audio", camera = null), bytes)
            !org.json.JSONObject(audioSidecar.readText()).has("camera")
        })
        check("enqueue rejects blank incident", runCatching {
            EvidenceUploadCore.enqueue(env, sampleMeta(incidentId = " "), bytes)
        }.isFailure)
        check("enqueue rejects sequence 0", runCatching {
            EvidenceUploadCore.enqueue(env, sampleMeta().copy(sequence = 0), bytes)
        }.isFailure)
    }

    // 3. Failed data publish with the process ALIVE (e.g. ENOSPC): the rename
    //    reports failure, the error propagates, and the catch block cleans up
    //    — NOTHING uploadable or partial survives, so a later uploadAll sees
    //    an empty directory.
    run {
        val crashedEnv = FakeEnv(tempRoot())
        crashedEnv.failRenameFor = ".tmp" // the data temp is the only .tmp staged name
        val result = runCatching { EvidenceUploadCore.enqueue(crashedEnv, sampleMeta(), SENTINEL_BYTES.toByteArray()) }
        check("data publish failure propagates", result.isFailure)
        check("no pair survives the data-publish crash", crashedEnv.stagedNames().isEmpty(), crashedEnv.stagedNames().toString())
        check("crash left nothing to upload", run {
            EvidenceUploadCore.uploadAll(crashedEnv)
            crashedEnv.requests.isEmpty() && crashedEnv.journal.entries.isEmpty()
        })
    }

    // 3b. ABRUPT process death between the data-temp write and its rename:
    //     no cleanup runs at all. The orphaned .tmp must sit harmlessly on
    //     disk — a restarted process must never mistake it for a staged clip.
    run {
        val root = tempRoot()
        val deadEnv = FakeEnv(root)
        deadEnv.dieRenameFor = ".tmp" // dies as the data publish begins
        val outcome = runCatching { EvidenceUploadCore.enqueue(deadEnv, sampleMeta(), SENTINEL_BYTES.toByteArray()) }
        check("abrupt data-publish death is uncaught by the core", outcome.exceptionOrNull() is SimulatedDeath, outcome.exceptionOrNull()?.toString() ?: "no throw")
        val leftover = deadEnv.stagedNames()
        check("abrupt death leaves only the data temp", leftover.size == 1 && leftover.single().endsWith(".tmp"), leftover.toString())
        // "Restart": a fresh environment over the surviving directory.
        val restart = FakeEnv(root)
        EvidenceUploadCore.uploadAll(restart)
        check("dead enqueue's temp is never uploaded", restart.requests.isEmpty() && restart.journal.entries.isEmpty())
        check("temp orphan left untouched for forensics", restart.stagedNames() == leftover, restart.stagedNames().toString())
    }

    // 4. Failed sidecar publish with the process ALIVE: the metadata rename
    //    fails; the catch block must remove the already-published data file
    //    (a clip without its sidecar is an orphan that must never upload),
    //    the temps must be gone, and the error propagates.
    run {
        val crashedEnv = FakeEnv(tempRoot())
        crashedEnv.failRenameFor = ".meta-tmp"
        val result = runCatching { EvidenceUploadCore.enqueue(crashedEnv, sampleMeta(), SENTINEL_BYTES.toByteArray()) }
        check("sidecar publish failure propagates", result.isFailure)
        check("orphan data file removed on sidecar-publish crash", crashedEnv.stagedNames().isEmpty(), crashedEnv.stagedNames().toString())
        check("sidecar-crash left nothing to upload", run {
            EvidenceUploadCore.uploadAll(crashedEnv)
            crashedEnv.requests.isEmpty() && crashedEnv.journal.entries.isEmpty()
        })
    }

    // 4b. ABRUPT process death between the data publish and the sidecar
    //     publish: no cleanup runs, so the published data file and the
    //     metadata temp survive. A restarted process must never upload the
    //     orphaned bytes — only a published sidecar triggers an upload.
    run {
        val root = tempRoot()
        val deadEnv = FakeEnv(root)
        deadEnv.dieRenameFor = ".meta-tmp" // dies with the data bytes already published
        val outcome = runCatching { EvidenceUploadCore.enqueue(deadEnv, sampleMeta(), SENTINEL_BYTES.toByteArray()) }
        check("abrupt sidecar-publish death is uncaught by the core", outcome.exceptionOrNull() is SimulatedDeath, outcome.exceptionOrNull()?.toString() ?: "no throw")
        val leftover = deadEnv.stagedNames()
        check("death leaves published bytes + metadata temp, no sidecar", leftover.size == 2 &&
            leftover.any { it.endsWith(".mp4") } && leftover.any { it.endsWith(".meta-tmp") }, leftover.toString())
        // "Restart": a fresh environment over the surviving directory.
        val restart = FakeEnv(root)
        EvidenceUploadCore.uploadAll(restart)
        check("orphaned bytes never upload without a sidecar", restart.requests.isEmpty() && restart.journal.entries.isEmpty())
        check("death residue left untouched for forensics", restart.stagedNames() == leftover, restart.stagedNames().toString())
    }

    // 5. Process death AFTER the sidecar publish but BEFORE any upload:
    //    the durable pair survives, a first failing attempt records
    //    RETRY_LATER and preserves the pair, and the retry uploads with the
    //    exact wire shape (method, headers, body) and removes the pair.
    run {
        val root = tempRoot()
        val env = FakeEnv(root)
        EvidenceUploadCore.enqueue(env, sampleMeta(), SENTINEL_BYTES.toByteArray())
        check("pair survives the pre-upload crash", env.stagedNames().size == 2, env.stagedNames().toString())
        // "Restart": a fresh env over the same directory, connection down.
        val offlineEnv = FakeEnv(root, scripts = listOf(Script.BlowUp(java.net.SocketTimeoutException("connect timed out"))))
        EvidenceUploadCore.uploadAll(offlineEnv)
        check("offline attempt records RETRY_LATER", offlineEnv.journal.outcomes() == listOf("RETRY_LATER"), offlineEnv.journal.entries.toString())
        check("RETRY_LATER preserves the pair", offlineEnv.stagedNames().size == 2, offlineEnv.stagedNames().toString())
        check("offline attempt cleared no credential", offlineEnv.credentials.clearCount == 0)
        // Retry with the server accepting.
        val onlineEnv = FakeEnv(root, scripts = listOf(Script.Status(201)))
        EvidenceUploadCore.uploadAll(onlineEnv)
        check("retry records UPLOADED", onlineEnv.journal.outcomes() == listOf("UPLOADED"), onlineEnv.journal.entries.toString())
        check("accepted upload removes the pair", onlineEnv.stagedNames().isEmpty(), onlineEnv.stagedNames().toString())
        val request = onlineEnv.requests.single()
        check("request is a POST", request.method == "POST")
        check("request body is the staged clip", request.body.toByteArray().contentEquals(SENTINEL_BYTES.toByteArray()))
        check("request carries the sidecar headers", request.headers["Content-Type"] == "video/mp4" &&
            request.headers["X-Cas-Evidence-Kind"] == "video" &&
            request.headers["X-Cas-Captured-At"] == "1726000000000" &&
            request.headers["X-Cas-Sequence"] == "3" &&
            request.headers["X-Cas-Capture-Request-Id"] == "req-1" &&
            request.headers["X-Cas-Evidence-Camera"] == "back", request.headers.toString())
        check("request streams the clip length", request.fixedLength == SENTINEL_BYTES.toByteArray().size.toLong())
        check("connection disconnected after the attempt", request.disconnected)
        // The core must never attach a credential itself: ConnectionConfig is
        // the single place the Bearer header comes from.
        check("core never sets Authorization", !request.headers.containsKey("Authorization"))
        check("incident id is URL-encoded in the path", onlineEnv.requestedPaths.single() ==
            "/api/cas/incidents/inc-1/evidence", onlineEnv.requestedPaths.toString())
    }

    // 6. Server outage (5xx): RETRY_LATER keeps the pair; a later pass
    //    delivers it. The clip is never lost to a transient status.
    run {
        val root = tempRoot()
        val env = FakeEnv(root)
        EvidenceUploadCore.enqueue(env, sampleMeta(), SENTINEL_BYTES.toByteArray())
        val outage = FakeEnv(root, scripts = listOf(Script.Status(503), Script.Status(200)))
        EvidenceUploadCore.uploadAll(outage)
        check("5xx records RETRY_LATER", outage.journal.outcomes() == listOf("RETRY_LATER"), outage.journal.entries.toString())
        check("5xx preserves the pair", outage.stagedNames().size == 2)
        check("5xx cleared no credential", outage.credentials.clearCount == 0)
        EvidenceUploadCore.uploadAll(outage)
        check("retry after outage uploads", outage.journal.outcomes() == listOf("RETRY_LATER", "UPLOADED"), outage.journal.entries.toString())
        check("pair removed after recovery", outage.stagedNames().isEmpty())
    }

    // 7. Terminal outcomes remove the pair SIDECAR-FIRST: a process death
    //    between the two deletes must leave a state that cannot replay an
    //    already-accepted clip. Proven for both acceptance and rejection by
    //    recording the delete order.
    run {
        for (status in listOf(200, 422)) {
            val root = tempRoot()
            val env = FakeEnv(root)
            val sidecar = EvidenceUploadCore.enqueue(env, sampleMeta(), SENTINEL_BYTES.toByteArray())
            val id = sidecar.nameWithoutExtension
            val runEnv = FakeEnv(root, scripts = listOf(Script.Status(status)))
            EvidenceUploadCore.uploadAll(runEnv)
            val expectedOutcome = if (status in 200..299) "UPLOADED" else "REJECTED"
            check("status $status records $expectedOutcome", runEnv.journal.outcomes() == listOf(expectedOutcome), runEnv.journal.entries.toString())
            check(
                "status $status deletes sidecar before data",
                runEnv.deleteLog == listOf("$id.json", "$id.mp4"),
                runEnv.deleteLog.toString(),
            )
            check("status $status leaves nothing staged", runEnv.stagedNames().isEmpty(), runEnv.stagedNames().toString())
            check("status $status cleared no credential", runEnv.credentials.clearCount == 0)
        }
    }

    // 8. Process death DURING the terminal delete (sidecar gone, data delete
    //    never completed): re-running uploadAll must NOT re-upload the clip —
    //    the sidecar is the upload trigger, so the orphaned bytes strand
    //    without ever reaching the server twice.
    run {
        val root = tempRoot()
        val env = FakeEnv(root)
        val sidecar = EvidenceUploadCore.enqueue(env, sampleMeta(), SENTINEL_BYTES.toByteArray())
        val id = sidecar.nameWithoutExtension
        val crashMidDelete = FakeEnv(root, scripts = listOf(Script.Status(200)))
        crashMidDelete.failDeleteFor = "$id.mp4"
        EvidenceUploadCore.uploadAll(crashMidDelete)
        check("mid-delete crash still recorded UPLOADED", crashMidDelete.journal.outcomes() == listOf("UPLOADED"))
        check("mid-delete crash removed the sidecar", !File(root, "evidence-pending/$id.json").exists())
        check("mid-delete crash left the data orphan", File(root, "evidence-pending/$id.mp4").exists())
        // "Restart" and retry: the sidecar is gone, so the orphan is never replayed.
        val afterRestart = FakeEnv(root)
        EvidenceUploadCore.uploadAll(afterRestart)
        check("orphaned bytes are never re-uploaded", afterRestart.requests.isEmpty())
        check("orphan replay attempt journals nothing", afterRestart.journal.entries.isEmpty())
    }

    // 9. A 401 rejects the enrolled credential exactly once: the pair is
    //    removed (the server permanently refused it) and the cleared
    //    credential makes the NEXT pending clip drop without any network
    //    attempt — no second clear, no dead-credential traffic.
    run {
        val root = tempRoot()
        val env = FakeEnv(root)
        EvidenceUploadCore.enqueue(env, sampleMeta(incidentId = "inc-1"), SENTINEL_BYTES.toByteArray())
        EvidenceUploadCore.enqueue(env, sampleMeta(incidentId = "inc-2"), SENTINEL_BYTES.toByteArray())
        check("two clips staged", env.stagedNames().size == 4)
        val revoked = FakeEnv(root, scripts = listOf(Script.Status(401)))
        EvidenceUploadCore.uploadAll(revoked)
        check("401 journals REJECTED for the first clip", revoked.journal.outcomes().first() == "REJECTED", revoked.journal.entries.toString())
        check("401 clears the credential exactly once", revoked.credentials.clearCount == 1, "clears=${revoked.credentials.clearCount}")
        check("second clip drops with no credential", revoked.journal.outcomes().last() == "DROPPED", revoked.journal.entries.toString())
        check("dropped clip made no network attempt", revoked.requests.size == 1, "requests=${revoked.requests.size}")
        check("both pairs removed after 401 sweep", revoked.stagedNames().isEmpty(), revoked.stagedNames().toString())
        // A later pass over an empty directory must not clear again.
        val stillRevoked = FakeEnv(root)
        EvidenceUploadCore.uploadAll(stillRevoked)
        check("empty pass clears nothing", stillRevoked.credentials.clearCount == 0)
    }

    // 10. No enrolled credential at all (never enrolled, or cleared earlier):
    //     the pair is dropped sidecar-first with a DROPPED journal entry and
    //     no network attempt — the endpoints accept nothing else, so keeping
    //     the bytes would strand them forever. A blank server URL behaves the
    //     same way.
    run {
        for (blank in listOf("token", "url")) {
            val root = tempRoot()
            val env = FakeEnv(root)
            val sidecar = EvidenceUploadCore.enqueue(env, sampleMeta(), SENTINEL_BYTES.toByteArray())
            val id = sidecar.nameWithoutExtension
            val noAuth = FakeEnv(root)
            if (blank == "token") noAuth.credentials.token = "" else noAuth.credentials.serverUrl = ""
            EvidenceUploadCore.uploadAll(noAuth)
            check("blank $blank records DROPPED", noAuth.journal.outcomes() == listOf("DROPPED"), noAuth.journal.entries.toString())
            check("blank $blank made no network attempt", noAuth.requests.isEmpty())
            check(
                "blank $blank deletes sidecar before data",
                noAuth.deleteLog == listOf("$id.json", "$id.mp4"),
                noAuth.deleteLog.toString(),
            )
            check("blank $blank cleared no credential", noAuth.credentials.clearCount == 0)
        }
    }

    // 11. Degraded staged state never uploads garbage: a sidecar whose bytes
    //     are gone, a corrupt sidecar, an unknown kind, and orphan files from
    //     a dead enqueue all record RETRY_LATER (or are ignored) with the
    //     staged state preserved for the next pass.
    run {
        val env = FakeEnv(tempRoot())
        // Orphan temp from a dead enqueue: must be ignored entirely.
        File(env.pendingDirectory(), "dead-enqueue.tmp").writeBytes(SENTINEL_BYTES.toByteArray())
        // Orphan data file whose sidecar never published: must never upload.
        File(env.pendingDirectory(), "orphan.mp4").writeBytes(SENTINEL_BYTES.toByteArray())
        // Sidecar with missing bytes.
        File(env.pendingDirectory(), "missing.json").writeText(
            org.json.JSONObject().put("incidentId", "inc-1").put("kind", "video")
                .put("capturedAtMs", 1L).put("sequence", 1).put("contentType", "video/mp4").toString(),
        )
        // Corrupt sidecar.
        File(env.pendingDirectory(), "corrupt.json").writeText("{not json")
        // Unknown kind.
        File(env.pendingDirectory(), "badkind.json").writeText(
            org.json.JSONObject().put("incidentId", "inc-1").put("kind", "notes")
                .put("capturedAtMs", 1L).put("sequence", 1).put("contentType", "text/plain").toString(),
        )
        EvidenceUploadCore.uploadAll(env)
        check("degraded state opens no connection", env.requests.isEmpty())
        check(
            "degraded sidecars all record RETRY_LATER",
            env.journal.outcomes() == listOf("RETRY_LATER", "RETRY_LATER", "RETRY_LATER"),
            env.journal.entries.toString(),
        )
        check("missing-bytes detail survives", env.journal.entries.any { it.second["detail"] == "missing bytes" })
        check("invalid-kind detail survives", env.journal.entries.any { it.second["detail"] == "invalid kind" })
        check("degraded staged state preserved", env.stagedNames().toSet() == setOf(
            "dead-enqueue.tmp", "orphan.mp4", "missing.json", "corrupt.json", "badkind.json",
        ), env.stagedNames().toString())
    }

    // 12. uploadAll isolates a per-clip failure: a corrupt sidecar between
    //     two healthy clips cannot abort the pass or drop the healthy
    //     uploads.
    run {
        val root = tempRoot()
        val env = FakeEnv(root)
        EvidenceUploadCore.enqueue(env, sampleMeta(incidentId = "inc-a"), SENTINEL_BYTES.toByteArray())
        File(env.pendingDirectory(), "zz-corrupt.json").writeText("{broken")
        EvidenceUploadCore.enqueue(env, sampleMeta(incidentId = "inc-b"), SENTINEL_BYTES.toByteArray())
        val runEnv = FakeEnv(root, scripts = listOf(Script.Status(200), Script.Status(200)))
        EvidenceUploadCore.uploadAll(runEnv)
        check("both healthy clips uploaded", runEnv.journal.outcomes().count { it == "UPLOADED" } == 2, runEnv.journal.entries.toString())
        check("corrupt sidecar journaled RETRY_LATER", runEnv.journal.outcomes().count { it == "RETRY_LATER" } == 1)
        check("healthy pairs removed, corrupt kept", runEnv.stagedNames() == listOf("zz-corrupt.json"), runEnv.stagedNames().toString())
    }

    if (failures > 0) {
        println("EVIDENCE_UPLOAD_FAILED failures=$failures checks=$checks")
        kotlin.system.exitProcess(1)
    }
    println("EVIDENCE_UPLOAD_OK checks=$checks")
}
