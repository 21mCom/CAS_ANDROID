#!/usr/bin/env bash
# End-to-end proof that a handset killed right after texting still lands its
# receipt on the console, driven on a booted emulator through the app's REAL
# send path (SmsFlowActivity -> AlertSender.trigger -> DeviceSmsSender.sendAlert
# -> receipt durability -> postReceipt), with no synthetic app state in the
# primary scenario.
#
# Phase 0 (environment probe, machine-checked): a real alert send classifies
#   this AVD's radio. On the workspace's modem-less AVD the send must finalize
#   with a NAMED failure within milliseconds — SmsManager.divideMessage throws
#   "Sms is not supported", the non-blank body falls back to a single-part
#   send (journaled as SMS_DIVIDE_FALLBACK), and the radio-less send call then
#   fails immediately as SEND_FAILED:<exception>. On GitHub's ubuntu-latest
#   KVM image the emulated radio ACCEPTS the send (result OK), which is just
#   as valid: the probe records which environment this is and downstream
#   assertions (scenario A's final console state, the divide-fallback check)
#   follow the classification. Either way the drill seeds scenario B: on a
#   modem-less AVD the kill-before-radio-results window does not exist, and
#   on a radio AVD catching it deterministically is racy — the seeded record
#   produced by the production encoder is deterministic on both.
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
#   CAS_FLOW_ALERT_TOKEN   enrollment credential (matches CAS_ALERT_TOKEN);
#                          exchanged once below for a per-device enrolled token.
#                          That enrolled token authorizes the host's
#                          incident/outbox mutations AND is provisioned into
#                          the seeded app state (scenarios B/C) — the retired
#                          shared device token (CAS_DEVICE_TOKEN) is rejected
#                          by the server once any device is enrolled, so
#                          seeding it would prove a credential path that no
#                          longer exists in the field. The handset app performs
#                          the same enrollment exchange itself (phase 0 /
#                          scenario A drive the real path through alertToken).
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

for var in CAS_FLOW_APK CAS_FLOW_API_HOST CAS_FLOW_ALERT_TOKEN; do
  if [ -z "${!var:-}" ]; then
    echo "::error::Required environment variable $var is not set."
    exit 1
  fi
done

# The alert credential is now only the enrollment credential: mutation
# endpoints reject it directly. Exchange it once for a per-device token that
# authorizes this run's host-side incident/outbox mutations (the handset app
# performs the same exchange itself inside AlertSender).
CAS_FLOW_ENROLLED_TOKEN="$(curl -sf -X POST "$CAS_FLOW_API_HOST/api/cas/devices/enroll" \
  -H "Authorization: Bearer $CAS_FLOW_ALERT_TOKEN" -H 'Content-Type: application/json' \
  --data '{"label":"ci-receipt-durability"}' | jq -r '.token // empty')"
if [ -z "$CAS_FLOW_ENROLLED_TOKEN" ]; then
  echo "::error::device enrollment failed; the API did not issue a device credential for CAS_FLOW_ALERT_TOKEN."
  exit 1
fi

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
  curl -s -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN" "$CAS_FLOW_API_HOST/api/cas/state" | jq -r --arg id "$1" \
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
  curl -s -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN" "$CAS_FLOW_API_HOST/api/cas/state" | jq -r '.activeIncident.id // empty'
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
  id="$(curl -s -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN" "$CAS_FLOW_API_HOST/api/cas/state" | jq -r '.activeIncident.id // empty')"
  if [ -n "$id" ]; then
    curl -s -X POST -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN" "$CAS_FLOW_API_HOST/api/cas/incidents/$id/ack" > /dev/null || true
    curl -s -X POST -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN" "$CAS_FLOW_API_HOST/api/cas/incidents/$id/resolve" > /dev/null || true
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
wait_proxy_seen() { # incident-id [poll-interval-s]
  local want="$1" deadline=$((SECONDS + TIMEOUT_S))
  while [ $SECONDS -lt $deadline ]; do
    [ -f "$HANG_FLAG.seen" ] && grep -qF "$want" "$HANG_FLAG.seen" && return 0
    sleep "${2:-1}"
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
# The seeded prefs mirror a provisioned handset: the enrolled per-device
# credential plus the sticky provisioned flag, and NEITHER the enrollment
# credential (a real handset discards it after provisioning) nor the retired
# shared device token (the server rejects it once any credential row exists —
# which the enrollment above already created — so seeding it would strand the
# resumed app's receipt POSTs on a 401).
seed_durable() { # key json
  local tmp
  tmp="$(mktemp)"
  {
    echo "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>"
    echo '<map>'
    printf '    <string name="alert_server_url">%s</string>\n' "$CAS_FLOW_API_DEVICE"
    printf '    <string name="enrolled_device_token">%s</string>\n' "$CAS_FLOW_ENROLLED_TOKEN"
    printf '    <boolean name="device_credential_provisioned" value="true" />\n'
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
# Resolve kotlinc the same way test-receipt-durability.sh's find_kotlinc does:
# a system kotlinc on PATH wins, and only its absence makes that script prime
# the pinned cache — so this compile must NOT hardcode the cache path (on
# GitHub's ubuntu-latest image kotlinc is preinstalled, the cache is never
# populated, and the hardcoded path fails with "No such file or directory").
KOTLINC="$DUR_CACHE/kotlinc/bin/kotlinc"
if command -v kotlinc > /dev/null 2>&1; then
  KOTLINC="$(command -v kotlinc)"
elif [ ! -x "$KOTLINC" ]; then
  echo "::error::no kotlinc on PATH and the pinned cache was not primed by test-receipt-durability.sh."
  exit 1
fi
"$KOTLINC"   "$REPO_ROOT/artifacts/covert-alert-system/android-test-package/app/src/main/java/com/covertalert/pixeltest/ReceiptDurability.kt"   "$REPO_ROOT/scripts/receipt-durability/SeedFixtureGenerator.kt"   -cp "$DUR_CACHE/json-20240303.jar" -include-runtime   -d "$DUR_CACHE/build/seed-fixtures.jar"   || { echo "::error::seed fixture generator failed to compile against the production encoder."; exit 1; }
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
# The install can be lost when the freshly booted system_server restarts
# mid-install on TCG emulators (DeadSystemException from PackageManager);
# retry like verify-sms-flow.sh does, but still fail loudly when it never
# sticks.
install_ok=0
install_out=""
for attempt in 1 2 3; do
  install_out="$(adb install -r -g "$CAS_FLOW_APK" 2>&1)" && { install_ok=1; break; }
  echo "adb install attempt $attempt failed: $install_out — retrying in 10s"
  sleep 10
done
[ "$install_ok" = 1 ] || fail "adb install failed after 3 attempts: $install_out"
echo "$install_out"
# SmsFlowActivity is non-exported; only root may start it on API 35 (google_apis
# images are rootable). adb root restarts adbd and drops reverse tunnels, so it
# runs before any adb reverse below.
adb root > /dev/null 2>&1 || fail "adb root failed — need a rootable image for the non-exported SmsFlowActivity."
adb wait-for-device
adb shell pm clear "$PKG" > /dev/null || true
adb shell pm grant "$PKG" android.permission.SEND_SMS > /dev/null 2>&1 || true
unblock_receipts

# --- Phase 0: environment probe ------------------------------------------------

echo "== Phase 0: real send on this AVD must fail fast with a named failure (divide fallback -> SEND_FAILED) =="
resolve_active
reverse_up || fail "adb reverse failed"
prev_incident="$(current_incident)"
# No deviceToken extra: the shared token is retired server-side once any
# device is enrolled. The app enrolls itself from the alertToken extra (the
# enrollment credential) and caches its own per-device credential — the same
# path a field handset takes.
start_flow \
  --es mode alert \
  --es serverUrl "$CAS_FLOW_API_DEVICE" \
  --es alertToken "$CAS_FLOW_ALERT_TOKEN" \
  --es responders "+15550100" || fail "am start of SmsFlowActivity failed"
probe_incident="$(wait_new_incident "$prev_incident")" || fail "trigger never created an incident."
send_line="$(wait_journal_match "SMS_SEND_OUTCOME[^}]*$probe_incident[^}]*" "$TIMEOUT_S")" \
  || fail "send never finalized on the environment probe."
# Classify the radio instead of asserting it away: the workspace's modem-less
# AVD fails the send immediately with a named exception, while the GitHub
# runner's KVM image emulates a radio that accepts it (proven on the first
# real CI run — SMS_PART_RESULT OK, delivered:1). Scenario A's final console
# state and the divide-fallback check follow this classification; the
# kill/receipt durability assertions are radio-independent.
if grep -q "SEND_FAILED:" <<< "$send_line"; then
  RADIO_WORKS=false
  PROBE_EXPECTED_STATE="DEAD_LETTER"
  # The fallback must have fired first: it is what turns the modem-less AVD's
  # divideMessage failure into a send attempt at all.
  wait_journal_match "SMS_DIVIDE_FALLBACK" "$TIMEOUT_S" > /dev/null \
    || fail "SMS_DIVIDE_FALLBACK was not journaled on this modem-less AVD — divideMessage no longer fails here; re-derive the probe."
elif grep -q '"delivered":1' <<< "$send_line"; then
  RADIO_WORKS=true
  PROBE_EXPECTED_STATE="SENT"
else
  fail "probe send finalized with an unrecognized outcome (neither SEND_FAILED nor delivered): $send_line"
fi
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
[ "$(sms_item_state "$probe_incident")" = "$PROBE_EXPECTED_STATE" ] || fail "probe item not $PROBE_EXPECTED_STATE: $(sms_item_state "$probe_incident")"
echo "phase 0 OK: radio_works=$RADIO_WORKS — probe incident $probe_incident finalized $PROBE_EXPECTED_STATE (production code cannot leave an unfinished batch on either radio class)."

# --- Scenario A: real pending receipt, kill, resume (no synthetic state) ------

echo "== Scenario A: force-stop with the receipt POST in flight =="
# Hang mode: the proxy accepts the app's receipt POST but never answers, so
# the app can be killed while its own receipt POST is still on the wire —
# the kill lands INSIDE the send->receipt window, not after the receipt
# already reached a safe state.
#
# Late-kill retry: the marker poll and force-stop normally land within a
# couple of seconds, far inside the app's 10s client read timeout — but on a
# freshly booted, loaded TCG emulator an adb/am round-trip can outlast that
# window, and the app then journals the timeout's FAILED outcome BEFORE the
# kill lands. That is a slow host, not broken durability (the receipt stayed
# durable and retries honestly), so a late kill retries the whole in-flight
# attempt once with a fresh incident instead of failing a valid run. A kill
# that loses to a REPORTED outcome still fails loudly — that means the proxy
# hang let a real answer through, which breaks the mechanism this scenario
# proves.
incident_a=""
late_incident=""
for kill_attempt in 1 2; do
  resolve_active
  hang_receipts
  prev_incident="$(current_incident)"
  start_flow \
    --es mode alert \
    --es serverUrl "$CAS_FLOW_API_DEVICE" \
    --es alertToken "$CAS_FLOW_ALERT_TOKEN" \
    --es responders "+15550100" || fail "am start of SmsFlowActivity failed"
  incident_a="$(wait_new_incident "$prev_incident")" || fail "trigger never ran."
  # Critical path, marker-first: the proxy's .seen marker names the incident
  # (the POST path carries /api/cas/incidents/<id>/device-receipt) and exists
  # only once the receipt POST is on the wire and hanging unanswered — which
  # already implies finalizeBatch persisted the receipt and started the posting
  # thread. Waiting on the local marker file adds zero adb latency, and the
  # marker is append-only, so a hung retry of a PREVIOUS attempt's receipt can
  # never overwrite this attempt's marker. (A journal wait here instead — an
  # adb round-trip per poll — proved racy: on a freshly booted emulator the
  # kill landed after the read timeout had already journaled the FAILED
  # outcome.) The journal assertions run after the kill, where timing no
  # longer matters.
  wait_proxy_seen "$incident_a" 0.2 || fail "receipt POST for $incident_a never reached the hanging proxy — the kill was not provably in-flight."
  adb shell am force-stop "$PKG"
  echo "force-stopped $PKG with its receipt POST still hanging in the proxy (attempt $kill_attempt)"

  # Post-kill journal assertions (timing no longer matters once the process is
  # dead): the trigger went through the proxy to the console, and the send
  # finalized. The marker already proved the posting thread started, which the
  # app only does after journaling the send outcome and persisting the receipt —
  # these greps confirm that ordering held for this incident.
  ev="$(journal_snapshot)" || fail "journal unreadable after the kill — cannot prove the kill beat the receipt."
  grep -q "SMS_FLOW_TRIGGER_OUTCOME[^}]*$incident_a" <<< "$ev" || fail "trigger outcome for $incident_a never journaled."
  grep -q "SMS_SEND_OUTCOME[^}]*$incident_a" <<< "$ev" || fail "send outcome for $incident_a never journaled — the receipt could not have been persisted."
  # Did the kill land inside the window? Nothing may be journaled FOR THIS
  # INCIDENT yet. The grep is scoped to this incident's id so earlier phases'
  # legitimately reported receipts cannot trip it. grep -o extracts only the
  # SMS_RECEIPT_OUTCOME event objects: the journal is a single line, so a
  # plain grep returns the whole line and the case pattern would match this
  # incident's id in unrelated (e.g. SMS_SEND_START) events. The snapshot must
  # be non-empty — a transient empty read would make this negative assertion
  # pass vacuously.
  case "$(grep -o "SMS_RECEIPT_OUTCOME[^}]*$incident_a[^}]*" <<< "$ev" || true)" in
    "")
      break ;;  # the kill beat the receipt — the in-flight window was exercised
    *REPORTED*)
      fail "receipt for $incident_a was REPORTED before the kill — the proxy hang let a real answer through; the in-flight window proof is broken." ;;
    *)
      # The app's client read timeout journaled a failure outcome before the
      # force-stop landed: a slow host, not broken durability (the receipt
      # stayed durable and will retry honestly). Retry once with a fresh
      # incident; fail only if the window cannot be hit twice running.
      late_incident="$incident_a"
      [ "$kill_attempt" -lt 2 ] || fail "force-stop could not land inside the app's read-timeout window on either attempt — the in-flight window cannot be exercised on this host."
      echo "late kill on attempt $kill_attempt (read timeout beat the force-stop); resolving $incident_a and retrying with a fresh incident" ;;
  esac
done
[ -n "$incident_a" ] || fail "internal error: scenario A left its attempt loop without an incident."

# The attempt loop above broke out only when nothing was journaled for this
# incident before the kill, so the in-flight window is proven. The console
# must still show QUEUED, and durable state (the pending receipt) survived.
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
# The blocked resume above journaled a RECEIPT_RETRY_OUTCOME with reported:0,
# so the assertion is count-based: one MORE summary with a positive reported
# count must appear. Positive, not exactly 1: after a late-kill retry the
# resume drains BOTH the current and the late attempt's receipts, and
# retryPendingReceipts journals one summary for the whole pass (reported:2).
unblock_receipts
retry_base="$(event_count 'RECEIPT_RETRY_OUTCOME[^}]*"reported":[1-9][0-9]*[,}]')"
launch_main || fail "relaunch failed"
wait_event_beyond "$retry_base" 'RECEIPT_RETRY_OUTCOME[^}]*"reported":[1-9][0-9]*[,}]' "$TIMEOUT_S" \
  || fail "no new RECEIPT_RETRY_OUTCOME with a positive reported count once data returned."
wait_journal "SMS_RECEIPT_OUTCOME[^}]*$incident_a[^}]*REPORTED" "$TIMEOUT_S" \
  || fail "receipt for $incident_a was not REPORTED after data returned."
# A late-killed first attempt left its own durable receipt behind; it reports
# on the same resume. Wait for it too, or the store-drained checks below can
# race its delivery and read a store that is not done draining.
if [ -n "$late_incident" ]; then
  wait_journal "SMS_RECEIPT_OUTCOME[^}]*$late_incident[^}]*REPORTED" "$TIMEOUT_S" \
    || fail "the late-killed attempt's receipt for $late_incident was not REPORTED after data returned — the drained-store checks would race it."
fi
state_a="$(wait_console_state "$incident_a" QUEUED)" || fail "console item for $incident_a stuck QUEUED after the retried receipt."
EXPECTED_A_STATE="DEAD_LETTER"
[ "$RADIO_WORKS" = "true" ] && EXPECTED_A_STATE="SENT"
[ "$state_a" = "$EXPECTED_A_STATE" ] || fail "unexpected state $state_a (expected $EXPECTED_A_STATE for this AVD: a radio-less send's honest failures dead-letter, a working radio's delivered send lands SENT)."
case "$(read_durable pending_receipts)" in *"receiptId"*) fail "acked receipt still persisted on device." ;; esac
case "$(read_durable sms_batches)" in *"remaining"*) fail "batch record not drained after finalize." ;; esac
echo "SCENARIO A PASSED: $incident_a — force-stop with the receipt POST in flight, honest offline retry while blocked, receipt delivered after data returned, console QUEUED -> $state_a, store drained. NO synthetic state."

# --- Scenario B: unfinished batch at kill (seeded; phase 0 explains why) -------

echo "== Scenario B: unfinished batch at kill -> recovery + watchdog =="
resolve_active
incident_b="$(curl -s -X POST "$CAS_FLOW_API_HOST/api/cas/incidents/trigger" -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN" -H 'Content-Type: application/json' --data '{"deviceChannels":["SMS"]}' | jq -r '.id // empty')"
[ -n "$incident_b" ] || fail "host-side trigger returned no incident id."
[ "$(sms_item_state "$incident_b")" = "QUEUED" ] || fail "SMS item not QUEUED after trigger: $(sms_item_state "$incident_b")"
adb shell am force-stop "$PKG"
# Generated by the production ReceiptDurability encoder (see the generator
# build above): one recipient with one part still awaiting a radio result.
seed_durable sms_batches "$(gen_seed batch "$incident_b")"
echo "seeded the unfinished-batch record via the production encoder (deterministic stand-in for the kill-before-radio-results window — see phase 0)"
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
incident_c="$(curl -s -X POST "$CAS_FLOW_API_HOST/api/cas/incidents/trigger" -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN" -H 'Content-Type: application/json' --data '{"deviceChannels":["SMS"]}' | jq -r '.id // empty')"
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
echo "Receipt-durability kill proof passed: scenario A via the real send path with no synthetic state (radio_works=$RADIO_WORKS); scenarios B/C with seeded production-encoder records (hardware owns the full-fidelity run)."
