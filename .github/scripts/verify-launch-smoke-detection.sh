#!/usr/bin/env bash
# verify-launch-smoke-detection.sh
#
# Proves that the launch-smoke-test job in android-test-package-build.yml
# actually turns red when the test app crashes on launch, and stays green
# for a healthy launch.
#
# The harness extracts the job's `script:` block VERBATIM from the workflow
# file (so any future edit to the detection logic is what gets tested) and
# runs it against a fake `adb` that simulates healthy and crash scenarios.
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
FIXTURES="$REPO_ROOT/.github/scripts/launch-smoke-fixtures"

# ---------------------------------------------------------------------------
# Extract the launch-smoke-test job's `script: |` block from the workflow.
# The block scalar's content indent is the `script:` key indent + 2 spaces.
# ---------------------------------------------------------------------------
extract_script() {
  awk '
    /^  launch-smoke-test:/ { in_job = 1 }
    in_job && /^[[:space:]]+script: \|/ {
      match($0, /^[[:space:]]*/); base = RLENGTH; in_block = 1; next
    }
    in_block {
      if ($0 ~ /^[[:space:]]*$/) { print ""; next }
      match($0, /^[[:space:]]+/)
      if (RLENGTH <= base) exit
      print substr($0, base + 3)
    }
  ' "$WORKFLOW"
}

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

EXTRACTED="$TMP_ROOT/launch-smoke-script.sh"
extract_script > "$EXTRACTED"

# Guard: fail loudly if the extraction drifted from what we expect to test.
# Structural markers only — detection patterns are intentionally NOT listed
# here, so a broken pattern is reported as a scenario FAILURE (exit 1), not
# a harness error (exit 2).
for needle in "am start" "pidof com.covertalert.pixeltest" "logcat -d" "Smoke test passed"; do
  if ! grep -qF "$needle" "$EXTRACTED"; then
    echo "HARNESS ERROR: extracted script does not contain '$needle'." >&2
    echo "The workflow structure may have changed; update the extractor." >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Fake adb. Behaviour is driven by three env vars exported per scenario:
#   SMOKE_AM_EXIT        exit code for `adb shell am start ...`
#   SMOKE_PID            printed by `adb shell pidof ...` (empty = no process)
#   SMOKE_LOGCAT_FIXTURE file served by `adb logcat -d`
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
  logcat)
    if [ "${2:-}" = "-c" ]; then exit 0; fi
    cat "$SMOKE_LOGCAT_FIXTURE"
    exit 0
    ;;
  shell)
    case "${2:-}" in
      am)
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
      pidof)
        if [ -n "$SMOKE_PID" ]; then echo "$SMOKE_PID"; fi
        exit 0
        ;;
    esac
    ;;
esac
echo "fake-adb: unsupported command: $*" >&2
exit 2
EOF
chmod +x "$BIN_DIR/adb"

# ---------------------------------------------------------------------------
# Scenario runner.
# ---------------------------------------------------------------------------
FAILURES=0

run_scenario() {
  local name="$1" expected_exit="$2" am_exit="$3" pid="$4" fixture="$5"
  shift 5
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

# 1. Healthy launch -> job must stay GREEN.
run_scenario "healthy-launch" 0 0 "2100" "$FIXTURES/healthy-logcat.txt" \
  "Smoke test passed"

# 2. Crash in onCreate after `am start -W` returns success (the realistic
#    crash-on-launch shape: am start exits 0, then the process dies).
#    -> job must go RED via the pidof check, with the logcat excerpt shown.
run_scenario "crash-after-successful-am-start" 1 0 "" "$FIXTURES/crash-logcat.txt" \
  "crash on launch" "FATAL EXCEPTION" "DELIBERATE-CRASH-MARKER"

# 3. Fatal exception in logcat while a (restarted) process is still alive.
#    -> job must go RED via the logcat grep, with the excerpt shown.
run_scenario "fatal-logcat-with-live-process" 1 0 "2100" "$FIXTURES/crash-logcat.txt" \
  "Fatal crash detected in logcat" "FATAL EXCEPTION" "DELIBERATE-CRASH-MARKER"

# 4. `am start` itself fails. -> job must go RED with the am-start error.
run_scenario "am-start-failure" 1 1 "" "$FIXTURES/healthy-logcat.txt" \
  "am start failed"

# 5. Another package being force-finished during the window must NOT fail
#    our launch -> proves the 'Force finishing activity' pattern is scoped
#    to com.covertalert.pixeltest.
run_scenario "other-package-force-finish-stays-green" 0 0 "2100" "$FIXTURES/other-app-force-finish-logcat.txt" \
  "Smoke test passed"

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "RESULT: $FAILURES scenario(s) failed — the smoke-test detection logic is NOT trustworthy."
  exit 1
fi
echo "RESULT: all scenarios behaved as expected — red on crash, green on healthy launch."
