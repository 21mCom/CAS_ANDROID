#!/usr/bin/env bash
# End-to-end proof of the handset device-direct SMS flow on a booted Android
# emulator, driven against a dev CAS API:
#
#   1. Contract preflight: the device-pending / device-receipt / sms-receipt
#      endpoints must enforce their documented auth and body shapes BEFORE the
#      emulator is involved, so contract drift fails fast and loudly.
#   2. Alert phase: the app (SmsFlowActivity, mode=alert) triggers an incident
#      and texts a deliberately broken responder number from the emulator's
#      radio; the receipt must move the console's outbox item QUEUED ->
#      DEAD_LETTER.
#   3. Re-queue phase: the console re-queues the item, the app
#      (mode=requeue) picks it up via device-pending with a fixed number, and
#      the receipt must move the item -> SENT.
#   4. Evidence: the on-device journal must show the receipts were actually
#      POSTed (REPORTED), and logcat must hold no fatal crash for the app.
#
# Required env:
#   CAS_FLOW_APK           path to the built app-debug.apk
#   CAS_FLOW_API_HOST      API base URL from the host, e.g. http://127.0.0.1:5055
#   CAS_FLOW_DEVICE_TOKEN  shared handset credential (matches CAS_DEVICE_TOKEN)
#   CAS_FLOW_ALERT_TOKEN   alert credential (matches CAS_ALERT_TOKEN); the
#                          trigger and console re-queue endpoints 401 without it
# Optional env:
#   CAS_FLOW_API_DEVICE    API base URL as the device sees it. Default: the
#                          harness runs `adb reverse tcp:<port> tcp:<port>` and
#                          uses http://127.0.0.1:<port>, which works identically
#                          on emulators and USB-attached field devices (the
#                          qemu 10.0.2.2 host alias is NOT reliable in
#                          sandboxed/containerized hosts).
# Optional env:
#   CAS_FLOW_BAD_NUMBER    responder number that must fail on the radio
#                          (default: not-a-real-number — the emulator's fake
#                          modem rejects non-dialable destinations)
#   CAS_FLOW_GOOD_NUMBER   responder number that must succeed (default: +15550100)
#   CAS_FLOW_TIMEOUT_S     per-phase wait budget (default: 180)
set -euo pipefail

PKG="com.covertalert.pixeltest"
JOURNAL="/data/user_de/0/$PKG/shared_prefs/gate0a-local-journal.xml"
BAD_NUMBER="${CAS_FLOW_BAD_NUMBER:-not-a-real-number}"
GOOD_NUMBER="${CAS_FLOW_GOOD_NUMBER:-+15550100}"
TIMEOUT_S="${CAS_FLOW_TIMEOUT_S:-180}"

for var in CAS_FLOW_APK CAS_FLOW_API_HOST CAS_FLOW_DEVICE_TOKEN CAS_FLOW_ALERT_TOKEN; do
  if [ -z "${!var:-}" ]; then
    echo "::error::Required environment variable $var is not set."
    exit 1
  fi
done

# Tunnel the host's API port into the device over adb (USB/emulator agnostic).
API_PORT_FROM_URL="${CAS_FLOW_API_HOST##*:}"
API_PORT_FROM_URL="${API_PORT_FROM_URL%%/*}"
case "$API_PORT_FROM_URL" in
  ''|*[!0-9]*) echo "::error::cannot parse a numeric port from CAS_FLOW_API_HOST=$CAS_FLOW_API_HOST"; exit 1 ;;
esac
CAS_FLOW_API_DEVICE="${CAS_FLOW_API_DEVICE:-http://127.0.0.1:$API_PORT_FROM_URL}"

# The journal is a SharedPreferences XML that also stores the device access
# token and the responder numbers — never print it raw (a failed run on a
# field device would otherwise log a real console credential). Extract only
# the events element; event payloads carry masked responder tails and no
# credentials.
read_journal_events() {
  adb shell cat "$JOURNAL" 2>/dev/null \
    | grep -o '<string name="events">.*</string>' \
    | sed -e 's/^<string name="events">//' -e 's|</string>$||'
}

dump_diagnostics() {
  # The journal lives in device-protected storage; root is needed to read it
  # (the google_apis emulator image is rootable).
  adb root > /dev/null 2>&1 || true
  adb wait-for-device 2>/dev/null || true
  echo "--- device journal events (redacted) ---"
  journal_events="$(read_journal_events || true)"
  if [ -z "$journal_events" ]; then echo "(journal unreadable)"; else echo "$journal_events"; fi
  echo "--- logcat tail ---"
  adb logcat -d 2>/dev/null | grep -B2 -A30 'FATAL EXCEPTION' || true
  adb logcat -d 2>/dev/null | tail -60 || true
}

fail() {
  echo "::error::$1"
  dump_diagnostics
  exit 1
}

http_status() { # method url [data] [device-token] [alert-token]
  local method="$1" url="$2" data="${3:-}" token="${4:-}" alert_token="${5:-}"
  local args=(-s -o /tmp/sms-flow-response.json -w '%{http_code}' -X "$method")
  if [ -n "$data" ]; then
    args+=(-H 'Content-Type: application/json' --data "$data")
  fi
  if [ -n "$token" ]; then
    args+=(-H "X-CAS-Device-Token: $token")
  fi
  if [ -n "$alert_token" ]; then
    args+=(-H "Authorization: Bearer $alert_token")
  fi
  curl "${args[@]}" "$url"
}

expect_status() { # description expected actual
  if [ "$2" != "$3" ]; then
    echo "Response body: $(cat /tmp/sms-flow-response.json 2>/dev/null | head -c 500)"
    fail "$1: expected HTTP $2, got $3 — the handset-facing contract drifted."
  fi
  echo "contract OK: $1 (HTTP $3)"
}

# --- Step 0: contract preflight (no emulator involvement) -------------------

echo "== Contract preflight against $CAS_FLOW_API_HOST =="

status="$(http_status GET "$CAS_FLOW_API_HOST/api/cas/outbox/device-pending")"
expect_status "device-pending refuses a missing device token" 401 "$status"

status="$(http_status GET "$CAS_FLOW_API_HOST/api/cas/outbox/device-pending" "" "$CAS_FLOW_DEVICE_TOKEN")"
expect_status "device-pending accepts the device token" 200 "$status"
if ! jq -e '.items | type == "array"' /tmp/sms-flow-response.json > /dev/null; then
  fail "device-pending 200 response has no items array — the pickup contract drifted: $(cat /tmp/sms-flow-response.json | head -c 300)"
fi
echo "contract OK: device-pending returns an items array"

probe='{}'
status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/incidents/flow-contract-probe/device-receipt" "$probe" "$CAS_FLOW_DEVICE_TOKEN")"
expect_status "device-receipt rejects a malformed body" 400 "$status"

status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/incidents/flow-contract-probe/device-receipt" '{"channel":"SMS","results":[{"recipient":"+15550100","ok":true}]}')"
expect_status "device-receipt refuses a missing device token" 401 "$status"

status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/incidents/flow-contract-probe/sms-receipt" '{"results":[{"recipient":"+15550100","ok":true}]}')"
expect_status "sms-receipt refuses a missing device token" 401 "$status"

status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/incidents/flow-contract-probe/sms-receipt" "$probe" "$CAS_FLOW_DEVICE_TOKEN")"
expect_status "sms-receipt rejects a malformed body" 400 "$status"

status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/incidents/trigger")"
expect_status "trigger refuses a missing alert credential" 401 "$status"

status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/incidents/trigger" '{}' '' 'not-the-alert-token')"
expect_status "trigger refuses a wrong alert credential" 401 "$status"

status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/outbox/flow-contract-probe-sms/requeue" "$probe")"
expect_status "re-queue refuses a missing alert credential" 401 "$status"

# --- Step 1: install with the SMS permission granted -------------------------

echo "== Installing APK and granting SEND_SMS =="
[ -f "$CAS_FLOW_APK" ] || fail "APK not found at $CAS_FLOW_APK"
# sys.boot_completed flips before the package service answers on slow
# (TCG/CI) boots; wait for pm, then retry the install a few times.
pm_ready=0
for i in $(seq 1 36); do
  if adb shell pm path android > /dev/null 2>&1; then pm_ready=1; break; fi
  sleep 5
done
[ "$pm_ready" = 1 ] || fail "package service never came up after boot."
install_ok=0
install_out=""
for attempt in 1 2 3; do
  install_out="$(adb install -r -g "$CAS_FLOW_APK" 2>&1)" && { install_ok=1; break; }
  echo "adb install attempt $attempt failed: $install_out — retrying in 10s"
  sleep 10
done
[ "$install_ok" = 1 ] || fail "adb install failed after 3 attempts: $install_out"
echo "$install_out"
adb shell pm clear "$PKG" > /dev/null || true
# The grant can be lost when the freshly booted system_server restarts
# mid-install (observed as DeadSystemException on TCG emulators); retry like
# the install step, but still fail loudly when it never sticks.
grant_ok=0
for attempt in 1 2 3; do
  adb shell pm grant "$PKG" android.permission.SEND_SMS > /dev/null 2>&1 || true
  if adb shell dumpsys package "$PKG" 2>/dev/null | grep -q 'android.permission.SEND_SMS: granted=true'; then
    grant_ok=1
    break
  fi
  echo "SEND_SMS grant attempt $attempt did not stick (system may be restarting) — retrying in 10s"
  sleep 10
done
[ "$grant_ok" = 1 ] || fail "SEND_SMS is not granted after 3 pm grant attempts — the flow cannot run."

# Package scanning lags behind install on a freshly booted emulator (observed
# >60s under TCG with a busy post-boot system), and a launch before the
# component registers fails with "Activity class does not exist". Retry that
# specific failure; any other launch error fails loudly.
start_flow_activity() {
  local attempt out
  for attempt in 1 2 3 4 5 6; do
    out="$(adb shell am start -W -n com.covertalert.pixeltest/.SmsFlowActivity "$@" 2>&1)" && { echo "$out"; return 0; }
    echo "$out"
    case "$out" in
      *"does not exist"*)
        echo "component not registered yet (attempt $attempt) — waiting for package scan"
        sleep 15 ;;
      *) return 1 ;;
    esac
  done
  return 1
}
# Fail fast when the device image cannot SMS at all (e.g. an AVD without a
# GSM modem reports "Sms is not supported" from SmsManager) instead of
# burning the whole DEAD_LETTER poll budget.
if ! adb shell pm list features 2>/dev/null | grep -q 'android.hardware.telephony.messaging'; then
  fail "device reports no telephony.messaging feature — SmsManager calls will throw 'Sms is not supported'."
fi
adb logcat -c || true

# SmsFlowActivity is non-exported, and on API 35 the shell user (uid 2000) is
# NOT exempt from the exported check — only root is. The google_apis emulator
# image is rootable, so elevate now. This restarts adbd, which drops any
# reverse tunnels, so it must happen before `adb reverse` below. (USB field
# devices run user builds where adb root is unavailable; operators drive the
# same flow through the interactive MainActivity instead.)
adb root > /dev/null 2>&1 \
  || fail "adb root failed — the harness needs a rootable image (google_apis emulator) to start the non-exported SmsFlowActivity."
adb wait-for-device

# adb reverse: the device reaches the host's dev API as http://127.0.0.1:<port>.
adb reverse "tcp:$API_PORT_FROM_URL" "tcp:$API_PORT_FROM_URL" \
  || fail "adb reverse failed — the device cannot reach the dev API."
reversed="$(adb reverse --list 2>/dev/null || true)"
echo "$reversed" | grep -q "tcp:$API_PORT_FROM_URL" \
  || fail "adb reverse --list does not show tcp:$API_PORT_FROM_URL — tunnel missing: $reversed"
echo "adb reverse tunnel up: device 127.0.0.1:$API_PORT_FROM_URL -> host $CAS_FLOW_API_HOST"

# --- Step 2: alert phase — broken number must dead-letter --------------------

pre_incident="$(curl -s "$CAS_FLOW_API_HOST/api/cas/state" | jq -r '.activeIncident.id // "none"')"
echo "== Alert phase: triggering via the app with broken responder '$BAD_NUMBER' (previous incident: $pre_incident) =="
# SmsFlowActivity is non-exported by design (debug source set; startable only
# as root via `adb root` above); start it by explicit component.
start_flow_activity \
  --es mode alert \
  --es serverUrl "$CAS_FLOW_API_DEVICE" \
  --es deviceToken "$CAS_FLOW_DEVICE_TOKEN" \
  --es alertToken "$CAS_FLOW_ALERT_TOKEN" \
  --es responders "$BAD_NUMBER" || fail "am start of SmsFlowActivity (alert) failed"

deadline=$((SECONDS + TIMEOUT_S))
outbox_id=""
while [ $SECONDS -lt $deadline ]; do
  state_json="$(curl -s "$CAS_FLOW_API_HOST/api/cas/state")"
  incident_id="$(echo "$state_json" | jq -r '.activeIncident.id // ""')"
  if [ -n "$incident_id" ] && [ "$incident_id" != "$pre_incident" ]; then
    item_json="$(echo "$state_json" | jq -c '.activeIncident.outbox | map(select(.transport == "SMS")) | .[0] // empty')"
    if [ -n "$item_json" ]; then
      echo "$item_json" | jq -e 'has("id") and has("transport") and has("state")' > /dev/null \
        || fail "outbox item shape drifted (missing id/transport/state): $item_json"
      item_state="$(echo "$item_json" | jq -r '.state')"
      outbox_id="$(echo "$item_json" | jq -r '.id')"
      if [ "$item_state" = "DEAD_LETTER" ]; then break; fi
      if [ "$item_state" = "SENT" ]; then
        fail "broken responder number was reported SENT — the failure path is not reaching the receipt contract."
      fi
    fi
  fi
  sleep 3
done

[ -n "$outbox_id" ] || fail "no SMS outbox item appeared within ${TIMEOUT_S}s — the trigger did not reach the console."
final_state="$(curl -s "$CAS_FLOW_API_HOST/api/cas/state" | jq -r --arg id "$outbox_id" '.activeIncident.outbox | map(select(.id == $id)) | .[0].state // ""')"
[ "$final_state" = "DEAD_LETTER" ] || fail "outbox item $outbox_id never reached DEAD_LETTER (state: ${final_state:-missing}) within ${TIMEOUT_S}s — the receipt contract or the app's failure reporting drifted."
echo "Alert phase passed: incident $incident_id, outbox item $outbox_id -> DEAD_LETTER (broken number '$BAD_NUMBER')."

# --- Step 3: console re-queue, then handset pickup with a fixed number -------

echo "== Re-queue phase: console re-queue, handset pickup with fixed number '$GOOD_NUMBER' =="
status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/outbox/$outbox_id/requeue" '{"reason":"emulator flow: responder number corrected"}' '' "$CAS_FLOW_ALERT_TOKEN")"
expect_status "console re-queue of the dead-lettered item" 200 "$status"
jq -e --arg id "$outbox_id" '.id == $id and .state == "QUEUED"' /tmp/sms-flow-response.json > /dev/null \
  || fail "re-queue response drifted (expected {id, state: \"QUEUED\"}): $(cat /tmp/sms-flow-response.json | head -c 300)"
echo "contract OK: re-queue returned {id, state: QUEUED}"

start_flow_activity \
  --es mode requeue \
  --es serverUrl "$CAS_FLOW_API_DEVICE" \
  --es deviceToken "$CAS_FLOW_DEVICE_TOKEN" \
  --es alertToken "$CAS_FLOW_ALERT_TOKEN" \
  --es responders "$GOOD_NUMBER" || fail "am start of SmsFlowActivity (requeue) failed"

deadline=$((SECONDS + TIMEOUT_S))
sent=""
while [ $SECONDS -lt $deadline ]; do
  item_state="$(curl -s "$CAS_FLOW_API_HOST/api/cas/state" | jq -r --arg id "$outbox_id" '.activeIncident.outbox | map(select(.id == $id)) | .[0].state // ""')"
  if [ "$item_state" = "SENT" ]; then sent=1; break; fi
  if [ "$item_state" = "DEAD_LETTER" ]; then
    fail "fixed responder number dead-lettered after re-queue — the emulator radio did not accept '$GOOD_NUMBER'."
  fi
  sleep 3
done
[ -n "$sent" ] || fail "outbox item $outbox_id never reached SENT within ${TIMEOUT_S}s after re-queue pickup — the device-pending pickup or receipt contract drifted."
echo "Re-queue phase passed: outbox item $outbox_id -> SENT after handset pickup."

# --- Step 4: on-device evidence ----------------------------------------------

echo "== Evidence phase: on-device journal and crash check =="
adb root > /dev/null 2>&1 || true
adb wait-for-device
journal="$(read_journal_events || true)"
[ -n "$journal" ] || fail "could not read the on-device journal events at $JOURNAL (adb root unavailable?)."
echo "$journal" | grep -q 'SMS_RECEIPT_OUTCOME' || fail "no SMS_RECEIPT_OUTCOME in the device journal — the handset never reported a receipt."
echo "$journal" | grep -q 'REPORTED' || fail "no REPORTED receipt outcome in the device journal — receipts did not reach the console."
echo "$journal" | grep -q 'REQUEUE_CHECK_OUTCOME' || fail "no REQUEUE_CHECK_OUTCOME in the device journal — the device-pending pickup never ran."
echo "$journal" | grep -q 'SMS_SEND_OUTCOME' || fail "no SMS_SEND_OUTCOME in the device journal — the radio batch never finalized."

if adb logcat -d | grep -A2 'FATAL EXCEPTION' | grep -q "Process: $PKG"; then
  fail "fatal crash for $PKG found in logcat during the SMS flow."
fi

echo "SMS flow proof passed: QUEUED -> DEAD_LETTER (broken number) -> QUEUED (re-queue) -> SENT (fixed number), receipts REPORTED from the handset, contracts enforced."
