#!/usr/bin/env bash
set -euo pipefail

# Run from a workstation with adb and an installed debug APK.
# This script only launches the local proxy and records host-side timing markers;
# it never sends a message, captures evidence, or changes device policy.
PACKAGE="com.covertalert.pixeltest"
PROXY_ACTION="$PACKAGE.action.PROXY_TRIGGER"
OUT="${1:-gate0a-$(date -u +%Y%m%dT%H%M%SZ).log}"

adb wait-for-device
adb shell pm path "$PACKAGE" >/dev/null

run_sample() {
  local label="$1"
  local before after
  before="$(date +%s%3N)"
  adb shell am start -W -a "$PROXY_ACTION" -f 0x10000000 | tee -a "$OUT"
  after="$(date +%s%3N)"
  printf '%s hostStartMs=%s hostEndMs=%s hostElapsedMs=%s\n' "$label" "$before" "$after" "$((after-before))" | tee -a "$OUT"
}

echo "Gate 0A run started (UTC $(date -u +%FT%TZ))" | tee "$OUT"
run_sample "cold-or-first"
run_sample "warm"

echo "Unlock the device if needed, then press Enter for locked-screen sample." | tee -a "$OUT"
read -r
adb shell input keyevent KEYCODE_POWER || true
run_sample "locked"
adb shell input keyevent KEYCODE_POWER || true

echo "Rebooting device for the post-reboot sample." | tee -a "$OUT"
adb reboot
adb wait-for-device
until adb shell getprop sys.boot_completed 2>/dev/null | grep -q '^1'; do sleep 2; done
run_sample "after-reboot"

echo "Host measurements saved to $OUT. Copy the in-app JSON report and attach both to the CAS Gate 0A observation." | tee -a "$OUT"