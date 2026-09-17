#!/usr/bin/env bash
# Gate 0A emulator smoke test: install the debug APK, launch MainActivity,
# and verify the process survives with no fatal logcat entries.
#
# Invoked from .github/workflows/android-test-package-build.yml as a single
# line because reactivecircus/android-emulator-runner executes each line of
# its `script:` input as a separate `sh -c` call — multi-line constructs
# (if/fi blocks, variables) do not survive across lines there.
set -euo pipefail

apk="apk/app-debug.apk"
if [ ! -f "$apk" ]; then
  echo "::error::Downloaded APK missing at $apk"
  exit 1
fi

adb install -r "$apk"

# Clear logcat after install noise so crash detection below only sees
# output produced by the launch itself.
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

echo "Smoke test passed: MainActivity launched, process alive (pid $pid), no fatal logcat entries."
