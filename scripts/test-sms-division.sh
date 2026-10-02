#!/usr/bin/env bash
set -euo pipefail

# Repo-only JVM harness for the handset's app-owned SMS division and the
# alert-server URL entry policy.
#
# SmsSegmenter.kt replaces the platform's SmsManager.divideMessage, which
# is field-proven broken on the Pixel (Android 17 / API 37): the old
# single-part fallback then died on the radio with
# RESULT_ERROR_GENERIC_FAILURE once the alert body outgrew one segment.
# This harness proves — without a device — that over-long bodies split into
# valid GSM-7/Unicode segments (single 160 septets / 70 units, concatenated
# 153 / 67), that escape and surrogate pairs never split across segments,
# that the app's segments go out even when the platform divider still
# throws, and that a body is sent as ONE part only when it genuinely fits.
# ServerUrlPolicy.kt's entry-time rejections (whitespace, unparseable host,
# the https-or-loopback rule) are proven alongside, closing the paste-
# artifact "Invalid host" wedge in update checks.
#
# Toolchain: same pinned kotlinc as scripts/test-receipt-durability.sh
# (shared cache). Nothing here ships in the APK or the field kit.
#
# Usage: scripts/test-sms-division.sh
# Prints: SMS_DIVISION_OK checks=<n>

readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SEGMENTER="$REPO_ROOT/artifacts/covert-alert-system/android-test-package/app/src/main/java/com/covertalert/pixeltest/SmsSegmenter.kt"
readonly URL_POLICY="$REPO_ROOT/artifacts/covert-alert-system/android-test-package/app/src/main/java/com/covertalert/pixeltest/ServerUrlPolicy.kt"
readonly HARNESS="$REPO_ROOT/scripts/sms-division/SmsDivisionHarness.kt"
readonly CACHE="$REPO_ROOT/scripts/.cache/receipt-durability" # shared pinned toolchain cache

readonly KOTLIN_VERSION="2.0.21"
readonly KOTLIN_ZIP_SHA256="0352c0a45bd22f80f6b26e485cd04da8047baa5de54865281fb9f89a4a7bcf2a"

fetch() { # url, dest, sha256
  local url="$1" dest="$2" sha256="$3"
  if [ -f "$dest" ] && echo "$sha256  $dest" | sha256sum -c - > /dev/null 2>&1; then
    return 0
  fi
  mkdir -p "$(dirname "$dest")"
  echo "Downloading $(basename "$dest")..." >&2
  curl -fsSL "$url" -o "$dest.tmp"
  echo "$sha256  $dest.tmp" | sha256sum -c - > /dev/null
  mv "$dest.tmp" "$dest"
}

find_kotlinc() {
  if command -v kotlinc > /dev/null 2>&1; then
    command -v kotlinc
    return 0
  fi
  local zip="$CACHE/kotlin-compiler-$KOTLIN_VERSION.zip"
  fetch "https://github.com/JetBrains/kotlin/releases/download/v$KOTLIN_VERSION/kotlin-compiler-$KOTLIN_VERSION.zip" \
    "$zip" "$KOTLIN_ZIP_SHA256"
  if [ ! -x "$CACHE/kotlinc/bin/kotlinc" ]; then
    unzip -q -o "$zip" -d "$CACHE"
  fi
  echo "$CACHE/kotlinc/bin/kotlinc"
}

KOTLINC="$(find_kotlinc)"

BUILD="$CACHE/build-sms-division"
rm -rf "$BUILD"
mkdir -p "$BUILD"

"$KOTLINC" "$SEGMENTER" "$URL_POLICY" "$HARNESS" -include-runtime -d "$BUILD/harness.jar"
java -cp "$BUILD/harness.jar" com.covertalert.pixeltest.SmsDivisionHarnessKt
