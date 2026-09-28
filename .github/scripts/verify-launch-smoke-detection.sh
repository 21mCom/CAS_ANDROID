#!/usr/bin/env bash
# verify-launch-smoke-detection.sh
#
# Proves that the launch-smoke-test job in android-test-package-build.yml
# actually turns red when the test app crashes on launch, and stays green
# for a healthy launch.
#
# The job's detection logic lives in the committed script
# .github/scripts/emulator-smoke-test.sh (the workflow invokes it as a
# single `script:` line because android-emulator-runner runs each inline
# script line as a separate `sh -c`). This harness runs THAT FILE VERBATIM
# against a fake `adb` that simulates healthy and crash scenarios, and
# separately asserts the workflow still invokes the file — so a future edit
# to either side of the contract is what gets tested.
# No Android SDK or emulator is required.
#
# Usage:  bash .github/scripts/verify-launch-smoke-detection.sh
# Exit:   0 if every scenario behaves as expected, 1 otherwise.
#
# See docs/launch-smoke-detection-verification.md in
# artifacts/covert-alert-system/android-test-package for findings and the
# real-CI (scratch branch) re-verification recipe.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/android-test-package-build.yml"
SCRIPT_UNDER_TEST="$REPO_ROOT/.github/scripts/emulator-smoke-test.sh"
FIXTURES="$REPO_ROOT/.github/scripts/launch-smoke-fixtures"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# ---------------------------------------------------------------------------
# The script under test is the committed file itself — run it verbatim so
# any future edit to the detection logic is what gets tested.
# ---------------------------------------------------------------------------
if [ ! -f "$SCRIPT_UNDER_TEST" ]; then
  echo "HARNESS ERROR: smoke script missing at $SCRIPT_UNDER_TEST." >&2
  exit 2
fi
EXTRACTED="$SCRIPT_UNDER_TEST"

# ---------------------------------------------------------------------------
# Contract guard: the launch-smoke-test job must still invoke that file as
# its `script:` line. If someone re-inlines the logic (which silently breaks
# under android-emulator-runner's per-line sh -c execution) or points the
# job elsewhere, this harness would be testing a script CI no longer runs —
# fail loudly instead.
# ---------------------------------------------------------------------------
if ! awk '
    /^  launch-smoke-test:/ { in_job = 1 }
    in_job && /^[[:space:]]+script:[[:space:]]+bash \.github\/scripts\/emulator-smoke-test\.sh[[:space:]]*$/ { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$WORKFLOW"; then
  echo "HARNESS ERROR: the launch-smoke-test job no longer invokes" >&2
  echo "  'bash .github/scripts/emulator-smoke-test.sh' as its script: line." >&2
  echo "The detection logic must live in that committed file (inline multi-line" >&2
  echo "scripts break under android-emulator-runner's per-line sh -c execution)." >&2
  exit 2
fi

# Guard: fail loudly if the script drifted from what we expect to test.
# Structural markers only — detection patterns are intentionally NOT listed
# here, so a broken pattern is reported as a scenario FAILURE (exit 1), not
# a harness error (exit 2).
for needle in "am start" "pidof com.covertalert.pixeltest" "logcat -d" "Smoke test passed" "locksettings set-pin" "sys.user.0.ce_available" "gate0a-local-journal.xml" "start-foreground-service" "EVIDENCE_CAPTURE" "pm grant"; do
  if ! grep -qF "$needle" "$EXTRACTED"; then
    echo "HARNESS ERROR: smoke script does not contain '$needle'." >&2
    echo "The script structure may have changed; update this harness." >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Fake adb. Behaviour is driven by env vars exported per scenario:
#   SMOKE_AM_EXIT            exit code for `adb shell am start ...`
#   SMOKE_AM_BROADCAST_EXIT  if set, exit code for `adb shell am broadcast ...`
#   SMOKE_PID                printed by `adb shell pidof ...` (empty = no process)
#   SMOKE_LOGCAT_FIXTURE     file served by `adb logcat -d`
#   SMOKE_LOGCAT_FIXTURE_PHASE_<n>
#                            if set, fixture served after the n-th `logcat -c`
#                            (the job re-clears logcat before each entry-point
#                            check: 1=MainActivity, 2=PROXY_TRIGGER,
#                            3=BOOT_COMPLETED broadcast, 4=EvidenceCaptureService
#                            phase, 5=locked-boot phase after the PIN-protected
#                            reboot, where the system delivers
#                            LOCKED_BOOT_COMPLETED while locked)
#   SMOKE_AM_FGS_EXIT        if set, exit code for
#                            `adb shell am start-foreground-service ...`
#   SMOKE_PM_GRANT_EXIT      if set, exit code for `adb shell pm grant ...`
#   SMOKE_JOURNAL_FIXTURE_AFTER_CLEAR
#                          XML served for journal cats after the job's
#                          capture-retry `pm clear` (default: re-serve
#                          SMOKE_JOURNAL_FIXTURE, so a persistent regression
#                          fails the retry too)
#   SMOKE_JOURNAL_FIXTURE  XML served when the job cats the device-protected
#                            journal (defaults to journal-healthy.xml)
#   SMOKE_CE_AVAILABLE_AFTER_REBOOT
#                            value of getprop sys.user.0.ce_available after the
#                            reboot (default empty = still locked; set to "true"
#                            to model a device that failed to stay locked)
#   SMOKE_LOCKSETTINGS_EXIT
#                            if set, exit code for `locksettings set-pin`
#   SMOKE_STATE              state file used to count `logcat -c` calls
#   SMOKE_SHELL_UID          uid reported by `adb shell id` (default 0 = root,
#                            as after a successful `adb root` on the rootable
#                            google_apis image; set to 2000 to model a
#                            non-rootable image where adbd stays as shell)
# ---------------------------------------------------------------------------
BIN_DIR="$TMP_ROOT/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/adb" <<'EOF'
#!/usr/bin/env bash
set -u
case "${1:-}" in
  install)
    echo "Performing Streamed Install"
    echo "Success"
    exit 0
    ;;
  root)
    echo "restarting adbd as root"
    exit 0
    ;;
  wait-for-device)
    exit 0
    ;;
  reboot)
    # Model the PIN-protected reboot: afterwards the device is in the locked
    # (direct-boot) state unless the scenario overrides ce_available.
    touch "$SMOKE_STATE.rebooted"
    exit 0
    ;;
  logcat)
    n=0
    if [ -f "$SMOKE_STATE" ]; then n="$(cat "$SMOKE_STATE")"; fi
    if [ "${2:-}" = "-c" ]; then
      echo $((n + 1)) > "$SMOKE_STATE"
      exit 0
    fi
    phase_var="SMOKE_LOGCAT_FIXTURE_PHASE_$n"
    cat "${!phase_var:-$SMOKE_LOGCAT_FIXTURE}"
    exit 0
    ;;
  shell)
    case "${2:-}" in
      am)
        if [[ " $* " == *" start-foreground-service "* ]] || [[ " $* " == *" startservice "* ]]; then
          if [ "${SMOKE_AM_FGS_EXIT:-0}" -eq 0 ]; then
            echo "Starting service: Intent { cmp=com.covertalert.pixeltest/.EvidenceCaptureService }"
          else
            echo "SecurityException: Permission Denial: startForegroundService from uid=2000" >&2
          fi
          exit "${SMOKE_AM_FGS_EXIT:-0}"
        fi
        if [[ " $* " == *" broadcast "* ]] && [ -n "${SMOKE_AM_BROADCAST_EXIT:-}" ]; then
          action="$(printf '%s\n' "$@" | grep -E '^android\.intent\.action\.' | head -1)"
          if [ "$SMOKE_AM_BROADCAST_EXIT" -eq 0 ]; then
            echo "Broadcasting: Intent { act=$action pkg=com.covertalert.pixeltest }"
            echo "Broadcast completed: result=0"
          else
            echo "SecurityException: Permission Denial: not allowed to send broadcast $action" >&2
          fi
          exit "$SMOKE_AM_BROADCAST_EXIT"
        fi
        if [ "$SMOKE_AM_EXIT" -eq 0 ]; then
          echo "Starting: Intent { cmp=com.covertalert.pixeltest/.MainActivity }"
          echo "Status: ok"
          echo "LaunchState: COLD"
          echo "TotalTime: 412"
        else
          echo "Error: Activity not started, unable to resolve Intent { cmp=com.covertalert.pixeltest/.MainActivity }" >&2
        fi
        exit "$SMOKE_AM_EXIT"
        ;;
      pm)
        # adb shell pm grant <pkg> <perm>: $2 is "pm", $3 is "grant".
        if [ "${3:-}" = "grant" ] && [ -n "${SMOKE_PM_GRANT_EXIT:-}" ]; then
          echo "SecurityException: neither user 2000 nor current process has android.permission.GRANT_RUNTIME_PERMISSIONS" >&2
          exit "$SMOKE_PM_GRANT_EXIT"
        fi
        # adb shell pm clear <pkg>: the smoke script does this before EVERY
        # capture attempt for journal isolation. Only the clear before the
        # RETRY (the second one) swaps the served journal to the after-clear
        # fixture (default: re-serve the same fixture, i.e. the retry fails
        # too); the attempt-1 clear must keep serving the base fixture.
        if [ "${3:-}" = "clear" ]; then
          clears=0
          [ -f "$SMOKE_STATE.clears" ] && clears=$(cat "$SMOKE_STATE.clears")
          clears=$((clears + 1))
          echo "$clears" > "$SMOKE_STATE.clears"
          if [ "$clears" -ge 2 ]; then
            cp "${SMOKE_JOURNAL_FIXTURE_AFTER_CLEAR:-${SMOKE_JOURNAL_FIXTURE:?SMOKE_JOURNAL_FIXTURE not set}}" "$SMOKE_STATE.journal"
          fi
          echo "Success"
        fi
        exit 0
        ;;
      pidof)
        if [ -n "$SMOKE_PID" ]; then echo "$SMOKE_PID"; fi
        exit 0
        ;;
      id)
        uid="${SMOKE_SHELL_UID:-0}"
        if [ "$uid" = "0" ]; then
          echo "uid=0(root) gid=0(root) groups=0(root)"
        else
          echo "uid=2000(shell) gid=2000(shell) groups=2000(shell)"
        fi
        exit 0
        ;;
      getprop)
        case "${3:-}" in
          sys.boot_completed)
            echo 1
            ;;
          sys.user.0.ce_available)
            if [ -f "$SMOKE_STATE.rebooted" ]; then
              printf '%s\n' "${SMOKE_CE_AVAILABLE_AFTER_REBOOT:-}"
            else
              echo "true"
            fi
            ;;
        esac
        exit 0
        ;;
      locksettings)
        if [ -n "${SMOKE_LOCKSETTINGS_EXIT:-}" ]; then
          echo "locksettings: failed to set pin" >&2
          exit "$SMOKE_LOCKSETTINGS_EXIT"
        fi
        echo "Pin set"
        exit 0
        ;;
      cat)
        # After a `pm clear` the swap file replaces the original fixture, so
        # retry scenarios can model a fresh journal with new outcomes.
        if [ -f "${SMOKE_STATE:-/nonexistent}.journal" ]; then
          cat "$SMOKE_STATE.journal"
        else
          cat "${SMOKE_JOURNAL_FIXTURE:?SMOKE_JOURNAL_FIXTURE not set}"
        fi
        exit 0
        ;;
      dumpsys)
        echo "Users:"
        echo "  UserInfo{0:Owner:c13} serialNo=0 isPrimary=true"
        echo "  0: RUNNING_LOCKED"
        exit 0
        ;;
    esac
    ;;
esac
echo "fake-adb: unsupported command: $*" >&2
exit 2
EOF
chmod +x "$BIN_DIR/adb"

# Fake sleep. The extracted smoke script sleeps 8s per entry-point check (and
# 5s around the reboot); across ~19 scenarios that real-time waiting blows
# past the workflow's 5-minute timeout. The capture poll's timeout logic is
# arithmetic (elapsed += CAS_CAPTURE_POLL_S per iteration, bounded by
# CAS_CAPTURE_TIMEOUT_S), NOT wall-clock — run_scenario sets those to 6s/1s —
# so compressing actual sleep preserves the simulated elapsed-time checks
# while keeping the whole self-test in seconds. A tiny real delay keeps
# output ordering realistic.
cat > "$BIN_DIR/sleep" <<'EOF'
#!/usr/bin/env bash
# Compressed stand-in: cap every sleep at 0.05s of real time (see above).
command -v /usr/bin/sleep > /dev/null 2>&1 && /usr/bin/sleep 0.05
exit 0
EOF
chmod +x "$BIN_DIR/sleep"

# ---------------------------------------------------------------------------
# Scenario runner.
# ---------------------------------------------------------------------------
FAILURES=0

run_scenario() {
  local name="$1" expected_exit="$2" am_exit="$3" pid="$4" fixture="$5"
  local am_broadcast_exit="$6" phase3_fixture="$7" phase4_fixture="$8" phase5_fixture="$9"
  shift 9
  # Remaining args: strings that must appear in the job output.
  local work="$TMP_ROOT/$name"
  mkdir -p "$work/apk"
  : > "$work/apk/app-debug.apk"
  local out="$work/output.log"

  set +e
  (
    cd "$work"
    export PATH="$BIN_DIR:$PATH"
    export SMOKE_AM_EXIT="$am_exit" SMOKE_PID="$pid" SMOKE_LOGCAT_FIXTURE="$fixture"
    export SMOKE_STATE="$work/adb-state"
    export SMOKE_JOURNAL_FIXTURE="${SMOKE_JOURNAL_FIXTURE:-$FIXTURES/journal-healthy.xml}"
    # Keep the evidence-capture poll loop fast: scenarios that never reach
    # every kind's outcome must exercise the timeout path in seconds.
    export CAS_CAPTURE_TIMEOUT_S=6 CAS_CAPTURE_POLL_S=1
    if [ -n "$am_broadcast_exit" ]; then export SMOKE_AM_BROADCAST_EXIT="$am_broadcast_exit"; fi
    if [ -n "$phase3_fixture" ]; then export SMOKE_LOGCAT_FIXTURE_PHASE_3="$phase3_fixture"; fi
    if [ -n "$phase4_fixture" ]; then export SMOKE_LOGCAT_FIXTURE_PHASE_4="$phase4_fixture"; fi
    if [ -n "$phase5_fixture" ]; then export SMOKE_LOGCAT_FIXTURE_PHASE_5="$phase5_fixture"; fi
    bash "$EXTRACTED"
  ) > "$out" 2>&1
  local rc=$?
  set -e

  local problems=()
  if [ "$rc" -ne "$expected_exit" ]; then
    problems+=("exit code $rc, expected $expected_exit")
  fi
  local needle
  for needle in "$@"; do
    if ! grep -qF "$needle" "$out"; then
      problems+=("output missing: '$needle'")
    fi
  done

  if [ "${#problems[@]}" -eq 0 ]; then
    echo "PASS  $name (exit $rc as expected)"
  else
    echo "FAIL  $name"
    printf '       - %s\n' "${problems[@]}"
    echo "       full output: $out"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "== launch-smoke-test detection self-test =="
echo "workflow:  $WORKFLOW"
echo "extracted: $(wc -l < "$EXTRACTED") lines of script under test"
echo

# 1. Healthy launch -> job must stay GREEN through all five entry points,
#    including the evidence-capture phase (journaled outcome per kind) and
#    the PIN-protected reboot that keeps user 0 locked while the system
#    delivers LOCKED_BOOT_COMPLETED.
run_scenario "healthy-launch" 0 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "Smoke test passed" "BootReceiver (BOOT_COMPLETED) check passed" \
  "EvidenceCaptureService check passed" \
  "Locked-state precondition holds" "verified while user 0 locked"

# 2. Crash in onCreate after `am start -W` returns success (the realistic
#    crash-on-launch shape: am start exits 0, then the process dies).
#    -> job must go RED via the pidof check, with the logcat excerpt shown.
run_scenario "crash-after-successful-am-start" 1 0 "" "$FIXTURES/crash-logcat.txt" "" "" "" "" \
  "crash on launch" "FATAL EXCEPTION" "DELIBERATE-CRASH-MARKER"

# 3. Fatal exception in logcat while a (restarted) process is still alive.
#    -> job must go RED via the logcat grep, with the excerpt shown.
run_scenario "fatal-logcat-with-live-process" 1 0 "2100" "$FIXTURES/crash-logcat.txt" "" "" "" "" \
  "Fatal crash detected in logcat" "FATAL EXCEPTION" "DELIBERATE-CRASH-MARKER"

# 4. `am start` itself fails. -> job must go RED with the am-start error.
run_scenario "am-start-failure" 1 1 "" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "am start failed"

# 5. Another package being force-finished during the window must NOT fail
#    our launch -> proves the 'Force finishing activity' pattern is scoped
#    to com.covertalert.pixeltest.
run_scenario "other-package-force-finish-stays-green" 0 0 "2100" "$FIXTURES/other-app-force-finish-logcat.txt" "" "" "" "" \
  "Smoke test passed"

# 6. BootReceiver crashes on the BOOT_COMPLETED broadcast while the activity
#    phases were healthy -> job must go RED via the phase-3 logcat grep,
#    with the receiver crash excerpt shown.
run_scenario "boot-receiver-crash" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "$FIXTURES/boot-crash-logcat.txt" "" "" \
  "Fatal crash detected in logcat after BOOT_COMPLETED broadcast" "FATAL EXCEPTION" "BOOT-RECEIVER-CRASH-MARKER"

# 7. The BOOT_COMPLETED broadcast itself fails to send even as root
#    -> job must go RED with the broadcast error.
run_scenario "boot-broadcast-failure" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" 1 "" "" "" \
  "am broadcast failed" "BOOT_COMPLETED"

# 8. `adb root` does not yield a root shell (e.g. someone switches the job to
#    a non-rootable google_play image) -> the protected BOOT_COMPLETED
#    broadcast cannot be sent; job must go RED at the explicit uid check
#    instead of dying later on a SecurityException.
SMOKE_SHELL_UID=2000 run_scenario "adb-root-unavailable" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "adb root did not yield a root shell"

# 9. BootReceiver crashes in the locked (pre-unlock) boot — the realistic
#    direct-boot regression shape, e.g. TestStore switched from
#    device-protected to credential-encrypted storage. -> job must go RED via
#    the package-scoped FATAL grep on the post-reboot logcat, with the crash
#    excerpt shown.
run_scenario "locked-boot-receiver-crash" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "$FIXTURES/locked-boot-crash-logcat.txt" \
  "BootReceiver crashed during locked (pre-unlock) boot" "FATAL EXCEPTION" "LOCKED-BOOT-CRASH-MARKER"

# 10. Locked boot completes with no crash, but the device-protected journal
#     has NO LOCKED_BOOT_COMPLETED event — the receiver never ran (e.g. a
#     manifest regression dropped directBootAware or the intent-filter).
#     -> job must go RED: no-crash alone is not proof of delivery.
SMOKE_JOURNAL_FIXTURE="$FIXTURES/journal-missing-locked-boot.xml" \
  run_scenario "locked-boot-no-delivery-evidence" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "did not record the pre-unlock broadcast"

# 11. The device fails to stay locked after the PIN-protected reboot (e.g. the
#     image has no FBE credential gating, so ce_available flips to true
#     immediately). The phase would prove nothing about the pre-unlock path
#     -> job must go RED at the explicit locked-state precondition assert
#     instead of silently claiming direct-boot coverage.
SMOKE_CE_AVAILABLE_AFTER_REBOOT=true \
  run_scenario "locked-state-precondition-fails" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "NOT in the locked/direct-boot state"

# 12. locksettings set-pin fails (e.g. the job is switched to an image where
#     the shell cannot set a credential) -> job must go RED at the set-pin
#     error instead of rebooting into a meaningless unlocked state.
SMOKE_LOCKSETTINGS_EXIT=1 \
  run_scenario "set-pin-failure" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "locksettings set-pin failed"

# 13. EvidenceCaptureService dies mid-capture (the realistic runtime
#     regression shape, e.g. an uncaught camera-session error escaping the
#     per-kind catch) -> job must go RED at the phase-4 FATAL grep during
#     the journal poll, with the crash excerpt shown — not after burning
#     the full capture timeout.
run_scenario "evidence-capture-crash" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "$FIXTURES/evidence-crash-logcat.txt" "" \
  "EvidenceCaptureService crashed" "FATAL EXCEPTION" "EVIDENCE-CRASH-MARKER"

# 14. Capture finishes one kind short (service hung or silently skipped
#     audio — no crash, no outcome) -> job must go RED at the poll timeout
#     naming the missing kind; no-crash alone is not proof of capture.
SMOKE_JOURNAL_FIXTURE="$FIXTURES/journal-capture-missing-audio.xml" \
  run_scenario "evidence-capture-missing-outcome" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "No EVIDENCE_CAPTURE outcome recorded for kind(s): audio"

# 15. One kind journals a well-formed FAILED with detail (the per-kind
#     catch shape of an ordinary camera/recorder regression, e.g. a
#     camera-session misconfiguration throwing on every capture) while the
#     others capture -> job must go RED naming the kind. The pinned CI
#     image demonstrably captures all three kinds, so any FAILED is a
#     regression, not emulated-hardware variance; accepting clean FAILEDs
#     would let a capture-everything breakage ship green. The retry fires
#     (fresh state re-serves the same fixture) and the regression persists,
#     so the run is still red.
SMOKE_JOURNAL_FIXTURE="$FIXTURES/journal-capture-clean-failed.xml" \
  run_scenario "evidence-capture-failed-goes-red" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "Retrying once with fresh app state" "still not CAPTURED for kind(s) audio" "setAudioSource failed"

# 16. The service start itself fails (e.g. a manifest regression renaming
#     the component) -> job must go RED at the start-foreground-service
#     error, not at a confusing journal timeout.
SMOKE_AM_FGS_EXIT=1 \
  run_scenario "service-start-failure" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "EvidenceCaptureService did not start"

# 17. A runtime permission cannot be granted (e.g. a manifest regression
#     dropping the CAMERA uses-permission) -> job must go RED at the
#     pm grant error instead of a misleading capture timeout.
SMOKE_PM_GRANT_EXIT=1 \
  run_scenario "pm-grant-failure" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "pm grant android.permission.CAMERA failed"

# 18. The service starts but fails before any capture and journals
#     CAPTURE_START_FAILED (the shape first observed live: a missing
#     WAKE_LOCK permission SecurityException) -> job must go RED fast with
#     the journal detail, not after burning the whole capture timeout.
SMOKE_JOURNAL_FIXTURE="$FIXTURES/journal-capture-start-failed.xml" \
  run_scenario "capture-start-failed-fast-red" 1 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "failed before any capture" "CAPTURE_START_FAILED" "WAKE_LOCK"

# 19. Attempt 1 has a transient per-kind FAILED (the shape observed live on
#     the local TCG emulator: MediaRecorder "prepare failed" while the
#     emulated OMX codec service was still coming up) but the fresh-state
#     retry captures everything -> job must stay GREEN. Proves the retry
#     absorbs emulator readiness flakes without masking persistent
#     regressions (scenario 15).
SMOKE_JOURNAL_FIXTURE="$FIXTURES/journal-capture-video-flake.xml" \
SMOKE_JOURNAL_FIXTURE_AFTER_CLEAR="$FIXTURES/journal-healthy.xml" \
  run_scenario "evidence-capture-retry-recovers-green" 0 0 "2100" "$FIXTURES/healthy-logcat.txt" "" "" "" "" \
  "video: not CAPTURED" "Retrying once with fresh app state" "Smoke test passed"

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "RESULT: $FAILURES scenario(s) failed — the smoke-test detection logic is NOT trustworthy."
  exit 1
fi
echo "RESULT: all scenarios behaved as expected — red on crash, green on healthy launch."
