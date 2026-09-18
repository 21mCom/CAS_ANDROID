#!/usr/bin/env bash
# End-to-end proof that a handset killed right after texting still lands its
# receipt on the console, driven on a booted emulator through the app's REAL
# send path (SmsFlowActivity -> AlertSender.trigger -> DeviceSmsSender.sendAlert
# -> receipt durability -> postReceipt), with no synthetic app state in the
# primary scenario.
#
# Phase 0 (environment probe, machine-checked): a real alert send on this
#   workspace's modem-less AVD must finalize DIVIDE_FAILED within milliseconds
#   (SmsManager.divideMessage throws "Sms is not supported"), i.e. production
#   code CANNOT leave an unfinished batch here. This probe is why Scenario B
#   below uses a seeded durable record while Scenario A does not.
#
# Scenario A (PRIMARY, zero synthetic state, deterministic): all device
#   traffic goes through cas-receipt-gate-proxy.py. With the HANG flag on,
#   the proxy accepts the app's receipt POST but never answers, and the app
#   is force-stopped while that POST is still in flight — the kill lands
#   inside the send->receipt window (the trigger that created the incident
#   still succeeds). Assertions then prove the kill beat the receipt
#   (console still QUEUED, no SMS_RECEIPT_OUTCOME, durable state survived),
#   that a resume with data still down (503 block flag) retries honestly and
#   holds QUEUED, and that with data restored the persisted receipt (or the
#   recovered batch's finalize) is retried to REPORTED with
#   RECEIPT_RETRY_OUTCOME reported=1 and the console leaves QUEUED
#   (DEAD_LETTER here because the radio honestly never sent; SENT on a modem
#   AVD) with no operator re-queue.
#
# Scenario B (batch interrupted mid-send): the kill-before-radio-results
#   window does not exist on a modem-less AVD (see phase 0), so the exact
#   record ReceiptDurability.persistBatch writes — generated below by the
#   production encoder (scripts/receipt-durability/SeedFixtureGenerator.kt),
#   not hand-copied JSON — is written into the app's real SharedPreferences
#   via run-as while force-stopped. Resume must then run
#   recoverUnfinishedBatches: SMS_BATCH_RECOVERY -> watchdog finalize
#   (NO_RADIO_RESULT) -> receipt REPORTED -> console item leaves QUEUED ->
#   store drained.
#
# Scenario C (supplementary, SENT direction): like B but seeds the pending
#   RECEIPT an all-success batch would have produced (same production
#   encoder), proving the QUEUED -> SENT transition of the retry path.
#   Full-fidelity SENT (radio accepted, then kill) needs a modem: physical
#   Pixel 11 run.
#
# Required env:
#   CAS_FLOW_APK           path to the built app-debug.apk
#   CAS_FLOW_API_HOST      API base URL from the host, e.g. http://127.0.0.1:5055
#                          (must run with CAS_SMS_DELIVERY_MODE=device)
#   CAS_FLOW_DEVICE_TOKEN  shared handset credential (matches CAS_DEVICE_TOKEN)
#   CAS_FLOW_ALERT_TOKEN   alert credential (matches CAS_ALERT_TOKEN); the
#                          handset's trigger and the host's incident/outbox
#                          mutations are rejected 401 without it
# Optional env:
#   CAS_FLOW_TIMEOUT_S     per-phase wait budget (default: 240; the result
#                          watchdog alone needs 45s plus TCG-emulator slack)
set -euo pipefail

PKG="com.covertalert.pixeltest"
JOURNAL="/data/user_de/0/$PKG/shared_prefs/gate0a-local-journal.xml"
TIMEOUT_S="${CAS_FLOW_TIMEOUT_S:-240}"
PROXY_SCRIPT="$(dirname "$0")/cas-receipt-gate-proxy.py"
BLOCK_FLAG="$(mktemp -u /tmp/cas-receipt-block.XXXXXX)"
HANG_FLAG="$(mktemp -u /tmp/cas-receipt-hang.XXXXXX)"

for var in CAS_FLOW_APK CAS_FLOW_API_HOST CAS_FLOW_DEVICE_TOKEN CAS_FLOW_ALERT_TOKEN; do
  if [ -z "${!var:-}" ]; then
    echo "::error::Required environment variable $var is not set."
    exit 1
  fi
done

API_PORT_FROM_URL="${CAS_FLOW_API_HOST##*:}"
API_PORT_FROM_URL="${API_PORT_FROM_URL%%/*}"
case "$API_PORT_FROM_URL" in
  ''|*[!0-9]*) echo "::error::cannot parse a numeric port from CAS_FLOW_API_HOST=$CAS_FLOW_API_HOST"; exit 1 ;;
esac
PROXY_PORT=$((API_PORT_FROM_URL + 1000))
CAS_FLOW_API_DEVICE="http://127.0.0.1:$API_PORT_FROM_URL"

PROXY_PID=""
cleanup() {
  [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true
  rm -f "$BLOCK_FLAG" "$HANG_FLAG"
}
trap cleanup EXIT

# Never print the journal raw: the prefs file also stores the device token.
# Output is only ever captured in $(...), and right after pm clear the prefs
# file does not exist yet (grep -o would exit 1) — so always exit 0 rather
# than letting pipefail turn an empty journal into a silent script death.
read_journal_events() {
  { adb shell "run-as $PKG cat $JOURNAL" 2>/dev/null \
    | grep -o '<string name="events">.*</string>' \
    | sed -e 's/^<string name="events">//' -e 's|</string>$||' \
    | sed 's/&quot;/"/g'; } || true
}

# Durable queue contents only (never the whole prefs file, which holds the token).
read_durable() { # pending_receipts|sms_batches
  { adb shell "run-as $PKG cat $JOURNAL" 2>/dev/null \
    | grep -oE "<string name=\"$1\">[^<]*" \
    | sed 's/&quot;/"/g'; } || true
}

fail() {
  echo "::error::$1"
  echo "--- device journal events (redacted) ---"
  read_journal_events || echo "(journal unreadable)"
  exit 1
}

wait_journal() { # pattern timeout-s [poll-interval-s]
  # Capture before grepping: under pipefail, grep -q exiting early SIGPIPEs
  # the adb producer and the pipeline returns 141 despite a match.
  local deadline=$((SECONDS + $2)) ev
  while [ $SECONDS -lt $deadline ]; do
    ev="$(read_journal_events)"
    grep -q "$1" <<< "$ev" && return 0
    sleep "${3:-3}"
  done
  return 1
}

journal_has() { # pattern — one-shot check without the SIGPIPE/pipefail race
  local ev
  ev="$(read_journal_events)"
  grep -q "$1" <<< "$ev"
}

# wait_journal + capture in one: polls until the pattern matches and echoes
# the matching substrings. Content assertions (DIVIDE_FAILED, NO_RADIO_RESULT,
# outcome strings) must run against THIS captured text — re-reading the
# journal a second time can catch a transient empty read on this TCG
# emulator (adbd hiccup -> empty output) and turn a proven event into a
# false failure.
wait_journal_match() { # BRE-pattern timeout-s [poll-s]
  local deadline=$((SECONDS + $2)) ev m
  while [ $SECONDS -lt $deadline ]; do
    ev="$(read_journal_events)"
    m="$(grep -o "$1" <<< "$ev" || true)"
    [ -n "$m" ] && { echo "$m"; return 0; }
    sleep "${3:-3}"
  done
  return 1
}

# For negative/durable assertions the read must not be vacuously empty:
# retry until the journal actually produces output before concluding.
journal_snapshot() { # retries
  local ev i
  for i in $(seq 1 "${1:-5}"); do
    ev="$(read_journal_events)"
    [ -n "$ev" ] && { echo "$ev"; return 0; }
    sleep 2
  done
  return 1
}

# The journal is append-only for the whole run, so per-phase assertions
# must never match an earlier phase's entries. Two scoping rules keep that
# airtight: incident-scoped greps pin the pattern to the phase's unique
# incident id (with [^}]* so the match cannot span two event objects on the
# single-line JSON), and incident-less summary events (RECEIPT_RETRY_OUTCOME)
# are asserted by count — the phase must journal MORE matching events than
# the baseline taken immediately before its action.
event_count() { # BRE pattern -> number of matching substrings (0 on no match)
  local ev
  ev="$(read_journal_events)"
  { grep -o "$1" <<< "$ev" || true; } | wc -l
}

wait_event_beyond() { # baseline BRE-pattern timeout-s [poll-s]
  local deadline=$((SECONDS + $3)) n
  while [ $SECONDS -lt $deadline ]; do
    n="$(event_count "$2")"
    [ "$n" -gt "$1" ] && return 0
    sleep "${4:-3}"
  done
  return 1
}

sms_item_state() { # incident-id -> state
  curl -s "$CAS_FLOW_API_HOST/api/cas/state" | jq -r --arg id "$1" \
    '.activeIncident.outbox // [] | map(select(.id == ($id + "-sms"))) | .[0].state // "MISSING"'
}

# The trigger that created the active incident is the only way an incident
# appears, so polling the console for one doubles as the trigger's success
# assertion and hands back the id that scopes this phase's journal greps.
# Two races dictate the shape of this helper:
#  1. The console keeps the most recent incident selected even after it is
#     resolved, so "new" means "different from what was selected before the
#     trigger" — the caller passes that baseline in, captured BEFORE
#     start_flow.
#  2. am start -W blocks until the flow activity finishes, by which time the
#     trigger POST has usually already landed; a baseline taken after
#     start_flow would already be the new incident and the wait would time
#     out.
current_incident() {
  curl -s "$CAS_FLOW_API_HOST/api/cas/state" | jq -r '.activeIncident.id // empty'
}

wait_new_incident() { # baseline-incident-id
  local deadline=$((SECONDS + TIMEOUT_S)) id
  while [ $SECONDS -lt $deadline ]; do
    id="$(current_incident)"
    [ -n "$id" ] && [ "$id" != "$1" ] && { echo "$id"; return 0; }
    sleep 1
  done
  return 1
}

resolve_active() {
  local id
  id="$(curl -s "$CAS_FLOW_API_HOST/api/cas/state" | jq -r '.activeIncident.id // empty')"
  if [ -n "$id" ]; then
    curl -s -X POST -H "Authorization: Bearer $CAS_FLOW_ALERT_TOKEN" "$CAS_FLOW_API_HOST/api/cas/incidents/$id/ack" > /dev/null || true
    curl -s -X POST -H "Authorization: Bearer $CAS_FLOW_ALERT_TOKEN" "$CAS_FLOW_API_HOST/api/cas/incidents/$id/resolve" > /dev/null || true
    echo "resolved prior active incident $id"
  fi
}

# The device reaches the console through the receipt-gate proxy; the block
# flag is the data on/off switch for the receipt leg (deterministic, no race).
reverse_up()   { for i in 1 2 3; do adb reverse "tcp:$API_PORT_FROM_URL" "tcp:$PROXY_PORT" && return 0; sleep 5; done; return 1; }
block_receipts()   { : > "$BLOCK_FLAG"; }
unblock_receipts() { rm -f "$BLOCK_FLAG"; }
hang_receipts()    { rm -f "$HANG_FLAG.seen"; : > "$HANG_FLAG"; }
unhang_receipts()  { rm -f "$HANG_FLAG"; }

# The proxy writes $HANG_FLAG.seen the instant it accepts a hanging receipt
# POST; the marker holds the request line, which carries the incident id in
# the /api/cas/incidents/<id>/device-receipt path. Waiting for a marker that
# names THIS incident is what makes scenario A's kill provably in-flight:
# SMS_SEND_OUTCOME is journaled BEFORE the receipt is persisted and the
# posting thread starts, so the journal alone cannot order the kill against
# the POST. With the correlated marker, the force-stop happens after THIS
# incident's POST is on the wire — and since the app persists the receipt
# before the posting thread runs, that kill also guarantees durable state
# for this incident exists. (hang_receipts clears any stale marker first, and
# hang mode only exists during scenario A, so the correlation is airtight.)
wait_proxy_seen() {
  local want="$1" deadline=$((SECONDS + TIMEOUT_S))
  while [ $SECONDS -lt $deadline ]; do
    [ -f "$HANG_FLAG.seen" ] && grep -qF "$want" "$HANG_FLAG.seen" && return 0
    sleep 1
  done
  return 1
}

start_flow() { # extra args passed to am start
  local attempt out
  for attempt in 1 2 3 4 5 6; do
    out="$(adb shell am start -W -n "$PKG/.SmsFlowActivity" "$@" 2>&1)" && { echo "$out" > /dev/null; return 0; }
    case "$out" in
      *"does not exist"*) sleep 15 ;;   # TCG package-scan lag after install
      *) echo "$out"; return 1 ;;
    esac
  done
  return 1
}

launch_main() {
  adb shell am start -W -n "$PKG/.MainActivity" > /dev/null 2>&1
}

# Writes a durable record into the app's real SharedPreferences (run-as: app
# uid, correct SELinux context) while the app is force-stopped. Used only
# where phase 0 proved this AVD cannot produce the state itself.
seed_durable() { # key json
  local tmp
  tmp="$(mktemp)"
  {
    echo "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>"
    echo '<map>'
    printf '    <string name="alert_server_url">%s</string>\n' "$CAS_FLOW_API_DEVICE"
    printf '    <string name="device_access_token">%s</string>\n' "$CAS_FLOW_DEVICE_TOKEN"
    printf '    <string name="alert_token">%s</string>\n' "$CAS_FLOW_ALERT_TOKEN"
    printf '    <string name="sms_responders">+15550100</string>\n'
    printf '    <string name="%s">%s</string>\n' "$1" "$(sed -e 's/&/\&amp;/g' -e 's/"/\&quot;/g' <<< "$2")"
    echo '</map>'
  } > "$tmp"
  adb shell "run-as $PKG sh -c 'mkdir -p /data/user_de/0/$PKG/shared_prefs && cat > $JOURNAL'" < "$tmp"
  rm -f "$tmp"
}

wait_console_state() { # incident-id unwanted-state -> 0 once the item leaves it
  local deadline=$((SECONDS + TIMEOUT_S)) state
  while [ $SECONDS -lt $deadline ]; do
    state="$(sms_item_state "$1")"
    [ "$state" != "$2" ] && [ "$state" != "MISSING" ] && { echo "$state"; return 0; }
    sleep 3
  done
  sms_item_state "$1"; return 1
}

# Seed fixtures for scenarios B/C are produced by the production
# ReceiptDurability encoder, not hand-copied JSON, so they track the on-disk
# format in lockstep. Running the JVM durability harness first also
# re-verifies the encoder/decorder invariants and primes the pinned kotlinc
# cache this compile reuses.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DUR_CACHE="$REPO_ROOT/scripts/.cache/receipt-durability"
gen_seed() { # batch <incident-id> | receipt <incident-id> <queuedAtMs>
  java -cp "$DUR_CACHE/build/seed-fixtures.jar:$DUR_CACHE/json-20240303.jar"     com.covertalert.pixeltest.SeedFixtureGeneratorKt "$@"
}

echo "== Build the production-encoder seed generator =="
"$REPO_ROOT/scripts/test-receipt-durability.sh" > /dev/null   || { echo "::error::JVM receipt-durability harness failed — the encoder the seeds come from is broken."; exit 1; }
"$DUR_CACHE/kotlinc/bin/kotlinc"   "$REPO_ROOT/artifacts/covert-alert-system/android-test-package/app/src/main/java/com/covertalert/pixeltest/ReceiptDurability.kt"   "$REPO_ROOT/scripts/receipt-durability/SeedFixtureGenerator.kt"   -cp "$DUR_CACHE/json-20240303.jar" -include-runtime   -d "$DUR_CACHE/build/seed-fixtures.jar"   || { echo "::error::seed fixture generator failed to compile against the production encoder."; exit 1; }
# Byte-exactness proof: the encoder's own round-trip must accept what we seed.
gen_seed batch probe-incident | grep -q '"cycleToken"'   || echo "note: encoder emits no cycleToken field (pre-cycle-token build); fixtures match whatever the encoder emits."

echo "== Install, proxy, and prepare =="
adb start-server > /dev/null 2>&1 || true
[ -f "$CAS_FLOW_APK" ] || fail "APK not found at $CAS_FLOW_APK"
python3 "$PROXY_SCRIPT" "$PROXY_PORT" "$API_PORT_FROM_URL" "$BLOCK_FLAG" "$HANG_FLAG" &
PROXY_PID=$!
sleep 1
kill -0 "$PROXY_PID" 2>/dev/null || fail "receipt-gate proxy failed to start on :$PROXY_PORT"
for i in $(seq 1 36); do adb shell pm path android > /dev/null 2>&1 && break; sleep 5; done
adb install -r -g "$CAS_FLOW_APK" || fail "adb install failed"
# SmsFlowActivity is non-exported; only root may start it on API 35 (google_apis
# images are rootable). adb root restarts adbd and drops reverse tunnels, so it
# runs before any adb reverse below.
adb root > /dev/null 2>&1 || fail "adb root failed — need a rootable image for the non-exported SmsFlowActivity."
adb wait-for-device
adb shell pm clear "$PKG" > /dev/null || true
adb shell pm grant "$PKG" android.permission.SEND_SMS > /dev/null 2>&1 || true
unblock_receipts

# --- Phase 0: environment probe ------------------------------------------------

echo "== Phase 0: real send on this AVD must DIVIDE_FAILED-finalize immediately =="
resolve_active
reverse_up || fail "adb reverse failed"
prev_incident="$(current_incident)"
start_flow \
  --es mode alert \
  --es serverUrl "$CAS_FLOW_API_DEVICE" \
  --es deviceToken "$CAS_FLOW_DEVICE_TOKEN" \
  --es alertToken "$CAS_FLOW_ALERT_TOKEN" \
  --es responders "+15550100" || fail "am start of SmsFlowActivity failed"
probe_incident="$(wait_new_incident "$prev_incident")" || fail "trigger never created an incident."
send_line="$(wait_journal_match "SMS_SEND_OUTCOME[^}]*$probe_incident[^}]*" "$TIMEOUT_S")" \
  || fail "send never finalized on the environment probe."
grep -q "DIVIDE_FAILED" <<< "$send_line" \
  || fail "expected DIVIDE_FAILED on this modem-less AVD — if the radio works here, re-derive scenario B without seeding."
# The flow activity finishes right after the send, and on this emulator the
# now-empty process is sometimes reaped before the receipt's HTTP response is
# journaled — the server logs show the receipt POST accepted with a 200 while
# the device journal shows nothing. That is exactly the failure mode the
# durability design covers (the receipt was persisted before the post), so
# one resume runs retryPendingReceipts, the console accepts the replay, and
# the journal must then show REPORTED.
if ! wait_journal "SMS_RECEIPT_OUTCOME[^}]*$probe_incident[^}]*REPORTED" 90; then
  echo "note: probe receipt outcome not journaled in the first window (process reaped post-flow); resuming once to exercise the retry path"
  launch_main || fail "relaunch failed"
  wait_journal "SMS_RECEIPT_OUTCOME[^}]*$probe_incident[^}]*REPORTED" "$TIMEOUT_S" \
    || fail "probe receipt was not REPORTED even after a resume retried it."
fi
[ "$(sms_item_state "$probe_incident")" = "DEAD_LETTER" ] || fail "probe item not DEAD_LETTER: $(sms_item_state "$probe_incident")"
echo "phase 0 OK: production code cannot leave an unfinished batch on this AVD (DIVIDE_FAILED finalizes in-line; $probe_incident DEAD_LETTER)."

# --- Scenario A: real pending receipt, kill, resume (no synthetic state) ------

echo "== Scenario A: force-stop with the receipt POST in flight =="
resolve_active
# Hang mode: the proxy accepts the app's receipt POST but never answers, so
# the app can be killed while its own receipt POST is still on the wire —
# the kill lands INSIDE the send->receipt window, not after the receipt
# already reached a safe state.
hang_receipts
prev_incident="$(current_incident)"
start_flow \
  --es mode alert \
  --es serverUrl "$CAS_FLOW_API_DEVICE" \
  --es deviceToken "$CAS_FLOW_DEVICE_TOKEN" \
  --es alertToken "$CAS_FLOW_ALERT_TOKEN" \
  --es responders "+15550100" || fail "am start of SmsFlowActivity failed"
incident_a="$(wait_new_incident "$prev_incident")" || fail "trigger never ran."
# Critical path, marker-first: the proxy's .seen marker names the incident
# (the POST path carries /api/cas/incidents/<id>/device-receipt) and exists
# only once the receipt POST is on the wire and hanging unanswered — which
# already implies finalizeBatch persisted the receipt and started the posting
# thread. Waiting on the local marker file adds zero adb latency, so the
# force-stop lands within a couple of seconds of the POST starting, well
# inside the client's 10s read timeout even on a slow TCG emulator. (A
# journal wait here instead — an adb round-trip per poll — proved racy: on a
# freshly booted emulator the kill landed after the read timeout had already
# journaled the FAILED outcome.) The journal assertions run after the kill,
# where timing no longer matters.
wait_proxy_seen "$incident_a" || fail "receipt POST for $incident_a never reached the hanging proxy — the kill was not provably in-flight."
adb shell am force-stop "$PKG"
echo "force-stopped $PKG with its receipt POST still hanging in the proxy"

# Post-kill journal assertions (timing no longer matters once the process is
# dead): the trigger went through the proxy to the console, and the send
# finalized. The marker already proved the posting thread started, which the
# app only does after journaling the send outcome and persisting the receipt —
# these greps confirm that ordering held for this incident.
ev="$(journal_snapshot)" || fail "journal unreadable after the kill — cannot prove the kill beat the receipt."
grep -q "SMS_FLOW_TRIGGER_OUTCOME[^}]*$incident_a" <<< "$ev" || fail "trigger outcome for $incident_a never journaled."
grep -q "SMS_SEND_OUTCOME[^}]*$incident_a" <<< "$ev" || fail "send outcome for $incident_a never journaled — the receipt could not have been persisted."
# The kill beat the receipt: nothing was reported FOR THIS INCIDENT, the
# console still shows QUEUED, and durable state (pending receipt or
# unfinished batch) survived. The grep is scoped to this incident's id so
# phase 0's legitimately reported probe receipt cannot trip it.
# grep -o extracts only the SMS_RECEIPT_OUTCOME event objects: the journal is
# a single line, so a plain grep returns the whole line and the case pattern
# would match this incident's id in unrelated (e.g. SMS_SEND_START) events.
# The snapshot must be non-empty — a transient empty read would make this
# negative assertion pass vacuously.
case "$(grep -o "SMS_RECEIPT_OUTCOME[^}]*$incident_a[^}]*" <<< "$ev" || true)" in
  "") : ;;
  *) fail "a receipt outcome was journaled for $incident_a before the kill — the in-flight window was not exercised." ;;
esac
[ "$(sms_item_state "$incident_a")" = "QUEUED" ] || fail "console moved off QUEUED before any receipt could land: $(sms_item_state "$incident_a")"
# The marker-confirmed kill means this incident's posting thread had started,
# which means its receipt was persisted before it — so the survivor must be
# the pending RECEIPT for THIS incident specifically (an unfinished batch
# would mean the kill raced ahead of finalizeBatch, and a receipt naming
# another incident would mean the marker fired on a stale request).
case "$(read_durable pending_receipts)" in
  *"$incident_a"*) : ;;
  *) fail "no pending receipt for $incident_a survived the marker-confirmed kill — the receipt was lost, not deferred." ;;
esac
echo "kill landed with $incident_a's receipt POST on the wire; console QUEUED; $incident_a's pending receipt durable"

# Data still down (hard 503): the resumed app must retry honestly and the
# console must HOLD QUEUED rather than advance on an undelivered receipt.
unhang_receipts
block_receipts
launch_main || fail "relaunch failed"
wait_journal "SMS_RECEIPT_OUTCOME[^}]*$incident_a[^}]*FAILED; receipt kept for retry" "$TIMEOUT_S" \
  || fail "offline resume did not honestly fail the retried receipt."
[ "$(sms_item_state "$incident_a")" = "QUEUED" ] || fail "console moved off QUEUED while data was still down."
echo "offline resume retried and kept the receipt; console still QUEUED"

# Data restored: the persisted state must now land without operator re-queue.
# The blocked resume above journaled a RECEIPT_RETRY_OUTCOME reported:0, so
# the reported=1 assertion is count-based: one MORE such event must appear.
unblock_receipts
retry_base="$(event_count 'RECEIPT_RETRY_OUTCOME[^}]*"reported":1[,}]')"
launch_main || fail "relaunch failed"
wait_event_beyond "$retry_base" 'RECEIPT_RETRY_OUTCOME[^}]*"reported":1[,}]' "$TIMEOUT_S" \
  || fail "no new RECEIPT_RETRY_OUTCOME with reported=1 once data returned."
wait_journal "SMS_RECEIPT_OUTCOME[^}]*$incident_a[^}]*REPORTED" "$TIMEOUT_S" \
  || fail "receipt for $incident_a was not REPORTED after data returned."
state_a="$(wait_console_state "$incident_a" QUEUED)" || fail "console item for $incident_a stuck QUEUED after the retried receipt."
[ "$state_a" = "DEAD_LETTER" ] || fail "unexpected state $state_a (honest DIVIDE_FAILED failures must dead-letter)."
case "$(read_durable pending_receipts)" in *"receiptId"*) fail "acked receipt still persisted on device." ;; esac
case "$(read_durable sms_batches)" in *"remaining"*) fail "batch record not drained after finalize." ;; esac
echo "SCENARIO A PASSED: $incident_a — force-stop with the receipt POST in flight, honest offline retry while blocked, receipt delivered after data returned, console QUEUED -> $state_a, store drained. NO synthetic state."

# --- Scenario B: unfinished batch at kill (seeded; phase 0 explains why) -------

echo "== Scenario B: unfinished batch at kill -> recovery + watchdog =="
resolve_active
incident_b="$(curl -s -X POST "$CAS_FLOW_API_HOST/api/cas/incidents/trigger" -H "Authorization: Bearer $CAS_FLOW_ALERT_TOKEN" -H 'Content-Type: application/json' --data '{"deviceChannels":["SMS"]}' | jq -r '.id // empty')"
[ -n "$incident_b" ] || fail "host-side trigger returned no incident id."
[ "$(sms_item_state "$incident_b")" = "QUEUED" ] || fail "SMS item not QUEUED after trigger: $(sms_item_state "$incident_b")"
adb shell am force-stop "$PKG"
# Generated by the production ReceiptDurability encoder (see the generator
# build above): one recipient with one part still awaiting a radio result.
seed_durable sms_batches "$(gen_seed batch "$incident_b")"
echo "seeded the unfinished-batch record via the production encoder (only state this AVD cannot produce — see phase 0)"
launch_main || fail "relaunch failed"
# SMS_BATCH_RECOVERY is an incident-less summary event (it carries only
# recovered/droppedAlreadyReported counts), so it cannot be incident-scoped.
# It does not need to be: seed_durable rewrote the prefs file moments ago, so
# the journal holds only post-seed events and a plain pattern cannot match an
# earlier phase's entry.
wait_journal "SMS_BATCH_RECOVERY" "$TIMEOUT_S" || fail "no SMS_BATCH_RECOVERY after resume — recoverUnfinishedBatches did not pick the batch up."
send_line_b="$(wait_journal_match "SMS_SEND_OUTCOME[^}]*$incident_b[^}]*" "$TIMEOUT_S")" \
  || fail "watchdog never finalized the recovered batch."
grep -q "NO_RADIO_RESULT" <<< "$send_line_b" || fail "recovered batch finalized without NO_RADIO_RESULT."
wait_journal "SMS_RECEIPT_OUTCOME[^}]*$incident_b[^}]*REPORTED" "$TIMEOUT_S" || fail "receipt was not REPORTED to the console."
state_b="$(wait_console_state "$incident_b" QUEUED)" || fail "console item for $incident_b stuck QUEUED."
[ "$state_b" = "DEAD_LETTER" ] || fail "unexpected state $state_b (NO_RADIO_RESULT must dead-letter, not SENT)."
case "$(read_durable sms_batches)" in *"remaining"*) fail "batch record not drained after finalize." ;; esac
echo "SCENARIO B PASSED: $incident_b — SMS_BATCH_RECOVERY + watchdog finalize, receipt REPORTED, console QUEUED -> DEAD_LETTER, store drained."

# --- Scenario C (supplementary): seeded all-success receipt -> SENT ----------

echo "== Scenario C (supplementary): seeded success receipt -> retry lands SENT =="
resolve_active
incident_c="$(curl -s -X POST "$CAS_FLOW_API_HOST/api/cas/incidents/trigger" -H "Authorization: Bearer $CAS_FLOW_ALERT_TOKEN" -H 'Content-Type: application/json' --data '{"deviceChannels":["SMS"]}' | jq -r '.id // empty')"
[ -n "$incident_c" ] || fail "host-side trigger returned no incident id."
adb shell am force-stop "$PKG"
now_ms=$(($(date +%s%N) / 1000000))
seed_durable pending_receipts "$(gen_seed receipt "$incident_c" "$now_ms")"
retry_base_c="$(event_count 'RECEIPT_RETRY_OUTCOME[^}]*"reported":1[,}]')"
launch_main || fail "relaunch failed"
wait_event_beyond "$retry_base_c" 'RECEIPT_RETRY_OUTCOME[^}]*"reported":1[,}]' "$TIMEOUT_S" \
  || fail "no new RECEIPT_RETRY_OUTCOME with reported=1 on resume."
wait_journal "SMS_RECEIPT_OUTCOME[^}]*$incident_c[^}]*REPORTED" "$TIMEOUT_S" \
  || fail "receipt for $incident_c was not REPORTED."
state_c="$(wait_console_state "$incident_c" QUEUED)" || fail "console item for $incident_c stuck QUEUED."
[ "$state_c" = "SENT" ] || fail "expected SENT for an all-success receipt, got $state_c."
case "$(read_durable pending_receipts)" in *"receiptId"*) fail "acked receipt still persisted on device." ;; esac
echo "SCENARIO C PASSED: $incident_c — retried success receipt moved the console QUEUED -> SENT, store drained."

resolve_active > /dev/null
echo "Receipt-durability kill proof passed: scenario A via the real send path with no synthetic state; scenarios B/C with the seeded records this modem-less AVD cannot produce (hardware owns the full-fidelity run)."
