#!/usr/bin/env bash
# Gate 0A emulator smoke test: install the debug APK, then exercise every app
# entry point — MainActivity, TriggerActivity (PROXY_TRIGGER), BootReceiver
# (BOOT_COMPLETED), EvidenceCaptureService (every capture kind must journal
# CAPTURED on the pinned CI image), and BootReceiver (LOCKED_BOOT_COMPLETED
# in the real pre-unlock/direct-boot state) — verifying the process survives
# with no fatal logcat entries.
#
# Invoked from .github/workflows/android-test-package-build.yml as a single
# line because reactivecircus/android-emulator-runner executes each line of
# its `script:` input as a separate `sh -c` call — multi-line constructs
# (if/fi blocks, loops, variables) do not survive across lines there, and
# /usr/bin/sh is dash on Ubuntu (no pipefail).
set -euo pipefail

apk="apk/app-debug.apk"
if [ ! -f "$apk" ]; then
  echo "::error::Downloaded APK missing at $apk"
  exit 1
fi
adb install -r "$apk"
# Clear logcat after install noise so crash detection below only
# sees output produced by the launch itself.
adb logcat -c
if ! adb shell am start -W -n com.covertalert.pixeltest/.MainActivity; then
  echo "::error::am start failed — MainActivity did not launch."
  adb logcat -d | tail -200
  exit 1
fi
sleep 8
pid="$(adb shell pidof com.covertalert.pixeltest || true)"
if [ -z "$pid" ]; then
  echo "::error::App process is not running 8s after launch — crash on launch."
  # Surface the fatal block itself first: on a slow or noisy
  # emulator the crash can scroll out of a plain tail -200.
  adb logcat -d | grep -B2 -A30 'FATAL EXCEPTION' || true
  adb logcat -d | tail -200
  exit 1
fi
crashes="$(adb logcat -d | grep -E 'FATAL EXCEPTION|AndroidRuntime: FATAL|Force finishing activity com\.covertalert\.pixeltest' || true)"
if [ -n "$crashes" ]; then
  echo "::error::Fatal crash detected in logcat after MainActivity launch."
  echo "$crashes"
  adb logcat -d | tail -200
  exit 1
fi
echo "MainActivity check passed: launched, process alive (pid $pid), no fatal logcat entries."
# Second entry point: the pinned field shortcut fires the
# PROXY_TRIGGER intent, which opens TriggerActivity. A crash there
# (bad theme, shortcuts.xml mismatch, onCreate assumption) would
# otherwise only be discovered on the field device. Re-clear
# logcat so the checks below only see output from this launch.
adb logcat -c
if ! adb shell am start -W -a com.covertalert.pixeltest.action.PROXY_TRIGGER; then
  echo "::error::am start failed — PROXY_TRIGGER intent did not resolve to TriggerActivity."
  adb logcat -d | tail -200
  exit 1
fi
sleep 8
# TriggerActivity finishes itself after forwarding, but the app
# process (still hosting MainActivity) must survive; an uncaught
# exception in TriggerActivity kills the whole process.
pid="$(adb shell pidof com.covertalert.pixeltest || true)"
if [ -z "$pid" ]; then
  echo "::error::App process is not running 8s after PROXY_TRIGGER launch — TriggerActivity crashed."
  adb logcat -d | tail -200
  exit 1
fi
crashes="$(adb logcat -d | grep -E 'FATAL EXCEPTION|AndroidRuntime: FATAL|Force finishing activity com\.covertalert\.pixeltest' || true)"
if [ -n "$crashes" ]; then
  echo "::error::Fatal crash detected in logcat after PROXY_TRIGGER launch."
  echo "$crashes"
  adb logcat -d | tail -200
  exit 1
fi
echo "TriggerActivity check passed: PROXY_TRIGGER launched, process alive (pid $pid), no fatal logcat entries."
# Third entry point: BootReceiver handles BOOT_COMPLETED (the
# field device must survive a reboot). A crash here (bad
# direct-boot assumption, Theme/context misuse) would otherwise
# only be discovered on the field device after a reboot.
# BOOT_COMPLETED is a protected broadcast: the default adb shell
# user (uid 2000) is NOT permitted to send it on API 35
# (SecurityException, verified on a real emulator), but the
# google_apis image is rootable — restart adbd as root first.
adb root
adb wait-for-device
if ! adb shell id | grep -q "uid=0"; then
  echo "::error::adb root did not yield a root shell — cannot send the protected BOOT_COMPLETED broadcast."
  exit 1
fi
# Re-clear logcat so the checks below only see output from this
# broadcast.
adb logcat -c
if ! adb shell am broadcast -a android.intent.action.BOOT_COMPLETED -p com.covertalert.pixeltest; then
  echo "::error::am broadcast failed — BOOT_COMPLETED was not delivered to BootReceiver."
  adb logcat -d | tail -200
  exit 1
fi
sleep 8
# A crashing receiver kills the hosting app process, so the
# process started by MainActivity above must still be alive.
pid="$(adb shell pidof com.covertalert.pixeltest || true)"
if [ -z "$pid" ]; then
  echo "::error::App process is not running 8s after BOOT_COMPLETED — BootReceiver crashed."
  adb logcat -d | grep -B2 -A30 'FATAL EXCEPTION' || true
  adb logcat -d | tail -200
  exit 1
fi
crashes="$(adb logcat -d | grep -E 'FATAL EXCEPTION|AndroidRuntime: FATAL|Force finishing activity com\.covertalert\.pixeltest' || true)"
if [ -n "$crashes" ]; then
  echo "::error::Fatal crash detected in logcat after BOOT_COMPLETED broadcast."
  echo "$crashes"
  adb logcat -d | tail -200
  exit 1
fi
echo "BootReceiver (BOOT_COMPLETED) check passed: broadcast delivered, process alive (pid $pid), no fatal logcat entries."
# Fourth entry point: EvidenceCaptureService — the bounded evidence
# playground (still via Camera2, video via Camera2+MediaRecorder, audio
# via MediaRecorder, durable staging + upload retry). A runtime regression
# here — a camera-session misconfiguration that throws on every capture, a
# MediaRecorder state mistake, a foreground-service-type mismatch —
# compiles cleanly and would otherwise only surface during a hardware run.
# The emulator's virtual camera/mic let CI start the service, let it
# attempt every capture kind, and assert the device journal records
# CAPTURED for every kind. The pinned CI image (API 35 google_apis,
# pixel_6, x86_64, with the job's emulator options) demonstrably captures
# all three kinds — verified locally on the same image, audio included
# even with -no-audio — so a FAILED here is a real capture regression (the
# service's per-kind catch turns camera/recorder errors into FAILED
# events), not emulated-hardware variance. Crashes, hangs, and start
# failures go red through the fast paths below. One retry of the whole
# capture cycle with fresh app state absorbs transient emulator
# codec/camera readiness (seen locally under TCG: MediaRecorder
# "prepare failed" while OMX was still coming up); a systematic
# regression fails both attempts and still goes red.
#
# Ordering constraints:
#  - The service is non-exported, so the start needs the root shell
#    acquired for the BOOT_COMPLETED phase above.
#  - It is a while-in-use camera+microphone foreground service: on API 34+
#    the app must be foreground-eligible when the service starts, so
#    MainActivity is brought back to the front first.
#  - This phase MUST stay before the PIN-protected reboot phase below:
#    once the lockscreen PIN is set and the device reboots locked,
#    camera/mic capture is impossible.
capture_timeout_s="${CAS_CAPTURE_TIMEOUT_S:-420}"
capture_poll_s="${CAS_CAPTURE_POLL_S:-10}"
journal_path="/data/user_de/0/com.covertalert.pixeltest/shared_prefs/gate0a-local-journal.xml"
capture_attempt=1
capture_passed=""
capture_bad=""
capture_bad_detail=""
while [ "$capture_attempt" -le 2 ]; do
  # Wipe app state before EVERY attempt, not just the retry: on a reused
  # device the journal still holds prior runs' EVIDENCE_CAPTURE events, and
  # a stale all-CAPTURED journal would green this phase without the service
  # even running. pm clear also revokes the runtime permissions granted
  # below, so the grant must stay inside the attempt loop.
  if [ "$capture_attempt" -eq 2 ]; then
    echo "Capture attempt 1 did not CAPTURE every kind:$capture_bad_detail"
    echo "Retrying once with fresh app state — transient emulator codec/camera readiness gets a second chance; a systematic regression fails both attempts."
  fi
  adb shell pm clear com.covertalert.pixeltest > /dev/null
  for perm in android.permission.CAMERA android.permission.RECORD_AUDIO; do
    if ! adb shell pm grant com.covertalert.pixeltest "$perm"; then
      echo "::error::pm grant $perm failed — cannot exercise evidence capture."
      exit 1
    fi
  done
  if ! adb shell am start -W -n com.covertalert.pixeltest/.MainActivity > /dev/null; then
    echo "::error::am start failed — MainActivity did not relaunch to the foreground before evidence capture."
    adb logcat -d | tail -200
    exit 1
  fi
  # Re-clear logcat after the relaunch so the fatal check below only sees
  # output from this attempt's capture.
  adb logcat -c
  if ! adb shell am start-foreground-service \
      -n com.covertalert.pixeltest/.EvidenceCaptureService \
      --es incident_id ci-emulator-smoke \
      --esa kinds photo,video,audio; then
    echo "::error::am start-foreground-service failed — EvidenceCaptureService did not start."
    adb logcat -d | tail -200
    exit 1
  fi
  # Poll the device-protected journal until every requested kind has an
  # EVIDENCE_CAPTURE outcome. Bounds are env-overridable so the no-emulator
  # detection harness (verify-launch-smoke-detection.sh) can run the timeout
  # path in seconds; CI uses the defaults. 7 minutes covers the worst case:
  # six 30s audio segments + 20s video + still/video camera setup.
  elapsed=0
  capture_done=""
  missing=""
  journal=""
  while [ "$elapsed" -lt "$capture_timeout_s" ]; do
    # A fatal in the service kills the app process; stop waiting as soon as
    # one is visible instead of burning the whole timeout. The FATAL block
    # names its process on the following lines, so another component's crash
    # cannot false-positive here. A crash is a deterministic defect, so it
    # goes red immediately — no retry.
    if adb logcat -d | grep -A2 'FATAL EXCEPTION' | grep -q 'Process: com.covertalert.pixeltest'; then
      echo "::error::EvidenceCaptureService crashed — FATAL EXCEPTION for com.covertalert.pixeltest during capture."
      adb logcat -d | grep -B2 -A30 'FATAL EXCEPTION' || true
      adb logcat -d | tail -200
      exit 1
    fi
    # SharedPreferences XML escapes JSON quotes as &quot;; unescape before
    # matching (a no-op if the quotes are already literal).
    journal="$(adb shell cat "$journal_path" 2>/dev/null | sed 's/&quot;/"/g' | tr -d '\n' || true)"
    # A start failure (missing permission, startForeground throwing, bad FGS
    # type) is terminal — the service stopped itself, so waiting for
    # EVIDENCE_CAPTURE outcomes would just burn the whole timeout. Like a
    # crash this is deterministic, so it goes red immediately — no retry.
    # The journal is fresh per attempt (pm clear above), so this event can
    # only come from this attempt.
    start_failed="$(printf '%s' "$journal" | grep -o '{"type":"CAPTURE_START_FAILED"[^{}]*}' | head -1 || true)"
    if [ -n "$start_failed" ]; then
      echo "::error::EvidenceCaptureService failed before any capture: $start_failed"
      adb logcat -d | tail -200
      exit 1
    fi
    missing=""
    for kind in photo video audio; do
      event="$(printf '%s' "$journal" | grep -o "{\"type\":\"EVIDENCE_CAPTURE\"[^{}]*\"kind\":\"$kind\"[^{}]*}" | head -1 || true)"
      if [ -z "$event" ]; then missing="$missing $kind"; fi
    done
    if [ -z "$missing" ]; then capture_done=1; break; fi
    sleep "$capture_poll_s"
    elapsed=$((elapsed + capture_poll_s))
  done
  if [ -z "$capture_done" ]; then
    echo "::error::No EVIDENCE_CAPTURE outcome recorded for kind(s):$missing within ${capture_timeout_s}s — the service hung, never ran, or died before journaling."
    echo "$journal"
    adb logcat -d | tail -200
    exit 1
  fi
  # Every kind must be CAPTURED. A FAILED — however clean its detail — means
  # capture is broken on an image where it demonstrably works; collect the
  # failing kinds and retry once before going red.
  capture_bad=""
  capture_bad_detail=""
  for kind in photo video audio; do
    event="$(printf '%s' "$journal" | grep -o "{\"type\":\"EVIDENCE_CAPTURE\"[^{}]*\"kind\":\"$kind\"[^{}]*}" | head -1 || true)"
    if printf '%s' "$event" | grep -q '"outcome":"CAPTURED"'; then
      echo "  $kind: CAPTURED"
    else
      echo "  $kind: not CAPTURED — $event"
      capture_bad="$capture_bad $kind"
      capture_bad_detail="$capture_bad_detail [$kind: $event]"
    fi
  done
  if [ -z "$capture_bad" ]; then capture_passed=1; break; fi
  capture_attempt=$((capture_attempt + 1))
done
if [ -z "$capture_passed" ]; then
  echo "::error::EVIDENCE_CAPTURE still not CAPTURED for kind(s)$capture_bad on the pinned CI image after a fresh-state retry — capture regression:$capture_bad_detail"
  adb logcat -d | tail -200
  exit 1
fi
echo "EvidenceCaptureService check passed: photo, video, and audio all CAPTURED on the emulator; no fatal logcat entries."
# Fifth entry point: the REAL pre-unlock (direct-boot) path.
# BootReceiver is directBootAware and handles LOCKED_BOOT_COMPLETED,
# delivered by the system BEFORE the user unlocks the device.
# Injecting that action with `am broadcast` after unlock would NOT
# exercise direct boot: credential-encrypted (CE) storage is
# already available then, so a regression that touches CE storage
# in onReceive (e.g. TestStore switched from
# createDeviceProtectedStorageContext to plain getSharedPreferences)
# would stay green here and only crash on a field device rebooting
# to the lock screen. Instead: set a lockscreen PIN so the next
# boot keeps user 0 LOCKED until credentials are entered, reboot,
# and let the SYSTEM deliver LOCKED_BOOT_COMPLETED naturally in
# the direct-boot phase. Uses the root shell acquired above;
# locksettings needs it (and a userdebug/google_apis image).
if ! adb shell locksettings set-pin 1234; then
  echo "::error::locksettings set-pin failed — cannot force the emulator into the locked (direct-boot) state."
  exit 1
fi
# Calibrate the locked-state probe while the device is known to be
# unlocked: CE storage must report available. If it does not read
# "true" here, the property cannot prove anything after the reboot
# and this job must fail loudly rather than claim direct-boot
# coverage it cannot verify.
ce_now="$(adb shell getprop sys.user.0.ce_available | tr -d '[:space:]')"
if [ "$ce_now" != "true" ]; then
  echo "::error::sys.user.0.ce_available reads '$ce_now' on an unlocked emulator — the locked-state probe is untrustworthy; refusing to claim direct-boot coverage."
  exit 1
fi
# Re-clear logcat so post-reboot output belongs to the locked-boot
# phase only (the natural LOCKED_BOOT_COMPLETED delivery happens
# during boot, before we could clear).
adb logcat -c
adb reboot
adb wait-for-device
booted=""
for i in $(seq 1 60); do
  bc="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')"
  if [ "$bc" = "1" ]; then booted=1; break; fi
  sleep 5
done
if [ -z "$booted" ]; then
  echo "::error::Emulator did not finish the PIN-protected reboot within 5 minutes."
  exit 1
fi
# adbd may drop root across the reboot; re-acquire it before
# reading /data/user_de below.
adb root
adb wait-for-device
if ! adb shell id | grep -q "uid=0"; then
  echo "::error::adb root did not yield a root shell after reboot — cannot read device-protected storage for the delivery-evidence check."
  exit 1
fi
# Explicitly assert the precondition that makes this phase
# meaningful: user 0 is STILL LOCKED (credential-encrypted storage
# unavailable). Without this, everything below proves nothing
# about the pre-unlock path.
ce_after="$(adb shell getprop sys.user.0.ce_available | tr -d '[:space:]')"
if [ "$ce_after" = "true" ]; then
  echo "::error::sys.user.0.ce_available is still 'true' after a PIN-protected reboot — the device is NOT in the locked/direct-boot state; cannot validate the pre-unlock path."
  exit 1
fi
echo "Locked-state precondition holds: user 0 still locked after PIN-protected reboot (ce_available='$ce_after', was 'true' while unlocked)."
adb shell dumpsys user | grep -E '^[[:space:]]+0: ' || true
sleep 5
# Crash detection, scoped to our package (FATAL EXCEPTION blocks
# name the process on the following lines, so another component's
# boot-time crash cannot false-positive here). Note pidof is NOT
# a valid detector in this phase: pre-unlock the app has no reason
# to keep a process alive after the receiver returns.
if adb logcat -d | grep -A2 'FATAL EXCEPTION' | grep -q 'Process: com.covertalert.pixeltest'; then
  echo "::error::BootReceiver crashed during locked (pre-unlock) boot — FATAL EXCEPTION for com.covertalert.pixeltest in logcat."
  adb logcat -d | grep -B2 -A30 'FATAL EXCEPTION' || true
  adb logcat -d | tail -200
  exit 1
fi
# Delivery evidence: BootReceiver journals BOOT_OBSERVED into
# device-protected storage (TestStore), which is exactly the
# storage available pre-unlock. Assert the LOCKED_BOOT_COMPLETED
# event is there — without this the phase would be green even if
# the receiver silently never ran (e.g. a manifest regression
# dropping directBootAware or the intent-filter).
journal="$(adb shell cat /data/user_de/0/com.covertalert.pixeltest/shared_prefs/gate0a-local-journal.xml 2>/dev/null || true)"
if ! echo "$journal" | grep -q 'LOCKED_BOOT_COMPLETED'; then
  echo "::error::No LOCKED_BOOT_COMPLETED event in the device-protected journal — BootReceiver did not record the pre-unlock broadcast (or never ran)."
  echo "$journal"
  adb logcat -d | tail -200
  exit 1
fi
echo "Smoke test passed: MainActivity, TriggerActivity (PROXY_TRIGGER), BootReceiver (BOOT_COMPLETED), EvidenceCaptureService (photo/video/audio all CAPTURED), and BootReceiver (LOCKED_BOOT_COMPLETED, verified while user 0 locked) all exercised; pre-unlock journal entry present; no fatal logcat entries."
