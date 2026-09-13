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

get_prop() {
  adb shell getprop "$1" 2>/dev/null | tr -d '\r' | tail -n 1
}

record_environment() {
  local qemu avd api abi model device product release security_patch fingerprint hardware
  qemu="$(get_prop ro.kernel.qemu)"
  avd="$(get_prop ro.boot.qemu.avd_name)"
  if [[ "$qemu" == "1" && -z "$avd" ]]; then
    avd="$(adb emu avd name 2>/dev/null | tr -d '\r' | grep -v '^OKAY' | head -n 1 || true)"
  fi
  api="$(get_prop ro.build.version.sdk)"
  abi="$(get_prop ro.product.cpu.abilist)"
  model="$(get_prop ro.product.model)"
  device="$(get_prop ro.product.device)"
  product="$(get_prop ro.product.name)"
  release="$(get_prop ro.build.version.release)"
  security_patch="$(get_prop ro.build.version.security_patch)"
  fingerprint="$(get_prop ro.build.fingerprint)"
  hardware="$(get_prop ro.hardware)"

  if [[ "$qemu" == "1" || -n "$avd" ]]; then
    EVIDENCE_CLASS="simulated-emulator"
    echo "evidenceClass=simulated-emulator" | tee -a "$OUT"
    echo "physicalReadinessProof=false" | tee -a "$OUT"
    echo "avdName=${avd:-unknown}" | tee -a "$OUT"
    echo "image=system-images;android-35;google_apis;x86_64" | tee -a "$OUT"
    echo "apiLevel=$api abiList=$abi" | tee -a "$OUT"
    echo "model=$model device=$device product=$product" | tee -a "$OUT"
    echo "androidRelease=$release securityPatch=$security_patch" | tee -a "$OUT"
    echo "hardware=$hardware" | tee -a "$OUT"
    echo "buildFingerprint=$fingerprint" | tee -a "$OUT"

    [[ "$avd" == "CAS_Pixel_8a_API_35" ]] || {
      echo "BLOCKED: expected pinned AVD CAS_Pixel_8a_API_35, found ${avd:-unknown}" | tee -a "$OUT"
      exit 2
    }
    [[ "$api" == "35" ]] || {
      echo "BLOCKED: expected Android API 35, found ${api:-unknown}" | tee -a "$OUT"
      exit 2
    }
    [[ ",$abi," == *",x86_64,"* ]] || {
      echo "BLOCKED: expected x86_64 emulator ABI, found ${abi:-unknown}" | tee -a "$OUT"
      exit 2
    }
  else
    EVIDENCE_CLASS="physical-device-observation"
    echo "evidenceClass=physical-device-observation" | tee -a "$OUT"
    echo "physicalReadinessProof=requires-managed-Pixel-observer-review" | tee -a "$OUT"
    echo "This is not emulator evidence; repeat the required observations on the managed Pixel." | tee -a "$OUT"
  fi
}

run_sample() {
  local label="$1"
  local before after
  before="$(date +%s%3N)"
  adb shell am start -W -a "$PROXY_ACTION" -f 0x10000000 | tee -a "$OUT"
  after="$(date +%s%3N)"
  printf '%s hostStartMs=%s hostEndMs=%s hostElapsedMs=%s\n' "$label" "$before" "$after" "$((after-before))" | tee -a "$OUT"
}

echo "Gate 0A run started (UTC $(date -u +%FT%TZ))" | tee "$OUT"
record_environment
echo "runBoundary=$EVIDENCE_CLASS" | tee -a "$OUT"
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