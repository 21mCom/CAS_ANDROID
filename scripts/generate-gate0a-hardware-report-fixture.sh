#!/usr/bin/env bash
set -euo pipefail

# CI/dev-only generator for a physical-device-observation Gate 0A report.
#
# This script is deliberately NOT part of the packaged field kit
# (artifacts/covert-alert-system/android-test-package): a device-free report
# that import validation accepts as physical evidence must not be
# manufacturable from the tooling shipped to field operators. The packaged-kit
# CI gate verifies the kit matches the android-test-package checkout exactly,
# so this script can never ship accidentally.
#
# It models the documented 2026-09-14 hardware run (see the field handoff:
# Pixel 11 / cubs, API 37, build CD1A.260905.001.B1, 219 events, all 200
# repeats passing, ~250 KB report.json) by seeding events.ndjson and
# environment.tsv the way that run left them, then regenerating report.json
# with the harness's own write_report() — the exact regeneration path the
# handoff documents for a missing report. The fixture therefore carries the
# real run's cross-field invariants, event volume, and byte footprint.
#
# Usage: scripts/generate-gate0a-hardware-report-fixture.sh --out-dir DIR
# Prints: GATE0A_HW_FIXTURE_OK report=<path-to-report.json>

readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly HARNESS="$REPO_ROOT/artifacts/covert-alert-system/android-test-package/scripts/measure-gate0a.sh"
readonly PACKAGE="com.covertalert.pixeltest"
readonly REPEAT_COUNT=200
readonly APK_SHA256="7f3a9c1e52b48d06a1e4f9c27b3d5816e04aa9f1c2d5b8473e6f0a1c9d2b4e65"
# Identity and start of the documented 2026-09-14 hardware run.
readonly RUN_SERIAL="67270DLKY00E9K"
readonly RUN_DIR_NAME="20260914T145729Z-4820"
readonly STARTED_AT_UTC="2026-09-14T14:57:29Z"

OUT_DIR=""
while (($#)); do
    case "$1" in
        --out-dir)
            (($# >= 2)) || { echo "--out-dir requires a directory" >&2; exit 2; }
            OUT_DIR="$2"
            shift
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
[[ -n "$OUT_DIR" ]] || { echo "Usage: $0 --out-dir DIR" >&2; exit 2; }
[[ -f "$HARNESS" ]] || { echo "Harness not found: $HARNESS" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "Required command is missing: python3" >&2; exit 2; }

STARTED_AT_MS="$(date -u -d "$STARTED_AT_UTC" +%s%3N)"
FINAL_STATUS="complete"

# write_report() embeds the harness's pinned-device contract (pinned AVD name,
# emulator API, minimum physical API) in the preflight expectations. Derive
# those constants from the same tool-requirements.json declaration the harness
# reads so the fixture cannot drift from real output.
readonly TOOL_REQUIREMENTS_JSON="$REPO_ROOT/artifacts/covert-alert-system/android-test-package/tool-requirements.json"
[[ -f "$TOOL_REQUIREMENTS_JSON" ]] ||
    { echo "tool-requirements.json is missing at $TOOL_REQUIREMENTS_JSON" >&2; exit 2; }
DECLARED_API="$(sed -nE 's/^[[:space:]]*"apiLevel"[[:space:]]*:[[:space:]]*([0-9]+)[[:space:]]*,?[[:space:]]*$/\1/p' "$TOOL_REQUIREMENTS_JSON")"
DECLARED_PLATFORM_API="$(sed -nE 's/^[[:space:]]*"platform"[[:space:]]*:[[:space:]]*"android-([0-9]+)"[[:space:]]*,?[[:space:]]*$/\1/p' "$TOOL_REQUIREMENTS_JSON")"
[[ "$DECLARED_API" =~ ^[0-9]+$ && "$DECLARED_PLATFORM_API" =~ ^[0-9]+$ && "$DECLARED_API" == "$DECLARED_PLATFORM_API" ]] ||
    { echo "tool-requirements.json is invalid at $TOOL_REQUIREMENTS_JSON (androidSdk.apiLevel and androidSdk.platform must be consistent)" >&2; exit 2; }
PINNED_AVD="CAS_Pixel_8a_API_${DECLARED_API}"
EMULATOR_API="$DECLARED_API"
MIN_PHYSICAL_API="$DECLARED_API"

RUN_DIR="$OUT_DIR/$RUN_DIR_NAME"
mkdir -p "$RUN_DIR"/{screenshots,logcat,tasks,launch}
EVENTS_FILE="$RUN_DIR/events.ndjson"
ENV_FILE="$RUN_DIR/environment.tsv"
: > "$EVENTS_FILE"
: > "$RUN_DIR/host.log"
: > "$ENV_FILE"

write_env() {
    printf '%s\t%s\n' "$1" "${2-}" >> "$ENV_FILE"
}

json_escape() {
    local value="${1-}"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//$'\n'/\\n}"
    value="${value//$'\r'/\\r}"
    value="${value//$'\t'/\\t}"
    printf '%s' "$value"
}

# Events are stamped as the real run recorded them: a few seconds apart,
# starting at the documented start time.
EVENT_OFFSET_MS=0
record_event() {
    local phase="$1" status="$2" message="$3"
    shift 3
    local fields="\"phase\":\"$(json_escape "$phase")\",\"status\":\"$(json_escape "$status")\",\"message\":\"$(json_escape "$message")\""
    local pair key value
    for pair in "$@"; do
        key="${pair%%=*}"
        value="${pair#*=}"
        fields="$fields,\"$(json_escape "$key")\":\"$(json_escape "$value")\""
    done
    local recorded_ms=$((STARTED_AT_MS + EVENT_OFFSET_MS))
    printf '{"recordedAtUtc":"%s",%s}\n' "$(date -u -d "@$((recorded_ms / 1000))" +%FT%TZ)" "$fields" >> "$EVENTS_FILE"
    EVENT_OFFSET_MS=$((EVENT_OFFSET_MS + 3200))
}

# A launch event with the full field set launch_sample() records on hardware.
launch_event() {
    local label="$1" boundary="$2" screenshot="$3"
    local started=$((STARTED_AT_MS + EVENT_OFFSET_MS))
    local ended=$((started + 900))
    record_event "$label" "pass" "Proxy launch completed" \
        "boundary=$boundary" "hostStartMs=$started" "hostEndMs=$ended" \
        "hostElapsedMs=$((ended - started))" "amStatus=ok" \
        "activity=$PACKAGE/.MainActivity" "waitTimeMs=941" "totalTimeMs=883" \
        "launchOutput=C:/Users/CAS_DEV/android-test-package/gate0a-results/$RUN_DIR_NAME/launch/$label.txt" \
        "screenshot=$screenshot" \
        "tasks=tasks/$label.txt" "filteredLogcat=logcat/$label.txt"
}

navigation_event() {
    local label="$1" keyevent="$2"
    local started=$((STARTED_AT_MS + EVENT_OFFSET_MS))
    local ended=$((started + 320))
    record_event "$label" "pass" "Navigation key event accepted" \
        "keyevent=$keyevent" "hostStartMs=$started" "hostEndMs=$ended" \
        "hostElapsedMs=$((ended - started))" "screenshot=screenshots/$label.png" \
        "tasks=tasks/$label.txt" "filteredLogcat=logcat/$label.txt"
}

# The environment the documented run left behind.
write_env "serial" "$RUN_SERIAL"
write_env "evidenceClass" "physical-device-observation"
write_env "model" "Pixel 11"
write_env "device" "cubs"
write_env "product" "cubs"
write_env "avdName" ""
write_env "apiLevel" "37"
write_env "abiList" "arm64-v8a"
write_env "androidRelease" "17"
write_env "buildId" "CD1A.260905.001.B1"
write_env "securityPatch" "2026-09-05"
write_env "hardware" "cubs"
write_env "buildFingerprint" "google/cubs/cubs:17/CD1A.260905.001.B1/14020987:user/release-keys"
write_env "usbState" "device"
write_env "usbDebuggingEnabled" "true"
write_env "targetMode" "physical"
write_env "repeatCount" "$REPEAT_COUNT"
write_env "package" "$PACKAGE"
write_env "packagePath" "package:/data/app/~~4bT0Qmz2==/$PACKAGE-xK9p2Q==/base.apk"
write_env "apkPath" "app/build/outputs/apk/debug/app-debug.apk"
write_env "apkSha256" "$APK_SHA256"

# The documented run's 219 events: 19 run-level events plus 200 repeat
# launches, all passing.
record_event "build" "pass" "Debug APK built" "artifact=app/build/outputs/apk/debug/app-debug.apk"
record_event "device-discovery" "pass" "Authorized adb target selected" "serial=$RUN_SERIAL"
record_event "target-validation" "pass" "Expected Gate 0A target identified" \
    "evidenceClass=physical-device-observation" "model=Pixel 11" "device=cubs"
record_event "operator-guardrail" "pass" "Device identity explicitly confirmed" "confirmation=Pixel 11"
record_event "operator-guardrail" "pass" "Destructive actions explicitly confirmed"
record_event "install" "pass" "Disposable APK installed with adb install -r" "apkSha256=$APK_SHA256"
launch_event "cold-launch" "clean-start" "screenshots/cold-launch.png"
launch_event "warm-launch" "warm" "screenshots/warm-launch.png"
navigation_event "back" "KEYCODE_BACK"
navigation_event "home" "KEYCODE_HOME"
navigation_event "recents" "KEYCODE_APP_SWITCH"
launch_event "unlocked-launch" "screen-unlocked" "screenshots/unlocked-launch.png"
launch_event "locked-launch" "screen-locked" "screenshots/locked-launch.png"
launch_event "post-unlock-launch" "post-unlock" "screenshots/post-unlock-launch.png"
record_event "process-interruption" "pass" "am force-stop completed"
launch_event "after-process-interruption" "post-interruption-clean" ""
record_event "reboot-recovery" "pass" "Target rebooted and disposable package became available"
record_event "repeat-boundary" "pass" \
    "Repeat-launch series begins after a clean force-stop boundary" "count=$REPEAT_COUNT"
for ((i = 1; i <= REPEAT_COUNT; i++)); do
    label="$(printf 'repeat-%03d' "$i")"
    # Screenshots are retained for the first and last repeat only, exactly as
    # repeat_launches() keeps the evidence bundle usable on hardware.
    if ((i == 1 || i == REPEAT_COUNT)); then
        launch_event "$label" "repeat-clean" "screenshots/$label.png"
    else
        launch_event "$label" "repeat-clean" ""
    fi
done
record_event "repeat-boundary" "pass" "Repeat-launch series completed" "count=$REPEAT_COUNT"

# The artifact footprint write_report() globs into evidence.logs/screenshots:
# one filtered logcat per launch/navigation sample, screenshots where retained.
for label in cold-launch warm-launch back home recents unlocked-launch locked-launch \
    post-unlock-launch after-process-interruption; do
    printf 'synthetic logcat capture\n' > "$RUN_DIR/logcat/$label.txt"
done
for ((i = 1; i <= REPEAT_COUNT; i++)); do
    printf 'synthetic logcat capture\n' > "$RUN_DIR/logcat/$(printf 'repeat-%03d' "$i").txt"
done
for label in cold-launch warm-launch back home recents unlocked-launch locked-launch \
    post-unlock-launch repeat-001 "repeat-$(printf '%03d' "$REPEAT_COUNT")"; do
    printf 'synthetic screenshot\n' > "$RUN_DIR/screenshots/$label.png"
done

# Reuse the harness's own writer so the fixture cannot drift from real output.
# write_report() is self-contained: it reads $EVENTS_FILE/$ENV_FILE, the
# STARTED_AT_*/FINAL_STATUS variables, and the pinned-device constants derived
# above, and writes report.json/report.md.
extracted="$(mktemp)"
# The function body ends at the heredoc terminator (PY) followed by the closing
# brace; a naive brace match would stop at the Python report dict's closing
# brace inside the heredoc.
sed -n '/^write_report() {$/,/^PY$/p' "$HARNESS" > "$extracted"
echo "}" >> "$extracted"
grep -q "^write_report() {$" "$extracted" || { echo "Failed to extract write_report() from $HARNESS" >&2; exit 1; }
bash -n "$extracted" || { echo "Extracted write_report() has a syntax error" >&2; exit 1; }
# shellcheck disable=SC1090
source "$extracted"
rm -f "$extracted"

write_report

[[ -s "$RUN_DIR/report.json" ]] || { echo "report.json missing after write_report" >&2; exit 1; }
echo "GATE0A_HW_FIXTURE_OK report=$RUN_DIR/report.json"
