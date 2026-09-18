#!/usr/bin/env bash
set -euo pipefail

# Repo-only JVM harness for the handset's durable SMS receipt queue.
#
# DeviceSmsSender's persistence decisions live in the android-free core
# ReceiptDurability.kt so the process-death windows the field hit (SMS left
# the SIM, then the phone lost data or the process died before the receipt
# POST landed) can be exercised without an emulator: the harness drives the
# real core against an in-memory ReceiptStore with all-or-nothing writes and
# proves a batch and its receipt can never both be lost, that recovery
# resumes exactly the batches whose receipt never persisted, and that the
# re-queue guard never re-sends an incident with an unfinished batch.
#
# Toolchain: any kotlinc plus the org.json jar (the same org.json Android
# bundles). Both are downloaded into scripts/.cache/receipt-durability when
# missing, pinned by sha256. Nothing here ships in the APK or the field kit.
#
# Usage: scripts/test-receipt-durability.sh
# Prints: RECEIPT_DURABILITY_OK checks=<n>

readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly CORE="$REPO_ROOT/artifacts/covert-alert-system/android-test-package/app/src/main/java/com/covertalert/pixeltest/ReceiptDurability.kt"
readonly HARNESS="$REPO_ROOT/scripts/receipt-durability/ReceiptDurabilityHarness.kt"
readonly CACHE="$REPO_ROOT/scripts/.cache/receipt-durability"

readonly KOTLIN_VERSION="2.0.21"
readonly KOTLIN_ZIP_SHA256="0352c0a45bd22f80f6b26e485cd04da8047baa5de54865281fb9f89a4a7bcf2a"
readonly JSON_VERSION="20240303"
readonly JSON_JAR_SHA256="3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed"

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
JSON_JAR="$CACHE/json-$JSON_VERSION.jar"
fetch "https://repo1.maven.org/maven2/org/json/json/$JSON_VERSION/json-$JSON_VERSION.jar" \
  "$JSON_JAR" "$JSON_JAR_SHA256"

BUILD="$CACHE/build"
rm -rf "$BUILD"
mkdir -p "$BUILD"

"$KOTLINC" "$CORE" "$HARNESS" -cp "$JSON_JAR" -include-runtime -d "$BUILD/harness.jar"
java -cp "$BUILD/harness.jar:$JSON_JAR" com.covertalert.pixeltest.ReceiptDurabilityHarnessKt
