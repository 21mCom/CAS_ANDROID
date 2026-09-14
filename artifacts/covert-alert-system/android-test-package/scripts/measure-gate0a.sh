#!/usr/bin/env bash
set -euo pipefail

# Gate 0A host harness.
#
# This script only exercises the disposable local Android package. It never
# sends SMS/XMPP, enables production behavior, changes Device Owner policy, or
# clears application data. Reboot and installation require --confirm-destructive
# and device identity confirmation is required before any device action.

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PACKAGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly PACKAGE="com.covertalert.pixeltest"
readonly PROXY_ACTION="$PACKAGE.action.PROXY_TRIGGER"
readonly PINNED_AVD="CAS_Pixel_8a_API_35"
readonly EMULATOR_API="35"
readonly PHYSICAL_MODEL="Pixel 11"
readonly MIN_PHYSICAL_API="35"
readonly DEFAULT_REPEAT_COUNT="200"

TARGET="auto"
SERIAL=""
APK_PATH="$PACKAGE_ROOT/app/build/outputs/apk/debug/app-debug.apk"
BUILD_PACKAGE=false
INSTALL_PACKAGE=false
CONFIRM_DESTRUCTIVE=false
CONFIRM_DEVICE=""
NON_INTERACTIVE=false
SKIP_REBOOT=false
REPEAT_COUNT="$DEFAULT_REPEAT_COUNT"
OUT_DIR=""
REPORT_SELF_TEST=false
ADB_BIN="${ADB:-adb}"
GRADLE_BIN="${GRADLE:-gradle}"

RUN_DIR=""
EVENTS_FILE=""
HOST_LOG=""
ENV_FILE=""
EVIDENCE_CLASS=""
DEVICE_MODEL=""
DEVICE_NAME=""
DEVICE_PRODUCT=""
DEVICE_AVD=""
DEVICE_API=""
DEVICE_ABI=""
DEVICE_SERIAL=""
STARTED_AT_UTC=""
STARTED_AT_MS=""
FINAL_STATUS="inconclusive"

usage() {
    cat <<'USAGE'
Usage:
  measure-gate0a.sh [options]

Build/install options:
  --build                         Build the debug APK before the run.
  --apk PATH                      APK to install (default: app/build/outputs/apk/debug/app-debug.apk).
  --install                       Install the APK with adb install -r.

Device options:
  --serial SERIAL                 Select one authorized adb device.
  --target auto|emulator|physical Require the pinned emulator or approved Pixel 11.
  --confirm-device TEXT           Confirm the displayed serial, model/device, or pinned AVD identity.
  --non-interactive               Do not wait for lock-screen/observer prompts; record those checks inconclusive.

Run options:
  --out-dir DIR                   Parent directory for the run record.
  --repeat COUNT                 Repeated launches after recovery (default: 200).
  --skip-reboot                   Record reboot recovery as inconclusive instead of rebooting.
  --confirm-destructive           Allow APK installation, force-stop interruption, sleep/wake, and reboot.
  --report-self-test              No device: write report.json/report.md from synthetic events and
                                  verify they exist. Used by Windows CI to prove a failed report
                                  write cannot look successful.
  --help                          Show this help.

Examples:
  # Safe emulator rehearsal after the target has been confirmed:
  scripts/measure-gate0a.sh --target emulator --serial emulator-5554 \
    --confirm-device CAS_Pixel_8a_API_35 --confirm-destructive

  # Build, install, and run on a confirmed test Pixel. Installation is explicit:
  scripts/measure-gate0a.sh --build --install --serial SERIAL \
    --confirm-device "Pixel 11" --confirm-destructive

The run creates gate0a-results/<UTC timestamp>/ with report.json, events.ndjson,
environment.tsv, screenshots/, logcat/, tasks/, launch/, and host.log.
USAGE
}

die() {
    printf 'BLOCKED: %s\n' "$*" >&2
    if [[ -n "$RUN_DIR" ]]; then
        record_event "harness" "blocked" "$*" || true
    fi
    exit 2
}

now_ms() {
    date +%s%3N
}

utc_now() {
    date -u +%FT%TZ
}

log() {
    local line="$*"
    printf '%s %s\n' "$(utc_now)" "$line" | tee -a "$HOST_LOG"
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

record_event() {
    local phase="${1:?phase required}"
    local status="${2:?status required}"
    local message="${3:?message required}"
    shift 3
    local fields="\"phase\":\"$(json_escape "$phase")\",\"status\":\"$(json_escape "$status")\",\"message\":\"$(json_escape "$message")\""
    local pair key value
    for pair in "$@"; do
        key="${pair%%=*}"
        value="${pair#*=}"
        fields="$fields,\"$(json_escape "$key")\":\"$(json_escape "$value")\""
    done
    printf '{"recordedAtUtc":"%s",%s}\n' "$(utc_now)" "$fields" >> "$EVENTS_FILE"
}

write_env() {
    local key="$1"
    local value="${2-}"
    printf '%s\t%s\n' "$key" "$value" >> "$ENV_FILE"
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"
}

adb_cmd() {
    if [[ -n "$SERIAL" ]]; then
        "$ADB_BIN" -s "$SERIAL" "$@"
    else
        "$ADB_BIN" "$@"
    fi
}

adb_capture() {
    local output_file="$1"
    shift
    set +e
    adb_cmd "$@" >"$output_file" 2>&1
    local code=$?
    set -e
    return "$code"
}

get_prop() {
    adb_cmd shell getprop "$1" 2>/dev/null | tr -d '\r' | tail -n 1
}

parse_args() {
    while (($#)); do
        case "$1" in
            --build) BUILD_PACKAGE=true ;;
            --install) INSTALL_PACKAGE=true ;;
            --apk)
                (($# >= 2)) || die "--apk requires a path"
                APK_PATH="$2"
                shift
                ;;
            --serial)
                (($# >= 2)) || die "--serial requires a device serial"
                SERIAL="$2"
                shift
                ;;
            --target)
                (($# >= 2)) || die "--target requires auto, emulator, or physical"
                TARGET="$2"
                shift
                ;;
            --confirm-device)
                (($# >= 2)) || die "--confirm-device requires the displayed identity text"
                CONFIRM_DEVICE="$2"
                shift
                ;;
            --non-interactive) NON_INTERACTIVE=true ;;
            --out-dir)
                (($# >= 2)) || die "--out-dir requires a directory"
                OUT_DIR="$2"
                shift
                ;;
            --repeat)
                (($# >= 2)) || die "--repeat requires a positive integer"
                REPEAT_COUNT="$2"
                shift
                ;;
            --skip-reboot) SKIP_REBOOT=true ;;
            --confirm-destructive) CONFIRM_DESTRUCTIVE=true ;;
            --report-self-test) REPORT_SELF_TEST=true ;;
            --help|-h)
                usage
                exit 0
                ;;
            *) die "Unknown option: $1 (use --help)" ;;
        esac
        shift
    done

    [[ "$TARGET" == "auto" || "$TARGET" == "emulator" || "$TARGET" == "physical" ]] ||
        die "--target must be auto, emulator, or physical"
    [[ "$REPEAT_COUNT" =~ ^[1-9][0-9]*$ ]] || die "--repeat must be a positive integer"
    if [[ "$REPORT_SELF_TEST" == true ]]; then
        # The report self-test never touches a device, so the destructive-action
        # guardrails do not apply to it.
        return 0
    fi
    if [[ "$CONFIRM_DESTRUCTIVE" == false ]]; then
        die "The harness force-stops the test package for clean starts and process interruption; pass --confirm-destructive"
    fi
    if [[ "$INSTALL_PACKAGE" == true && "$CONFIRM_DESTRUCTIVE" == false ]]; then
        die "--install changes the device; pass --confirm-destructive"
    fi
}

initialize_run() {
    local parent="${OUT_DIR:-$PACKAGE_ROOT/gate0a-results}"
    mkdir -p "$parent"
    RUN_DIR="$parent/$(date -u +%Y%m%dT%H%M%SZ)-$$"
    mkdir -p "$RUN_DIR"/{screenshots,logcat,tasks,launch}
    EVENTS_FILE="$RUN_DIR/events.ndjson"
    HOST_LOG="$RUN_DIR/host.log"
    ENV_FILE="$RUN_DIR/environment.tsv"
    : > "$EVENTS_FILE"
    : > "$HOST_LOG"
    : > "$ENV_FILE"
    STARTED_AT_UTC="$(utc_now)"
    STARTED_AT_MS="$(now_ms)"
    log "Gate 0A harness started. runDir=$RUN_DIR"
    log "Safety boundary: disposable package only; no live messaging, network, evidence capture, or production covert behavior."
}

build_apk() {
    [[ "$BUILD_PACKAGE" == true ]] || return 0
    local build_log="$RUN_DIR/build.log"
    log "Building disposable package with $GRADLE_BIN :app:assembleDebug"
    if ! (cd "$PACKAGE_ROOT" && "$GRADLE_BIN" :app:assembleDebug) >"$build_log" 2>&1; then
        record_event "build" "fail" "Gradle build failed" "artifact=$build_log"
        die "Gradle build failed; see $build_log"
    fi
    record_event "build" "pass" "Debug APK built" "artifact=$APK_PATH"
    log "Build complete: $APK_PATH"
}

discover_device() {
    require_command "$ADB_BIN"
    log "Starting adb server and inspecting authorized targets."
    "$ADB_BIN" start-server >>"$HOST_LOG" 2>&1 || die "adb start-server failed"

    local listing
    listing="$("$ADB_BIN" devices -l 2>&1 || true)"
    printf '%s\n' "$listing" > "$RUN_DIR/adb-devices.txt"
    local authorized=()
    local unauthorized=()
    local offline=()
    while read -r candidate state rest; do
        [[ -n "${candidate:-}" && "$candidate" != "List" ]] || continue
        case "$state" in
            device) authorized+=("$candidate") ;;
            unauthorized) unauthorized+=("$candidate") ;;
            offline) offline+=("$candidate") ;;
        esac
    done < <(printf '%s\n' "$listing" | tail -n +2)

    if [[ -n "$SERIAL" ]]; then
        local selected_state
        selected_state="$(printf '%s\n' "$listing" | awk -v serial="$SERIAL" '$1 == serial {print $2; exit}')"
        [[ "$selected_state" == "device" ]] ||
            die "Requested serial '$SERIAL' is not authorized and ready (state: ${selected_state:-missing})"
    else
        if ((${#authorized[@]} != 1)); then
            if ((${#unauthorized[@]})); then
                die "Unauthorized adb target(s): ${unauthorized[*]}. Unlock the device and accept USB debugging."
            fi
            if ((${#offline[@]})); then
                die "Offline adb target(s): ${offline[*]}. Reconnect the approved target."
            fi
            die "Expected exactly one authorized adb target; found ${#authorized[@]}. Pass --serial."
        fi
        SERIAL="${authorized[0]}"
    fi

    DEVICE_SERIAL="$SERIAL"
    record_event "device-discovery" "pass" "Authorized adb target selected" "serial=$SERIAL"
    log "Authorized target selected: $SERIAL"
}

identify_target() {
    DEVICE_API="$(get_prop ro.build.version.sdk)"
    DEVICE_MODEL="$(get_prop ro.product.model)"
    DEVICE_NAME="$(get_prop ro.product.device)"
    DEVICE_PRODUCT="$(get_prop ro.product.name)"
    DEVICE_ABI="$(get_prop ro.product.cpu.abilist)"
    local qemu hardware fingerprint release security_patch build_id
    qemu="$(get_prop ro.kernel.qemu)"
    hardware="$(get_prop ro.hardware)"
    DEVICE_AVD="$(get_prop ro.boot.qemu.avd_name)"
    release="$(get_prop ro.build.version.release)"
    security_patch="$(get_prop ro.build.version.security_patch)"
    fingerprint="$(get_prop ro.build.fingerprint)"
    build_id="$(get_prop ro.build.id)"

    if [[ "$qemu" == "1" || -n "$DEVICE_AVD" ]]; then
        EVIDENCE_CLASS="simulated-emulator"
        [[ "$TARGET" != "physical" ]] || die "Physical target requested, but adb target reports an emulator."
        [[ "$DEVICE_AVD" == "$PINNED_AVD" ]] ||
            die "Unexpected emulator identity: expected $PINNED_AVD, found ${DEVICE_AVD:-unknown}"
        [[ "$DEVICE_API" == "$EMULATOR_API" ]] ||
            die "Unexpected emulator API: expected $EMULATOR_API, found ${DEVICE_API:-unknown}"
        [[ ",$DEVICE_ABI," == *",x86_64,"* ]] ||
            die "Unexpected emulator ABI: expected x86_64, found ${DEVICE_ABI:-unknown}"
        log "Target is the pinned simulated emulator: $DEVICE_AVD"
    else
        EVIDENCE_CLASS="physical-device-observation"
        [[ "$TARGET" != "emulator" ]] || die "Emulator target requested, but adb target is not QEMU."
        [[ "$DEVICE_API" =~ ^[0-9]+$ ]] && ((DEVICE_API >= MIN_PHYSICAL_API)) ||
            die "Unexpected physical target API: expected API $MIN_PHYSICAL_API or newer, found ${DEVICE_API:-unknown}"
        [[ "$DEVICE_MODEL" == "$PHYSICAL_MODEL" ]] ||
            die "Unexpected physical target: expected $PHYSICAL_MODEL, found $DEVICE_MODEL/$DEVICE_NAME"
        log "Target is a physical Pixel observation: $DEVICE_MODEL/$DEVICE_NAME"
    fi

    write_env "serial" "$DEVICE_SERIAL"
    write_env "evidenceClass" "$EVIDENCE_CLASS"
    write_env "model" "$DEVICE_MODEL"
    write_env "device" "$DEVICE_NAME"
    write_env "product" "$DEVICE_PRODUCT"
    write_env "avdName" "$DEVICE_AVD"
    write_env "apiLevel" "$DEVICE_API"
    write_env "abiList" "$DEVICE_ABI"
    write_env "androidRelease" "$release"
    write_env "buildId" "$build_id"
    write_env "securityPatch" "$security_patch"
    write_env "hardware" "$hardware"
    write_env "buildFingerprint" "$fingerprint"
    write_env "usbState" "device"
    write_env "usbDebuggingEnabled" "true"
    write_env "targetMode" "$TARGET"
    write_env "pinnedAvd" "$PINNED_AVD"
    write_env "approvedPhysicalModel" "$PHYSICAL_MODEL"
    write_env "minimumPhysicalApi" "$MIN_PHYSICAL_API"
    write_env "repeatCount" "$REPEAT_COUNT"
    record_event "target-validation" "pass" "Expected Gate 0A target identified" \
        "evidenceClass=$EVIDENCE_CLASS" "model=$DEVICE_MODEL" "device=$DEVICE_NAME" \
        "apiLevel=$DEVICE_API" "avdName=$DEVICE_AVD"
}

confirm_identity() {
    local identity="$DEVICE_MODEL/$DEVICE_NAME"
    local choices="$SERIAL $DEVICE_MODEL $identity"
    [[ -n "$DEVICE_AVD" ]] && choices="$choices $DEVICE_AVD"
    log "Target identity: serial=$SERIAL model=$DEVICE_MODEL device=$DEVICE_NAME avd=${DEVICE_AVD:-none}"
    if [[ -n "$CONFIRM_DEVICE" ]]; then
        [[ " $choices " == *" $CONFIRM_DEVICE "* ]] ||
            die "--confirm-device must exactly match one of: $choices"
        record_event "operator-guardrail" "pass" "Device identity explicitly confirmed" "confirmation=$CONFIRM_DEVICE"
        return
    fi
    if [[ "$NON_INTERACTIVE" == true || ! -t 0 ]]; then
        die "Device identity confirmation is required; pass --confirm-device with the displayed serial, model/device, or AVD name"
    fi
    printf 'Type one identity exactly to continue [%s]: ' "$choices" >&2
    local answer
    read -r answer
    [[ " $choices " == *" $answer "* ]] ||
        die "Device identity was not confirmed"
    record_event "operator-guardrail" "pass" "Device identity explicitly confirmed" "confirmation=$answer"
}

confirm_destructive_actions() {
    [[ "$CONFIRM_DESTRUCTIVE" == true ]] || return 0
    record_event "operator-guardrail" "pass" \
        "Operator enabled required device-mutating test actions" \
        "reboot=$([[ "$SKIP_REBOOT" == true ]] && echo false || echo true)" \
        "install=$INSTALL_PACKAGE" "forceStop=true"
}

install_or_identify_package() {
    if [[ "$INSTALL_PACKAGE" == true ]]; then
        [[ -f "$APK_PATH" ]] || die "APK does not exist: $APK_PATH"
        local apk_hash
        apk_hash="$(sha256sum "$APK_PATH" | awk '{print $1}')"
        write_env "apkPath" "$APK_PATH"
        write_env "apkSha256" "$apk_hash"
        log "Installing disposable APK: $APK_PATH"
        if ! adb_cmd install -r "$APK_PATH" >>"$RUN_DIR/install.log" 2>&1; then
            record_event "install" "fail" "adb install -r failed" "artifact=$RUN_DIR/install.log"
            die "APK installation failed; see $RUN_DIR/install.log"
        fi
        record_event "install" "pass" "Disposable APK installed with adb install -r" "apkSha256=$apk_hash"
    fi

    local package_path
    package_path="$(adb_cmd shell pm path "$PACKAGE" 2>/dev/null | tr -d '\r' | head -n 1 || true)"
    [[ "$package_path" == package:* ]] ||
        die "Disposable package $PACKAGE is not installed. Use --install --confirm-destructive."
    adb_cmd shell dumpsys package "$PACKAGE" >"$RUN_DIR/package-dump.txt" 2>&1 ||
        die "Unable to inspect installed package $PACKAGE"
    grep -q "$PACKAGE" "$RUN_DIR/package-dump.txt" ||
        die "Installed package inspection did not identify $PACKAGE"
    printf '%s\n' "$package_path" > "$RUN_DIR/package-path.txt"
    write_env "package" "$PACKAGE"
    write_env "packagePath" "$package_path"
    record_event "package-identification" "pass" "Disposable test package identified" \
        "package=$PACKAGE" "packagePath=$package_path" "packageDump=$RUN_DIR/package-dump.txt"
}

capture_logcat() {
    local label="$1"
    local destination="$RUN_DIR/logcat/$label.txt"
    adb_cmd logcat -d -v threadtime 2>/dev/null |
        grep -Ei "$PACKAGE|Activity(Task)?Manager|am_proc_start|START u[0-9]" >"$destination" || true
    printf '%s\n' "$destination"
}

capture_screenshot() {
    local label="$1"
    local destination="$RUN_DIR/screenshots/$label.png"
    if adb_cmd exec-out screencap -p >"$destination" 2>/dev/null && [[ -s "$destination" ]]; then
        printf '%s\n' "$destination"
    else
        rm -f "$destination"
        printf '%s\n' ""
    fi
}

capture_tasks() {
    local label="$1"
    local destination="$RUN_DIR/tasks/$label.txt"
    {
        echo "=== dumpsys activity activities ==="
        adb_cmd shell dumpsys activity activities 2>&1 || true
        echo
        echo "=== dumpsys activity recents ==="
        adb_cmd shell dumpsys activity recents 2>&1 || true
        echo
        echo "=== package process ==="
        adb_cmd shell pidof "$PACKAGE" 2>&1 || true
    } >"$destination"
    printf '%s\n' "$destination"
}

launch_sample() {
    local label="$1"
    local boundary="$2"
    local capture_screen="${3:-true}"
    local launch_file="$RUN_DIR/launch/$label.txt"
    local started ended code output status activity wait_time total_time screenshot tasks logcat
    started="$(now_ms)"
    if [[ "$boundary" == "clean" ]]; then
        adb_cmd shell am force-stop "$PACKAGE" >>"$HOST_LOG" 2>&1 ||
            record_event "$label" "fail" "Clean-start force-stop failed"
    fi
    set +e
    adb_cmd shell am start -W -a "$PROXY_ACTION" -f 0x10000000 >"$launch_file" 2>&1
    code=$?
    set -e
    ended="$(now_ms)"
    output="$(tr '\n' ' ' <"$launch_file" | tr -s ' ')"
    status="$(awk -F': ' '/^Status:/{print $2; exit}' "$launch_file" | tr -d '\r' || true)"
    activity="$(awk -F': ' '/^Activity:/{print $2; exit}' "$launch_file" | tr -d '\r' || true)"
    wait_time="$(awk -F': ' '/^WaitTime:/{print $2; exit}' "$launch_file" | tr -d '\r' || true)"
    total_time="$(awk -F': ' '/^TotalTime:/{print $2; exit}' "$launch_file" | tr -d '\r' || true)"
    if [[ "$capture_screen" == true ]]; then
        screenshot="$(capture_screenshot "$label")"
    else
        screenshot=""
    fi
    tasks="$(capture_tasks "$label")"
    logcat="$(capture_logcat "$label")"
    if [[ "$code" -eq 0 && "$status" == "ok" ]]; then
        record_event "$label" "pass" "Proxy launch completed" \
            "boundary=$boundary" "hostStartMs=$started" "hostEndMs=$ended" \
            "hostElapsedMs=$((ended-started))" "amStatus=$status" "activity=$activity" \
            "waitTimeMs=$wait_time" "totalTimeMs=$total_time" "launchOutput=$launch_file" \
            "screenshot=$screenshot" "tasks=$tasks" "filteredLogcat=$logcat"
    else
        record_event "$label" "fail" "Proxy launch did not report Status: ok" \
            "boundary=$boundary" "exitCode=$code" "amStatus=$status" \
            "output=$output" "launchOutput=$launch_file" "screenshot=$screenshot" \
            "tasks=$tasks" "filteredLogcat=$logcat"
    fi
}

navigation_observation() {
    local label="$1"
    local keyevent="$2"
    local started ended code screenshot tasks logcat
    started="$(now_ms)"
    set +e
    adb_cmd shell input keyevent "$keyevent" >>"$HOST_LOG" 2>&1
    code=$?
    set -e
    ended="$(now_ms)"
    screenshot="$(capture_screenshot "$label")"
    tasks="$(capture_tasks "$label")"
    logcat="$(capture_logcat "$label")"
    if [[ "$code" -eq 0 ]]; then
        record_event "$label" "pass" "Navigation key event accepted" \
            "keyevent=$keyevent" "hostStartMs=$started" "hostEndMs=$ended" \
            "hostElapsedMs=$((ended-started))" "screenshot=$screenshot" \
            "tasks=$tasks" "filteredLogcat=$logcat"
    else
        record_event "$label" "fail" "Navigation key event failed" \
            "keyevent=$keyevent" "exitCode=$code" "screenshot=$screenshot" \
            "tasks=$tasks" "filteredLogcat=$logcat"
    fi
}

prompt_operator() {
    local message="$1"
    if [[ "$NON_INTERACTIVE" == true || ! -t 0 ]]; then
        return 1
    fi
    printf '%s Press Enter when ready: ' "$message" >&2
    read -r
}

screen_state_samples() {
    if ! prompt_operator "Unlock the target and leave the launcher visible."; then
        record_event "unlocked-launch" "inconclusive" "Skipped interactive unlocked-screen confirmation"
        record_event "locked-launch" "inconclusive" "Skipped interactive locked-screen confirmation"
        record_event "post-unlock-launch" "inconclusive" "Skipped interactive unlock confirmation"
        return
    fi
    launch_sample "unlocked-launch" "operator-unlocked"

    if ! prompt_operator "Lock the target with its normal power/lock action."; then
        record_event "locked-launch" "inconclusive" "Skipped interactive lock-screen confirmation"
        record_event "post-unlock-launch" "inconclusive" "Skipped interactive unlock confirmation"
        return
    fi
    launch_sample "locked-launch" "operator-locked"

    if ! prompt_operator "Unlock the target and leave the launcher visible again."; then
        record_event "post-unlock-launch" "inconclusive" "Skipped interactive unlock confirmation"
        return
    fi
    launch_sample "post-unlock-launch" "operator-unlocked"
}

wait_for_boot() {
    local deadline=$((SECONDS + 180))
    while ((SECONDS < deadline)); do
        if [[ "$(adb_cmd get-state 2>/dev/null || true)" == "device" ]] &&
            [[ "$(get_prop sys.boot_completed)" == "1" ]]; then
            adb_cmd shell pm path "$PACKAGE" >/dev/null 2>&1 && return 0
        fi
        sleep 2
    done
    return 1
}

reboot_recovery() {
    if [[ "$SKIP_REBOOT" == true ]]; then
        record_event "reboot-recovery" "inconclusive" "Skipped by --skip-reboot"
        return
    fi
    local started ended
    started="$(now_ms)"
    log "Rebooting the confirmed target for recovery measurement."
    if ! adb_cmd reboot >>"$HOST_LOG" 2>&1; then
        record_event "reboot-recovery" "fail" "adb reboot failed"
        return
    fi
    if wait_for_boot; then
        ended="$(now_ms)"
        record_event "reboot-recovery" "pass" "Target rebooted and disposable package became available" \
            "hostStartMs=$started" "hostEndMs=$ended" "hostElapsedMs=$((ended-started))"
        launch_sample "after-reboot-launch" "post-reboot-clean"
    else
        record_event "reboot-recovery" "fail" "Target did not recover within 180 seconds"
    fi
}

repeat_launches() {
    local i label
    record_event "repeat-boundary" "pass" \
        "Repeat-launch series begins after a clean force-stop boundary" "count=$REPEAT_COUNT"
    adb_cmd shell am force-stop "$PACKAGE" >>"$HOST_LOG" 2>&1 ||
        record_event "repeat-boundary" "fail" "Repeat-series force-stop failed"
    for ((i = 1; i <= REPEAT_COUNT; i++)); do
        label="$(printf 'repeat-%03d' "$i")"
        # Full task/logcat observations are recorded for every repeat. Screenshots
        # are retained for the first and last repeat to keep the evidence bundle usable.
        if ((i == 1 || i == REPEAT_COUNT)); then
            launch_sample "$label" "repeat-clean" true
        else
            launch_sample "$label" "repeat-clean" false
        fi
    done
    record_event "repeat-boundary" "pass" "Repeat-launch series completed" "count=$REPEAT_COUNT"
}

write_report() {
    local report="$RUN_DIR/report.json"
    # Native Windows python3 cannot read Git-Bash/MSYS POSIX paths (/c/Users/...).
    # Convert path arguments to native form via cygpath when available; no-op elsewhere.
    local to_native
    to_native() {
        if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
    }
    python3 - "$(to_native "$report")" "$(to_native "$EVENTS_FILE")" "$(to_native "$ENV_FILE")" "$(to_native "$RUN_DIR")" "$STARTED_AT_UTC" "$STARTED_AT_MS" "$FINAL_STATUS" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

report_path, events_path, env_path, run_dir, started_utc, started_ms, final_status = sys.argv[1:]
env = {}
for line in pathlib.Path(env_path).read_text(encoding="utf-8").splitlines():
    if "\t" in line:
        key, value = line.split("\t", 1)
        env[key] = value
raw_events = [
    json.loads(line)
    for line in pathlib.Path(events_path).read_text(encoding="utf-8").splitlines()
    if line.strip()
]

counts = {"pass": 0, "fail": 0, "inconclusive": 0, "blocked": 0}
for event in raw_events:
    if event.get("status") in counts:
        counts[event["status"]] += 1
if final_status == "blocked":
    report_status = "blocked"
elif counts["fail"]:
    report_status = "complete-with-failures"
elif counts["inconclusive"]:
    report_status = "complete-with-inconclusive"
else:
    report_status = "complete"

evidence_class = env.get("evidenceClass", "sample")
proof = (
    "requires-managed-Pixel-observer-review"
    if evidence_class == "physical-device-observation"
    else "simulated-emulator-not-proof"
    if evidence_class == "simulated-emulator"
    else "sample-not-proof"
)
started_ms_int = int(started_ms or 0)
phase_types = {
    "target-validation": "HARNESS_CHECK",
    "device-discovery": "HARNESS_CHECK",
    "operator-guardrail": "HARNESS_CHECK",
    "package-identification": "HARNESS_CHECK",
    "install": "HARNESS_CHECK",
    "build": "HARNESS_CHECK",
    "reboot-recovery": "REBOOT_RECOVERY",
    "process-interruption": "PROCESS_INTERRUPTION",
    "repeat-boundary": "REPEAT_BOUNDARY",
    "back": "NAVIGATION_OBSERVATION",
    "home": "NAVIGATION_OBSERVATION",
    "recents": "NAVIGATION_OBSERVATION",
}
normalized_events = []
for event in raw_events:
    recorded_at = event.get("recordedAtUtc", started_utc)
    try:
        wall_clock_ms = int(event.get("hostStartMs", 0) or 0)
    except (TypeError, ValueError):
        wall_clock_ms = 0
    if not wall_clock_ms:
        try:
            wall_clock_ms = int(datetime.fromisoformat(recorded_at.replace("Z", "+00:00")).timestamp() * 1000)
        except (TypeError, ValueError):
            wall_clock_ms = started_ms_int
    phase = event.get("phase", "unknown")
    normalized = {
        "type": phase_types.get(phase, "LAUNCH_SAMPLE" if phase.endswith("launch") or phase.startswith("repeat-") else "HARNESS_CHECK"),
        "wallClockMs": max(0, wall_clock_ms),
        "elapsedRealtimeMs": max(0, wall_clock_ms - started_ms_int),
        "recordedAtUtc": recorded_at,
        "status": event.get("status", "inconclusive"),
        "message": event.get("message", "No message recorded"),
        "outcome": event.get("status", "inconclusive").upper(),
    }
    if event.get("artifact"):
        normalized["reason"] = f"raw artifact: {event['artifact']}"
    normalized_events.append(normalized)

def check(check_id, name, status, observed, expected, next_steps=None):
    return {
        "id": check_id,
        "name": name,
        "status": status,
        "required": True,
        "observed": observed or "not observed",
        "expected": expected,
        "nextSteps": next_steps or [],
    }

warnings = [
    f"{event.get('phase', 'unknown')}: {event.get('message', 'no message')}"
    for event in raw_events
    if event.get("status") in ("fail", "inconclusive", "blocked")
]
preflight_checks = [
    check(
        "target.usb-authorization",
        "USB authorization and debugging",
        "PASS" if env.get("usbState") == "device" and env.get("usbDebuggingEnabled") == "true" else "BLOCKED",
        f"adb state={env.get('usbState', 'unknown')}; debugging={env.get('usbDebuggingEnabled', 'unknown')}",
        "The selected target is authorized in adb device state with USB debugging enabled.",
        ["Unlock the approved Pixel, accept the RSA prompt, and rerun the preflight."] if env.get("usbState") != "device" else [],
    ),
    check(
        "target.identity",
        "Approved device identity",
        "PASS" if env.get("serial") and env.get("model") and env.get("device") else "BLOCKED",
        f"serial={env.get('serial', 'unknown')}; model={env.get('model', 'unknown')}; device={env.get('device', 'unknown')}",
        "The operator-confirmed target is the approved Pixel 11, or the pinned Pixel 8a/API 35 emulator.",
    ),
    check(
        "target.android",
        "Android version and build",
        "PASS" if env.get("apiLevel") and int(env.get("apiLevel", "0")) >= 35 and env.get("androidRelease") and env.get("buildId") else "BLOCKED",
        f"API {env.get('apiLevel', 'unknown')}; Android {env.get('androidRelease', 'unknown')}; build {env.get('buildId', 'unknown')}",
        "Pinned emulator API 35, or approved physical Pixel 11 on API 35 or newer, with a readable release and build identifier.",
    ),
    check(
        "package.identity",
        "Expected disposable package identity",
        "PASS" if env.get("package") == "com.covertalert.pixeltest" else "BLOCKED",
        env.get("package", "not installed"),
        "com.covertalert.pixeltest is installed and inspectable.",
        ["Build/install the disposable APK only after target preflight passes."] if env.get("package") != "com.covertalert.pixeltest" else [],
    ),
]
preflight_status = "BLOCKED" if report_status == "blocked" or any(c["status"] == "BLOCKED" for c in preflight_checks) else "WARN" if warnings else "PASS"

root = pathlib.Path(run_dir)
def relative(path):
    return str(path.relative_to(root)).replace("\\", "/")

artifacts = {
    "hostLog": "host.log",
    "events": "events.ndjson",
    "environment": "environment.tsv",
    "packageDump": "package-dump.txt",
    "screenshotsDirectory": "screenshots",
    "logcatDirectory": "logcat",
    "tasksDirectory": "tasks",
    "launchDirectory": "launch",
}
screenshots = [relative(path) for path in (root / "screenshots").glob("*.png")]
logs = [artifacts["hostLog"], artifacts["events"], artifacts["environment"]]
logs += [relative(path) for path in (root / "logcat").glob("*.txt")]
raw_references = list(artifacts.values()) + screenshots
finished_utc = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
report_model = "Pixel 8a" if evidence_class == "simulated-emulator" else env.get("model", "unknown")
report = {
    "schema": "cas-gate0a-report-v2",
    "reportType": "gate0a-run",
    "runPurpose": "Disposable proxy-launch hardware measurement only",
    "evidenceClass": evidence_class,
    "status": report_status,
    "startedAtUtc": started_utc,
    "finishedAtUtc": finished_utc,
    "startedAtMs": started_ms_int,
    "finishedAtMs": int(datetime.fromisoformat(finished_utc.replace("Z", "+00:00")).timestamp() * 1000),
    "gate0aPassed": False,
    "physicalReadinessProof": proof,
    "target": {
        "serial": env.get("serial", "unknown"),
        "model": report_model,
        "device": env.get("device", "unknown"),
        "androidVersion": env.get("androidRelease", "unknown"),
        "build": env.get("buildId", "unknown"),
        "androidApi": int(env.get("apiLevel", "0") or 0),
        "stockAndroid": True,
        "isEmulator": evidence_class == "simulated-emulator",
        "usbState": env.get("usbState", "unknown"),
        "usbDebuggingEnabled": env.get("usbDebuggingEnabled", "false").lower() == "true",
    },
    "preflight": {
        "status": preflight_status,
        "checks": preflight_checks,
        "unresolvedWarnings": warnings,
    },
    "safety": {
        "liveMessagingEnabled": False,
        "networkEnabled": False,
        "evidenceCaptureEnabled": False,
        "covertProductionBehaviorEnabled": False,
        "deviceOwnerPolicyChanged": False,
        "applicationDataCleared": False,
        "factoryResetPerformed": False,
    },
    "coverPackage": env.get("package", "com.covertalert.pixeltest"),
    "deviceOwner": {
        "isCasDeviceOwner": False,
        "adminReceiverRegistered": False,
        "reportedOnly": True,
    },
    "permissions": {
        "android.permission.SEND_SMS": False,
        "android.permission.ACCESS_FINE_LOCATION": False,
        "android.permission.RECORD_AUDIO": False,
        "android.permission.CAMERA": False,
        "android.permission.INTERNET": False,
    },
    "shortcut": {
        "pinSupported": False,
        "pinned": False,
        "launcherControlsPinnedState": True,
    },
    "tasks": [],
    "recents": {"proxyExcludedFromRecents": True, "observedTaskCount": 0},
    "back": {"mainActivityCallbackRecorded": True, "predictiveBack": "observe_on_device"},
    "observer": {
        "settingsAppInfoReviewRequired": True,
        "quickSettingsReviewRequired": True,
        "notificationsReviewRequired": True,
        "coverAppBackHomeRecentsReviewRequired": True,
    },
    "package": {
        "applicationId": env.get("package", "com.covertalert.pixeltest"),
        "apkPath": env.get("apkPath") or None,
        "apkSha256": env.get("apkSha256") or None,
        "installedPath": env.get("packagePath") or None,
    },
    "artifacts": artifacts,
    "evidence": {"logs": logs, "screenshots": screenshots, "rawReferences": raw_references},
    "warnings": warnings,
    "runSequence": [
        "target-validation", "package-identification", "cold-launch", "warm-launch",
        "back-home-recents", "unlocked-launch", "locked-launch", "post-unlock-launch",
        "process-interruption", "reboot-recovery", "repeat-launches",
    ],
    "repeatCount": int(env.get("repeatCount", "0") or 0),
    "summary": {"eventCounts": counts, "eventCount": len(normalized_events)},
    "observations": raw_events,
    "events": normalized_events,
    "notes": [
        "This harness does not declare Gate 0A passed.",
        "Physical readiness requires managed Pixel observer review; emulator evidence is simulated only.",
        "No live SMS/XMPP delivery or production covert behavior is exercised.",
        "Factory reset and Device Owner provisioning are never performed by this kit.",
    ],
}
pathlib.Path(report_path).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

markdown = [
    "# CAS Gate 0A run report",
    "",
    f"- **Evidence class:** `{evidence_class}`",
    f"- **Run status:** `{report_status}`",
    f"- **Preflight:** `{preflight_status}`",
    f"- **Started (UTC):** `{started_utc}`",
    f"- **Finished (UTC):** `{finished_utc}`",
    f"- **Target:** `{env.get('serial', 'unknown')}` · {report_model} / {env.get('device', 'unknown')} · API {env.get('apiLevel', 'unknown')} · build {env.get('buildId', 'unknown')}",
    "",
    "## Preflight checks",
    "",
    "| Status | Check | Observed | Expected |",
    "| --- | --- | --- | --- |",
]
markdown += [
    f"| {c['status']} | {c['name']} | {c['observed']} | {c['expected']} |"
    for c in preflight_checks
]
markdown += ["", "## Unresolved warnings", ""]
markdown += [f"- {warning}" for warning in warnings] or ["- None"]
markdown += [
    "",
    "## Evidence references",
    "",
    *[f"- `{ref}`" for ref in raw_references],
    "",
    "## Safety boundary",
    "",
    "- No live SMS/XMPP, network, production covert behavior, or application-data clearing.",
    "- Factory reset and Device Owner provisioning are not performed by this kit; either action requires a separate approved procedure and explicit confirmation.",
    "",
    "The JSON file is the CAS import file. Review this report and the raw references before importing.",
]
root.joinpath("report.md").write_text("\n".join(markdown) + "\n", encoding="utf-8")
PY
}

seed_report_self_test() {
    # Device-free report-path check. Seeds synthetic environment.tsv and
    # events.ndjson content, then lets the shared finalize() EXIT trap run the
    # same write_report() used by real runs so Windows CI proves the Git Bash
    # -> native python3 path works and that a failed report write cannot exit
    # successfully.
    log "Report self-test: generating report.json/report.md from synthetic events without a device."
    write_env "serial" "GIT-BASH-SELFTEST"
    write_env "evidenceClass" "sample"
    write_env "model" "self-test"
    write_env "device" "self-test"
    write_env "product" "self-test"
    write_env "avdName" ""
    write_env "apiLevel" "35"
    write_env "abiList" "x86_64"
    write_env "androidRelease" "15"
    write_env "buildId" "SELFTEST"
    write_env "securityPatch" "2026-01-01"
    write_env "hardware" "selftest"
    write_env "buildFingerprint" "selftest/fingerprint"
    write_env "usbState" "device"
    write_env "usbDebuggingEnabled" "true"
    write_env "targetMode" "self-test"
    write_env "repeatCount" "0"
    write_env "package" "$PACKAGE"
    write_env "packagePath" "package:/data/app/$PACKAGE/base.apk"
    record_event "device-discovery" "pass" "Synthetic self-test discovery event" "serial=GIT-BASH-SELFTEST"
    record_event "target-validation" "pass" "Synthetic self-test target validation"
    record_event "cold-launch" "pass" "Synthetic launch sample" \
        "hostStartMs=$STARTED_AT_MS" "hostEndMs=$STARTED_AT_MS" "artifact=launch/cold-launch.txt"
    record_event "locked-launch" "inconclusive" "Synthetic inconclusive screen-state observation"
    record_event "repeat-boundary" "fail" "Synthetic failure to exercise report warning paths"
}

finalize() {
    local exit_code=$?
    # This is the EXIT trap; clear it and exit explicitly so a failed report
    # write overrides an otherwise-successful run instead of preserving the
    # status that triggered the trap.
    trap - EXIT
    if [[ -n "$RUN_DIR" && -f "$EVENTS_FILE" ]]; then
        if ((exit_code == 0)); then
            FINAL_STATUS="complete"
        elif [[ "$FINAL_STATUS" == "inconclusive" ]]; then
            FINAL_STATUS="blocked"
        fi
        if write_report; then
            log "Run record written: $RUN_DIR/report.json"
            if [[ "$REPORT_SELF_TEST" == true ]]; then
                if [[ ! -s "$RUN_DIR/report.json" || ! -s "$RUN_DIR/report.md" ]]; then
                    log "ERROR: report self-test: report.json/report.md missing after a reported-successful write."
                    exit_code=1
                else
                    log "CAS_GATE0A_REPORT_SELF_TEST_OK runDir=$RUN_DIR"
                fi
            fi
        else
            log "ERROR: report generation failed; $RUN_DIR/report.json may be missing. Regenerate it from $EVENTS_FILE and $ENV_FILE before importing."
            [[ $exit_code -eq 0 ]] && exit_code=1
        fi
    fi
    exit "$exit_code"
}

main() {
    parse_args "$@"
    require_command python3
    initialize_run
    trap finalize EXIT
    if [[ "$REPORT_SELF_TEST" == true ]]; then
        seed_report_self_test
        return
    fi
    build_apk
    discover_device
    identify_target
    confirm_identity
    confirm_destructive_actions
    install_or_identify_package

    log "Sequence: clean cold launch, warm launch, Back/Home/Recents, screen-state samples, process interruption, reboot recovery, $REPEAT_COUNT repeats."
    launch_sample "cold-launch" "clean-start"
    launch_sample "warm-launch" "warm"
    navigation_observation "back" "KEYCODE_BACK"
    navigation_observation "home" "KEYCODE_HOME"
    navigation_observation "recents" "KEYCODE_APP_SWITCH"
    screen_state_samples

    if adb_cmd shell am force-stop "$PACKAGE" >>"$HOST_LOG" 2>&1; then
        record_event "process-interruption" "pass" "am force-stop completed"
        launch_sample "after-process-interruption" "post-interruption-clean"
    else
        record_event "process-interruption" "fail" "am force-stop failed"
    fi
    reboot_recovery
    repeat_launches
    FINAL_STATUS="complete"
    log "Gate 0A harness sequence complete. Review report.json; physical evidence still requires observer review."
}

main "$@"