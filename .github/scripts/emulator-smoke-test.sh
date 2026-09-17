#!/usr/bin/env bash
# Gate 0A emulator smoke test: install the debug APK, then exercise every app
# entry point — MainActivity, TriggerActivity (PROXY_TRIGGER), BootReceiver
# (BOOT_COMPLETED), and BootReceiver (LOCKED_BOOT_COMPLETED in the real
# pre-unlock/direct-boot state) — verifying the process survives with no
# fatal logcat entries.
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
# Fourth entry point: the REAL pre-unlock (direct-boot) path.
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
echo "Smoke test passed: MainActivity, TriggerActivity (PROXY_TRIGGER), BootReceiver (BOOT_COMPLETED), and BootReceiver (LOCKED_BOOT_COMPLETED, verified while user 0 locked) all exercised; pre-unlock journal entry present; no fatal logcat entries."
