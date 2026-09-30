#!/usr/bin/env bash
# Send-outcome-line proof: drives the pixeltest app's "Send MVP alert now"
# button on an emulator with UI Automator dumps + adb taps and asserts the
# inline outcome line appears — directly under the button, no scrolling —
# for the configurations an emulator can prove (its modem never registers,
# so SENT-via-SMS stays a hardware proof):
#
#   Phase A  NOT_SENT, nothing configured: fresh install, tap Send ->
#            "NOT_SENT: no responder numbers configured …".
#   Phase B  NOT_SENT, no SMS permission: a responder is configured but
#            SEND_SMS is not granted; tap Send -> permission prompt (denied
#            here) and "NOT_SENT: SMS permission not granted …".
#   Phase C  FAILED, unreachable server: URL + enrollment credential point
#            at a closed loopback port (adb reverse is NOT set, so nothing
#            answers); tap Send -> "FAILED: …" with the handset-SMS
#            fallback line.
#   Phase D  double-tap guard: the URL points at a drip-feed server
#            (.github/scripts/hold_connection_server.py behind adb reverse)
#            that answers one byte at a time, slower than the app's 10s
#            socket read timeout, so the attempt stays in flight for as
#            long as the harness wants — on ANY host speed. A second tap
#            while "Sending alert…" is up must show "Already sending —
#            wait for the current attempt to finish" (never silently
#            swallowed), the journal must record exactly ONE
#            MVP_ALERT_ATTEMPT (the second tap started no attempt), and
#            once the server is killed the line must settle to FAILED —
#            proving the guard released and is not stuck.
#
# Host-speed independence: uiautomator dumps are ~1s on CI's KVM emulator
# but can take minutes on a software-emulated (TCG) host. The harness
# therefore polls the fast on-device journal to learn WHEN an outcome has
# landed and only then spends a dump to assert the text is VISIBLE; phase
# D's drip-feed removes the remaining timing race for the transient
# "Already sending" line. CAS_OUTCOME_TIMEOUT_SCALE multiplies every wait
# for very slow hosts (CI leaves it at 1).
#
# Every phase also asserts the on-device journal (MVP_ALERT_OUTCOME /
# MVP_ALERT_ATTEMPT) like the other emulator proofs, so CI gates on both
# the visible line and the recorded outcome. Any failure exits non-zero
# with ::error::.
#
# App configuration is seeded into the app's SharedPreferences via run-as
# while the app is force-stopped (the debug build is debuggable) — the same
# mechanism verify-receipt-durability-kill.sh and verify-pushless-capture-
# flow.sh use — so the only UI interaction under test is the Send tap
# itself. Plain-HTTP loopback URLs are accepted by AlertSender only for
# 127.0.0.1 / 10.0.2.2 dev endpoints, which is exactly what this uses.
#
# Invoked from .github/workflows/android-test-package-build.yml as a single
# line because reactivecircus/android-emulator-runner executes each line of
# its `script:` input as a separate `sh -c` call — multi-line constructs do
# not survive across lines there.
set -euo pipefail

PKG=com.covertalert.pixeltest
JOURNAL="/data/user_de/0/$PKG/shared_prefs/gate0a-local-journal.xml"
APK="${CAS_OUTCOME_APK:-apk/app-debug.apk}"
HOLD_PORT="${CAS_OUTCOME_HOLD_PORT:-5099}"
SCALE="${CAS_OUTCOME_TIMEOUT_SCALE:-1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Android's default Button style uppercases the label (textAllCaps), and the
# accessibility tree reports the TRANSFORMED text — CI run 36705662402's
# viewport digests showed the button as "SEND MVP ALERT NOW" while a
# sentence-case needle never matched. Match what the dump actually contains.
SEND_LABEL="SEND MVP ALERT NOW"
DUMP_REMOTE="/sdcard/cas-outcome-ui.xml"
HOLD_LOG="$(mktemp /tmp/cas-hold-server.XXXXXX.log)"
HOLD_PID=""
LAST_DUMP=""

fail() {
  echo "::error::$1"
  echo "--- last logcat ---"
  adb logcat -d | tail -100 || true
  echo "--- last UI dump ---"
  printf '%s\n' "${LAST_DUMP:-<none>}" | head -c 4000 || true
  echo
  echo "--- journal ---"
  journal_events || true
  exit 1
}

cleanup() {
  if [ -n "$HOLD_PID" ]; then kill "$HOLD_PID" 2>/dev/null || true; fi
  adb reverse --remove "tcp:$HOLD_PORT" 2>/dev/null || true
  rm -f "$HOLD_LOG"
}
trap cleanup EXIT

# --- helpers ---------------------------------------------------------------

# uiautomator dump can transiently return "ERROR: null root node" right
# after a window transition; retry a few times before giving up.
ui_dump() {
  local i
  for i in 1 2 3 4; do
    if adb shell uiautomator dump "$DUMP_REMOTE" >/dev/null 2>&1; then
      adb shell cat "$DUMP_REMOTE" 2>/dev/null && return 0
    fi
    sleep 2
  done
  return 1
}

# A loaded emulator surfaces ANR ("isn't responding") system dialogs over
# the app; "Wait" keeps the app alive and the proof running. No-op when no
# dialog is up. Consumes/refreshes LAST_DUMP.
dismiss_system_dialogs() {
  if printf '%s' "$LAST_DUMP" | grep -q 'resource-id="android:id/aerr_wait"'; then
    echo "System ANR dialog is covering the app — tapping 'Wait' and continuing."
    tap_text "Wait" || true
    sleep 2
    LAST_DUMP="$(ui_dump || true)"
  fi
}

# Polls the visible UI hierarchy until it contains $1 (or $2*SCALE seconds
# pass). Only visible nodes appear in the dump, so a match IS proof the
# text is on screen. The winning dump is left in LAST_DUMP.
wait_ui_text() { # substring timeout_s
  local deadline=$((SECONDS + $2 * SCALE))
  while [ $SECONDS -lt $deadline ]; do
    LAST_DUMP="$(ui_dump || true)"
    dismiss_system_dialogs
    if printf '%s' "$LAST_DUMP" | grep -qF "$1"; then return 0; fi
    sleep 3
  done
  return 1
}

# Reads the device-local journal (SharedPreferences XML, JSON embedded with
# &quot; escapes) via run-as — no adb root needed on the debuggable build.
journal_events() {
  adb shell "run-as $PKG cat $JOURNAL" 2>/dev/null | sed 's/&quot;/"/g' | tr -d '\n' || true
}

# Cheap, dump-free wait: the journal write and the status-line update are
# both posted by the same code path, so once the journal shows the event a
# single UI dump can prove the text is visible — no matter how slow dumps
# are on this host.
wait_journal() { # extended-regex timeout_s
  local deadline=$((SECONDS + $2 * SCALE))
  while [ $SECONDS -lt $deadline ]; do
    if journal_events | grep -qE "$1"; then return 0; fi
    sleep 5
  done
  return 1
}

assert_journal() { # extended-regex failure-message
  if ! journal_events | grep -qE "$1"; then
    echo "::error::$2"
    echo "--- journal ---"
    journal_events
    exit 1
  fi
}

# Taps the center of the visible node whose text attribute is exactly $1.
tap_text() { # exact-label
  local xml node bounds nums x1 y1 x2 y2
  xml="$(ui_dump)" || return 1
  node="$(printf '%s' "$xml" | grep -o '<node[^>]*text="'"$1"'"[^>]*>' | head -1 || true)"
  if [ -z "$node" ]; then
    LAST_DUMP="$xml"
    return 1
  fi
  bounds="$(printf '%s' "$node" | grep -o 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | head -1)"
  nums="$(printf '%s' "$bounds" | grep -o '[0-9]\+')"
  x1="$(printf '%s\n' "$nums" | sed -n 1p)"; y1="$(printf '%s\n' "$nums" | sed -n 2p)"
  x2="$(printf '%s\n' "$nums" | sed -n 3p)"; y2="$(printf '%s\n' "$nums" | sed -n 4p)"
  adb shell input tap $(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 ))
}

# Scrolls the main ScrollView until $1 is visible. uiautomator serializes
# ONLY the visible viewport (proven on CI run 36704614391: the failure dump
# held a single text node — the off-screen button was absent), so every
# position change is re-dumped. `input swipe` cannot go slow enough to stay
# under ScrollView's fling threshold, so ANY drag may overshoot: the loop
# therefore sweeps down until the viewport stops moving (digest unchanged),
# then reverses and sweeps up, alternating until the target appears. The
# per-pass digest is also logged so CI logs show the viewport journey.
# If the found node hugs the bottom edge, nudges once more so the status line
# directly under it is on screen too — the phase assertions then prove
# "inline, no scrolling" by finding BOTH in one dump.
scroll_to_text() { # substring
  local size w h i node bounds y2 prev_digest digest dir
  size="$(adb shell wm size | grep -o '[0-9]\+x[0-9]\+' | tail -1)"
  w="${size%x*}"; h="${size#*x}"
  prev_digest=""
  dir=down
  for i in $(seq 1 $((30 * SCALE))); do
    LAST_DUMP="$(ui_dump || true)"
    dismiss_system_dialogs
    digest="$(printf '%s' "$LAST_DUMP" | grep -oE "text=[\"'][^\"']{1,32}" | head -12 | tr '\n' '|')"
    echo "scroll pass $i ($dir): visible: ${digest:-<none>}"
    if printf '%s' "$LAST_DUMP" | grep -qF "$1"; then
      node="$(printf '%s' "$LAST_DUMP" | grep -o '<node[^>]*text="'"$1"'"[^>]*>' | head -1 || true)"
      bounds="$(printf '%s' "$node" | grep -o 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | head -1 || true)"
      y2="$(printf '%s' "$bounds" | grep -o '[0-9]\+' | sed -n 4p)"
      if [ -n "$y2" ] && [ "$y2" -gt $(( h * 4 / 5 )) ]; then
        adb shell input swipe $((w / 2)) $((h * 3 / 5)) $((w / 2)) $((h * 7 / 20)) 700
        sleep 1
        LAST_DUMP="$(ui_dump || true)"
        printf '%s' "$LAST_DUMP" | grep -qF "$1" && return 0
      else
        return 0
      fi
    fi
    # If our app is not even in the hierarchy (a system dialog owned the
    # screen), bring it back to the front instead of swiping system UI.
    if ! printf '%s' "$LAST_DUMP" | grep -q "package=\"$PKG\""; then
      launch_main
      sleep 2
      continue
    fi
    # A drag that changes nothing means the viewport hit a boundary
    # (or the fling overshot into a wall of one tall view): reverse the
    # sweep. The cleared digest forces one probe dump in the new direction.
    if [ -n "$digest" ] && [ "$digest" = "$prev_digest" ]; then
      if [ "$dir" = "down" ]; then dir=up; else dir=down; fi
      echo "viewport stopped moving — reversing sweep ($dir)"
      prev_digest=""
      continue
    fi
    prev_digest="$digest"
    if [ "$dir" = "down" ]; then
      adb shell input swipe $((w / 2)) $((h * 3 / 5)) $((w / 2)) $((h * 9 / 20)) 800
    else
      adb shell input swipe $((w / 2)) $((h * 9 / 20)) $((w / 2)) $((h * 3 / 5)) 800
    fi
    sleep 1
  done
  fail "Could not scroll '$1' into view."
}

# Asserts the status text AND the Send button are visible in the SAME dump:
# the outcome line is readable at the button, with no scroll to the report.
assert_inline() { # status-substring phase-label
  if ! printf '%s' "$LAST_DUMP" | grep -qF "$SEND_LABEL"; then
    fail "$2: status text found but the Send button is not on screen with it — the outcome line is not inline."
  fi
  echo "$2: outcome line is inline — '$1' visible together with '$SEND_LABEL' (no scrolling)."
}

reset_app() { # grant-sms? (true|false)
  adb shell pm clear "$PKG" > /dev/null || fail "pm clear $PKG failed."
  if [ "$1" = "true" ]; then
    adb shell pm grant "$PKG" android.permission.SEND_SMS || fail "pm grant SEND_SMS failed."
  fi
}

# Seeds the app's SharedPreferences while it is force-stopped (same run-as
# mechanism as the kill/pushless harnesses). Args are key/value pairs; only
# string keys are needed here.
seed_prefs() { # key value [key value...]
  local tmp
  tmp="$(mktemp)"
  {
    echo "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>"
    echo '<map>'
    while [ $# -ge 2 ]; do
      printf '    <string name="%s">%s</string>\n' "$1" \
        "$(printf '%s' "$2" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/"/\&quot;/g')"
      shift 2
    done
    echo '</map>'
  } > "$tmp"
  adb shell "run-as $PKG sh -c 'mkdir -p /data/user_de/0/$PKG/shared_prefs && cat > $JOURNAL'" < "$tmp" \
    || fail "run-as seeding of $JOURNAL failed (is this a debuggable build?)."
  rm -f "$tmp"
}

launch_main() {
  local i
  for i in 1 2 3; do
    if adb shell am start -W -n "$PKG/.MainActivity" > /dev/null 2>&1; then return 0; fi
    sleep 10
  done
  fail "MainActivity did not launch after 3 attempts."
}

tap_send() {
  scroll_to_text "$SEND_LABEL"
  tap_text "$SEND_LABEL" || fail "The '$SEND_LABEL' button was visible to scroll_to_text but not tappable."
}

# --- setup -------------------------------------------------------------------

if [ ! -f "$APK" ]; then
  fail "APK missing at $APK (set CAS_OUTCOME_APK to override)."
fi

# Boot-complete flips before the system providers are usable on a slow
# emulator; gate on the provisioning answer and a stopped boot animation
# before installing (CI's runner has long done this; a fresh local AVD has
# not). Every probe tolerates a transient adb failure (a device mid-reconnect
# answers "device offline" with a non-zero exit — that is a reason to keep
# waiting, never a reason to die under pipefail).
adb wait-for-device || fail "No adb device attached."
deadline=$((SECONDS + 300 * SCALE))
while [ $SECONDS -lt $deadline ]; do
  provisioned="$(adb shell settings get global device_provisioned 2>/dev/null | tr -d '[:space:]' || true)"
  bootanim="$(adb shell getprop init.svc.bootanim 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "$provisioned" = "1" ] && [ "$bootanim" = "stopped" ]; then break; fi
  sleep 5
done
[ "$provisioned" = "1" ] && [ "$bootanim" = "stopped" ] \
  || fail "Emulator did not become install-ready within $((300 * SCALE))s (provisioned='$provisioned' bootanim='$bootanim')."

installed=""
for i in 1 2 3; do
  if adb install -r "$APK"; then installed=1; break; fi
  echo "adb install attempt $i failed — retrying in 10s (slow post-boot package manager)."
  sleep 10
done
[ -n "$installed" ] || fail "adb install $APK failed after 3 attempts."
# Clearing logcat keeps the end-of-run crash sweep scoped to this run, but
# some images let the shell clear only the main buffer — never let the clear
# itself fail the proof (the sweep is package-scoped either way).
adb logcat -c 2>/dev/null || adb logcat -b main -c 2>/dev/null || true
adb shell input keyevent KEYCODE_WAKEUP > /dev/null 2>&1 || true
adb shell wm dismiss-keyguard > /dev/null 2>&1 || true

# --- Phase A: NOT_SENT, nothing configured ----------------------------------
echo "Phase A: fresh install, no responders and no server — expecting the NOT_SENT (no responders) line."
reset_app false
launch_main
tap_send
wait_journal '"type":"MVP_ALERT_OUTCOME"[^{}]*"outcome":"NOT_SENT"' 60 \
  || fail "Phase A: journal never recorded the MVP_ALERT_OUTCOME NOT_SENT event after the Send tap."
wait_ui_text "NOT_SENT: no responder numbers configured" 30 \
  || fail "Phase A: status line never showed the NOT_SENT (no responders) text."
assert_inline "NOT_SENT: no responder numbers configured" "Phase A"
assert_journal '"type":"MVP_ALERT_OUTCOME"[^{}]*"outcome":"NOT_SENT"' \
  "Phase A: journal is missing the MVP_ALERT_OUTCOME NOT_SENT record."
echo "Phase A passed."

# --- Phase B: NOT_SENT, SMS permission missing -------------------------------
echo "Phase B: a responder is configured but SEND_SMS is not granted — expecting the NOT_SENT (permission) line."
reset_app false
seed_prefs sms_responders "+15550100"
launch_main
tap_send
wait_journal '"type":"MVP_ALERT_OUTCOME"[^{}]*"outcome":"NOT_SENT","reason":"SEND_SMS permission not granted' 60 \
  || fail "Phase B: journal never recorded the NOT_SENT (SMS permission) event after the Send tap."
# The app requests SEND_SMS inline; deny it via the system dialog so the run
# proves the prompt path a field sender would see. On API 35 the destructive
# button is "Don't allow".
if wait_ui_text "Don't allow" 20; then
  tap_text "Don't allow" || adb shell input keyevent KEYCODE_BACK
else
  echo "Permission dialog text not found — dismissing with BACK instead."
  adb shell input keyevent KEYCODE_BACK
fi
wait_ui_text "NOT_SENT: SMS permission not granted" 30 \
  || fail "Phase B: status line never showed the NOT_SENT (SMS permission) text."
assert_inline "NOT_SENT: SMS permission not granted" "Phase B"
echo "Phase B passed."

# --- Phase C: FAILED, server unreachable --------------------------------------
echo "Phase C: server URL points at a closed loopback port — expecting the FAILED line with the handset-SMS fallback."
reset_app true
seed_prefs alert_server_url "http://127.0.0.1:59990" alert_token "ci-outcome-line-credential"
launch_main
tap_send
wait_journal '"type":"MVP_ALERT_OUTCOME"[^{}]*"outcome":"FAILED"' 90 \
  || fail "Phase C: journal never recorded the MVP_ALERT_OUTCOME FAILED event after the Send tap."
wait_ui_text "FAILED:" 30 \
  || fail "Phase C: status line never showed the FAILED text."
assert_inline "FAILED:" "Phase C"
echo "Phase C passed."

# --- Phase D: double-tap during an in-flight attempt ---------------------------
echo "Phase D: server answers one drip at a time, keeping the attempt in flight — expecting the 'Already sending' guard on a second tap, then a settled FAILED once the server dies."
python3 "$SCRIPT_DIR/hold_connection_server.py" "$HOLD_PORT" > "$HOLD_LOG" 2>&1 &
HOLD_PID=$!
deadline=$((SECONDS + 20 * SCALE))
until grep -q "READY" "$HOLD_LOG" 2>/dev/null; do
  [ $SECONDS -lt $deadline ] || fail "hold-connection server did not start: $(cat "$HOLD_LOG")"
  sleep 1
done
adb reverse "tcp:$HOLD_PORT" "tcp:$HOLD_PORT" || fail "adb reverse tcp:$HOLD_PORT failed."
reset_app true
seed_prefs alert_server_url "http://127.0.0.1:$HOLD_PORT" alert_token "ci-outcome-line-credential"
launch_main
tap_send
wait_journal '"type":"MVP_ALERT_ATTEMPT"' 60 \
  || fail "Phase D: journal never recorded the first tap's MVP_ALERT_ATTEMPT."
wait_ui_text "Sending alert" 30 \
  || fail "Phase D: the in-flight 'Sending alert…' line never appeared after the first tap."
# The drip-feed server keeps this attempt in flight indefinitely (each 5s
# drip beats the app's 10s socket read timeout), so this second tap lands
# mid-attempt no matter how slow this host's dumps are.
tap_text "$SEND_LABEL" || fail "Phase D: the Send button was not tappable for the second tap."
wait_ui_text "Already sending" 30 \
  || fail "Phase D: the second tap during the in-flight attempt was silently swallowed — no 'Already sending' guard text."
assert_inline "Already sending" "Phase D (guard)"
# The second tap must not have started a second attempt: exactly one
# MVP_ALERT_ATTEMPT so far.
attempts="$(journal_events | grep -o '"type":"MVP_ALERT_ATTEMPT"' | wc -l | tr -d '[:space:]')"
[ "$attempts" = "1" ] \
  || fail "Phase D: expected exactly 1 MVP_ALERT_ATTEMPT (the guarded tap starts none), found $attempts."
# The guard must RELEASE: kill the drip server, the in-flight read fails,
# and the line settles to FAILED. If it never settles, alertInFlight is
# stuck and later taps would be swallowed forever.
kill "$HOLD_PID" 2>/dev/null || true
HOLD_PID=""
adb reverse --remove "tcp:$HOLD_PORT" 2>/dev/null || true
wait_journal '"type":"MVP_ALERT_OUTCOME"[^{}]*"outcome":"FAILED"' 120 \
  || fail "Phase D: the in-flight attempt never settled to FAILED after the server died — the send guard is stuck."
wait_ui_text "FAILED:" 30 \
  || fail "Phase D: status line never settled to FAILED after the server died."
attempts="$(journal_events | grep -o '"type":"MVP_ALERT_ATTEMPT"' | wc -l | tr -d '[:space:]')"
[ "$attempts" = "1" ] \
  || fail "Phase D: expected exactly 1 MVP_ALERT_ATTEMPT for the whole phase, found $attempts."
echo "Phase D passed."

# --- final crash sweep ---------------------------------------------------------
if adb logcat -d | grep -A2 'FATAL EXCEPTION' | grep -q "Process: $PKG"; then
  echo "::error::The app crashed during the outcome-line run — FATAL EXCEPTION for $PKG in logcat."
  adb logcat -d | grep -B2 -A30 'FATAL EXCEPTION' || true
  exit 1
fi

echo "Send-outcome-line proof passed: NOT_SENT (no responders), NOT_SENT (no SMS permission), FAILED (unreachable server), and the double-tap 'Already sending' guard all shown inline under the Send button and journaled on-device."
