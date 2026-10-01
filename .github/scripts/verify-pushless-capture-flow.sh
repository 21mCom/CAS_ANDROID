#!/usr/bin/env bash
# End-to-end proof that the DEFAULT field kit build — no google-services.json,
# so no Firebase configuration — stays fully functional on a booted Android
# emulator:
#
#   1. Contract preflight: the capture-request endpoints must enforce their
#      documented auth and body shapes BEFORE the emulator is involved, so
#      contract drift fails fast and loudly.
#   2. Push-less launch: install the APK (built from a checkout with no
#      google-services.json), launch MainActivity, and assert the process
#      survives with no FATAL EXCEPTION and the on-device journal records
#      PUSH_UNAVAILABLE — an unguarded Firebase call would crash every field
#      kit at launch, and today only manual emulator runs would catch it.
#   3. Polling pickup: create an incident and a responder capture request via
#      the API (the CI server has no Firebase service account either, so it
#      journals CAPTURE_PUSH_UNAVAILABLE), foreground the app so its on-resume
#      polling runs, and assert the request is acked via the polling path
#      (state STARTED, event detail names the polling path, device journal
#      records CAPTURE_REQUEST_RECEIVED + CAPTURE_REQUEST_ACK).
#   4. Camera label: set the capture policy camera to "front", request a
#      responder photo, and prove the front label survives the whole path —
#      on-device capture journal, upload header, stored evidence row, and the
#      /cas/state payload the console's evidence panel reads. A regression
#      that drops the label anywhere on that path turns this job red.
#
# Required env (same pattern as verify-sms-flow.sh):
#   CAS_FLOW_APK           path to the built app-debug.apk
#   CAS_FLOW_API_HOST      API base URL from the host, e.g. http://127.0.0.1:5055
#   CAS_FLOW_DEVICE_TOKEN  shared handset credential (matches CAS_DEVICE_TOKEN)
#   CAS_FLOW_ALERT_TOKEN   enrollment credential (matches CAS_ALERT_TOKEN); the
#                          script exchanges it once for a per-device token below
# Optional env:
#   CAS_FLOW_API_DEVICE    API base URL as the device sees it (default: adb
#                          reverse tunnel, http://127.0.0.1:<port>)
#   CAS_FLOW_TIMEOUT_S     per-phase wait budget (default: 180)
set -euo pipefail

PKG="com.covertalert.pixeltest"
JOURNAL="/data/user_de/0/$PKG/shared_prefs/gate0a-local-journal.xml"
TIMEOUT_S="${CAS_FLOW_TIMEOUT_S:-180}"

for var in CAS_FLOW_APK CAS_FLOW_API_HOST CAS_FLOW_DEVICE_TOKEN CAS_FLOW_ALERT_TOKEN; do
  if [ -z "${!var:-}" ]; then
    echo "::error::Required environment variable $var is not set."
    exit 1
  fi
done

# Exchange the enrollment credential once for this run's per-device credential;
# mutation endpoints reject the enrollment credential directly.
CAS_FLOW_ENROLLED_TOKEN="$(curl -sf -X POST "$CAS_FLOW_API_HOST/api/cas/devices/enroll" \
  -H "Authorization: Bearer $CAS_FLOW_ALERT_TOKEN" -H 'Content-Type: application/json' \
  --data '{"label":"ci-pushless-capture-flow"}' | jq -r '.token // empty')"
if [ -z "$CAS_FLOW_ENROLLED_TOKEN" ]; then
  echo "::error::device enrollment failed; the API did not issue a device credential for CAS_FLOW_ALERT_TOKEN."
  exit 1
fi

# APK preflight lives here (not in the workflow's `script:` block): the
# emulator action runs that block via /usr/bin/sh, which is dash on
# ubuntu-latest and cannot do multi-line strict-mode safely.
if [ ! -f "$CAS_FLOW_APK" ]; then
  echo "::error::Downloaded APK missing at $CAS_FLOW_APK"
  exit 1
fi

# Tunnel the host's API port into the device over adb (USB/emulator agnostic).
API_PORT_FROM_URL="${CAS_FLOW_API_HOST##*:}"
API_PORT_FROM_URL="${API_PORT_FROM_URL%%/*}"
case "$API_PORT_FROM_URL" in
  ''|*[!0-9]*) echo "::error::cannot parse a numeric port from CAS_FLOW_API_HOST=$CAS_FLOW_API_HOST"; exit 1 ;;
esac
CAS_FLOW_API_DEVICE="${CAS_FLOW_API_DEVICE:-http://127.0.0.1:$API_PORT_FROM_URL}"

# The journal is a SharedPreferences XML that also stores the enrolled device
# credential — never print it raw. Extract only the events element.
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
  # Grep the fatal block explicitly: a plain tail can scroll past the crash
  # on a slow or noisy emulator.
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
  local args=(-s -o /tmp/pushless-flow-response.json -w '%{http_code}' -X "$method")
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
    echo "Response body: $(cat /tmp/pushless-flow-response.json 2>/dev/null | head -c 500)"
    fail "$1: expected HTTP $2, got $3 — the capture-request contract drifted."
  fi
  echo "contract OK: $1 (HTTP $3)"
}

assert_no_fatal_crash() { # phase label
  if adb logcat -d | grep -A2 'FATAL EXCEPTION' | grep -q "Process: $PKG"; then
    fail "fatal crash for $PKG found in logcat during $1."
  fi
}

# --- Step 0: contract preflight (no emulator involvement) -------------------

echo "== Contract preflight against $CAS_FLOW_API_HOST =="

status="$(http_status GET "$CAS_FLOW_API_HOST/api/cas/capture-requests/pending")"
expect_status "capture-requests/pending refuses a missing credential" 401 "$status"

status="$(http_status GET "$CAS_FLOW_API_HOST/api/cas/capture-requests/pending" "" "$CAS_FLOW_DEVICE_TOKEN")"
expect_status "capture-requests/pending refuses the retired shared device token" 401 "$status"

status="$(http_status GET "$CAS_FLOW_API_HOST/api/cas/capture-requests/pending" "" "" "$CAS_FLOW_ENROLLED_TOKEN")"
expect_status "capture-requests/pending accepts the enrolled device credential" 200 "$status"
if ! jq -e '.items | type == "array"' /tmp/pushless-flow-response.json > /dev/null; then
  fail "capture-requests/pending 200 response has no items array — the pickup contract drifted: $(cat /tmp/pushless-flow-response.json | head -c 300)"
fi
echo "contract OK: capture-requests/pending returns an items array"

status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/incidents/flow-contract-probe/capture-requests" '{"kind":"seismograph"}' "" "$CAS_FLOW_ENROLLED_TOKEN")"
expect_status "capture-request creation rejects an unknown kind" 400 "$status"

status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/incidents/flow-contract-probe/capture-requests" '{"kind":"audio"}')"
expect_status "capture-request creation refuses a missing credential" 401 "$status"

# Schema-valid body (camera included), so the 401 is purely about the
# missing credential, never about payload validation.
status="$(http_status PUT "$CAS_FLOW_API_HOST/api/cas/evidence-policy" '{"audio":"responder","photo":"off","video":"off","timing":"immediate","camera":"back"}')"
expect_status "evidence-policy change refuses a missing credential" 401 "$status"

# --- Step 1: install, grant mic, seed a provisioned-handset profile ----------

echo "== Installing the push-less APK =="
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
  # -g grants the manifest's runtime permissions (RECORD_AUDIO included), so
  # the audio capture below can actually start instead of failing on a
  # permission the field operator would have granted during onboarding.
  install_out="$(adb install -r -g "$CAS_FLOW_APK" 2>&1)" && { install_ok=1; break; }
  echo "adb install attempt $attempt failed: $install_out — retrying in 10s"
  sleep 10
done
[ "$install_ok" = 1 ] || fail "adb install failed after 3 attempts: $install_out"
echo "$install_out"
# The grant can be lost when the freshly booted system_server restarts
# mid-install (observed as DeadSystemException on TCG emulators); retry like
# the install step, but still fail loudly when it never sticks.
grant_ok=0
for attempt in 1 2 3; do
  adb shell pm grant "$PKG" android.permission.RECORD_AUDIO > /dev/null 2>&1 || true
  if adb shell dumpsys package "$PKG" 2>/dev/null | grep -q 'android.permission.RECORD_AUDIO: granted=true'; then
    grant_ok=1
    break
  fi
  echo "RECORD_AUDIO grant attempt $attempt did not stick (system may be restarting) — retrying in 10s"
  sleep 10
done
[ "$grant_ok" = 1 ] || fail "RECORD_AUDIO is not granted after 3 pm grant attempts — the capture-request pickup cannot start audio capture."

# Seed the profile a real provisioned handset carries — enrolled per-device
# credential plus the sticky provisioned flag, and NEITHER the enrollment
# credential nor the retired shared device token — via run-as while the app
# is force-stopped (app uid, correct SELinux context). This mirrors
# verify-receipt-durability-kill.sh's seed_durable.
adb shell am force-stop "$PKG" || true
seed_tmp="$(mktemp)"
{
  echo "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>"
  echo '<map>'
  printf '    <string name="alert_server_url">%s</string>\n' "$CAS_FLOW_API_DEVICE"
  printf '    <string name="enrolled_device_token">%s</string>\n' "$CAS_FLOW_ENROLLED_TOKEN"
  printf '    <boolean name="device_credential_provisioned" value="true" />\n'
  echo '</map>'
} > "$seed_tmp"
adb shell "run-as $PKG sh -c 'mkdir -p /data/user_de/0/$PKG/shared_prefs && cat > $JOURNAL'" < "$seed_tmp" \
  || fail "run-as seeding of the provisioned-handset profile failed (is this a debuggable build?)."
rm -f "$seed_tmp"

# Elevate before `adb reverse` (adb root restarts adbd, which drops any
# reverse tunnels) and before reading the device-protected journal later.
adb root > /dev/null 2>&1 \
  || fail "adb root failed — the harness needs a rootable image (google_apis emulator) to read the device journal."
adb wait-for-device

adb reverse "tcp:$API_PORT_FROM_URL" "tcp:$API_PORT_FROM_URL" \
  || fail "adb reverse failed — the device cannot reach the dev API."
reversed="$(adb reverse --list 2>/dev/null || true)"
echo "$reversed" | grep -q "tcp:$API_PORT_FROM_URL" \
  || fail "adb reverse --list does not show tcp:$API_PORT_FROM_URL — tunnel missing: $reversed"
echo "adb reverse tunnel up: device 127.0.0.1:$API_PORT_FROM_URL -> host $CAS_FLOW_API_HOST"

# --- Step 2: push-less launch — no crash, PUSH_UNAVAILABLE journaled ---------

echo "== Push-less launch phase =="
adb logcat -c || true
# Package scanning lags behind install on a freshly booted emulator; retry
# the specific "component not registered yet" failure, fail on anything else.
launch_out=""
launch_ok=0
for attempt in 1 2 3 4 5 6; do
  launch_out="$(adb shell am start -W -n "$PKG/.MainActivity" 2>&1)" && { launch_ok=1; break; }
  echo "$launch_out"
  case "$launch_out" in
    *"does not exist"*)
      echo "component not registered yet (attempt $attempt) — waiting for package scan"
      sleep 15 ;;
    *) fail "am start of MainActivity failed: $launch_out" ;;
  esac
done
[ "$launch_ok" = 1 ] || fail "MainActivity never became startable after install."
# am start exits 0 even when the app dies in onCreate seconds later; process
# liveness plus the logcat grep are the real crash detectors.
sleep 10
pid="$(adb shell pidof "$PKG" || true)"
[ -n "$pid" ] || fail "App process is not running 10s after launch — the push-less build crashed on launch."
assert_no_fatal_crash "the push-less MainActivity launch"
echo "Push-less launch passed: process alive (pid $pid), no fatal logcat entries."

deadline=$((SECONDS + TIMEOUT_S))
push_unavailable=""
while [ $SECONDS -lt $deadline ]; do
  if read_journal_events | grep -q 'PUSH_UNAVAILABLE'; then push_unavailable=1; break; fi
  sleep 3
done
[ -n "$push_unavailable" ] || fail "no PUSH_UNAVAILABLE in the device journal within ${TIMEOUT_S}s of launch — the guarded Firebase call did not journal its unavailability (or the app never reached the pickup flow)."
echo "Device journal records PUSH_UNAVAILABLE — the push-less build took the guarded path."

# --- Step 3: server-side incident + capture request, polling pickup ----------

echo "== Polling pickup phase =="
# The capture policy defaults every kind to "off"; enable responder-requested
# audio capture so the request below is legal. The schema requires the camera
# selection too; audio capture ignores it, so it stays "back" here.
status="$(http_status PUT "$CAS_FLOW_API_HOST/api/cas/evidence-policy" '{"audio":"responder","photo":"off","video":"off","timing":"immediate","camera":"back"}' "" "$CAS_FLOW_ENROLLED_TOKEN")"
expect_status "evidence-policy enables responder-requested audio capture" 200 "$status"

# An incident with no queued channels: the capture request is the payload
# under test, not the alert fan-out.
status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/incidents/trigger" '{"deviceChannels":[]}' "" "$CAS_FLOW_ENROLLED_TOKEN")"
if [ "$status" != "200" ] && [ "$status" != "201" ]; then
  echo "Response body: $(cat /tmp/pushless-flow-response.json 2>/dev/null | head -c 500)"
  fail "incident trigger: expected HTTP 200/201, got $status."
fi
incident_id="$(curl -s "$CAS_FLOW_API_HOST/api/cas/state" -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN" | jq -r '.activeIncident.id // empty')"
[ -n "$incident_id" ] || fail "no active incident after trigger — the incident was not created."
echo "Incident created: $incident_id (no outbox channels queued)."

status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/incidents/$incident_id/capture-requests" '{"kind":"audio"}' "" "$CAS_FLOW_ENROLLED_TOKEN")"
expect_status "responder audio capture request" 201 "$status"
request_id="$(jq -r '.id // empty' /tmp/pushless-flow-response.json)"
[ -n "$request_id" ] || fail "capture-request response carried no id: $(cat /tmp/pushless-flow-response.json | head -c 300)"
echo "Capture request created: $request_id"

# The CI server has no Firebase service account, so it must journal the
# push-less wake posture for this request instead of claiming a push went out.
state_json="$(curl -s "$CAS_FLOW_API_HOST/api/cas/state" -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN")"
echo "$state_json" | jq -e '.activeIncident.events | map(select(.type == "CAPTURE_PUSH_UNAVAILABLE")) | length > 0' > /dev/null \
  || fail "server did not journal CAPTURE_PUSH_UNAVAILABLE for the request — the push-less server posture was not recorded: $(echo "$state_json" | jq -c '.activeIncident.events | map(.type)')"
echo "Server journaled CAPTURE_PUSH_UNAVAILABLE (no Firebase service account configured)."

# Foreground the app again: onResume runs the polling pickup
# (CaptureRequests.checkPending, via="poll") against the seeded server.
adb shell am start -W -n "$PKG/.MainActivity" > /dev/null 2>&1 \
  || fail "am start of MainActivity for the polling pass failed."

deadline=$((SECONDS + TIMEOUT_S))
acked=""
while [ $SECONDS -lt $deadline ]; do
  state_json="$(curl -s "$CAS_FLOW_API_HOST/api/cas/state" -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN")"
  req_state="$(echo "$state_json" | jq -r --arg id "$request_id" '.activeIncident.captureRequests | map(select(.id == $id)) | .[0].state // ""')"
  case "$req_state" in
    STARTED) acked=1; break ;;
    FAILED)
      detail="$(echo "$state_json" | jq -r --arg id "$request_id" '.activeIncident.captureRequests | map(select(.id == $id)) | .[0].detail // ""')"
      fail "capture request $request_id was acked FAILED on the emulator (detail: $detail) — the foreground mic/camera start should succeed with RECORD_AUDIO granted." ;;
  esac
  sleep 3
done
[ -n "$acked" ] || fail "capture request $request_id never left PENDING within ${TIMEOUT_S}s — the polling pickup path is broken (state: ${req_state:-missing})."
echo "Capture request acked STARTED via the handset's polling pass."

# The wake-path record lives in the incident journal, not the capture-request
# payload; the acked request must name the polling path explicitly.
state_json="$(curl -s "$CAS_FLOW_API_HOST/api/cas/state" -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN")"
echo "$state_json" | jq -e '
  .activeIncident.events
  | map(select(.type == "CAPTURE_STARTED" and (.detail | contains("polling path"))))
  | length > 0' > /dev/null \
  || fail "no CAPTURE_STARTED event naming the polling path — the wake-path record drifted: $(echo "$state_json" | jq -c '.activeIncident.events | map(.type)')"
echo "Incident journal records the capture was picked up on the polling path."

# --- Step 4: front-camera label reaches the console --------------------------

echo "== Camera-label phase: policy camera=front -> front photo -> console =="
# Point the capture policy's camera selection at the FRONT lens (the
# emulator's virtual camera exposes both front and back) and switch
# responder-requested capture from audio to photo, so the request below is
# legal and carries a lens.
status="$(http_status PUT "$CAS_FLOW_API_HOST/api/cas/evidence-policy" '{"audio":"off","photo":"responder","video":"off","timing":"immediate","camera":"front"}' "" "$CAS_FLOW_ENROLLED_TOKEN")"
expect_status "evidence-policy enables responder-requested front-camera photo capture" 200 "$status"
jq -e '.camera == "front"' /tmp/pushless-flow-response.json > /dev/null \
  || fail "evidence-policy PUT did not echo camera=front: $(cat /tmp/pushless-flow-response.json | head -c 300)"
echo "Capture policy now selects the front camera for photo/video."

status="$(http_status POST "$CAS_FLOW_API_HOST/api/cas/incidents/$incident_id/capture-requests" '{"kind":"photo"}' "" "$CAS_FLOW_ENROLLED_TOKEN")"
expect_status "responder photo capture request" 201 "$status"
photo_request_id="$(jq -r '.id // empty' /tmp/pushless-flow-response.json)"
[ -n "$photo_request_id" ] || fail "photo capture-request response carried no id: $(cat /tmp/pushless-flow-response.json | head -c 300)"
echo "Photo capture request created: $photo_request_id"

# The pickup path reads the camera selection from the handset's ON-DEVICE
# policy cache (CapturePolicy.cached), which a field handset refreshes from
# the server. Seed that cache with the policy the server now serves — same
# run-as seeding pattern as the provisioned-handset profile above — so the
# pickup passes camera=front to the capture service. The events element is
# preserved so the final journal check still sees this run's full history,
# and the app is force-stopped first because a running app's in-memory
# SharedPreferences would ignore (and later clobber) the rewritten file.
front_policy_json='{"audio":"off","photo":"responder","video":"off","timing":"immediate","camera":"front"}'
adb shell am force-stop "$PKG" || true
preserved_events="$(adb shell cat "$JOURNAL" 2>/dev/null | grep -o '<string name="events">.*</string>' || true)"
seed_tmp="$(mktemp)"
{
  echo "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>"
  echo '<map>'
  printf '    <string name="alert_server_url">%s</string>\n' "$CAS_FLOW_API_DEVICE"
  printf '    <string name="enrolled_device_token">%s</string>\n' "$CAS_FLOW_ENROLLED_TOKEN"
  printf '    <boolean name="device_credential_provisioned" value="true" />\n'
  # Android's SharedPreferences writer escapes quotes as &quot;; mirror that
  # so the seeded cache reads back exactly like a fetch-cached policy.
  printf '    <string name="capture_policy_json">%s</string>\n' "$(printf '%s' "$front_policy_json" | sed 's/"/\&quot;/g')"
  [ -n "$preserved_events" ] && printf '    %s\n' "$preserved_events"
  echo '</map>'
} > "$seed_tmp"
adb shell "run-as $PKG sh -c 'cat > $JOURNAL'" < "$seed_tmp" \
  || fail "run-as seeding of the front-camera policy cache failed (is this a debuggable build?)."
rm -f "$seed_tmp"

# Relaunch: onResume runs the polling pickup, which now reads camera=front
# from the seeded cache and starts the capture service with that selection.
adb shell am start -W -n "$PKG/.MainActivity" > /dev/null 2>&1 \
  || fail "am start of MainActivity for the front-camera pickup failed."

# Poll for the uploaded clip. The capture service's single worker may still
# be draining the earlier audio request's segments, so this budget exceeds
# the per-phase default; the env override keeps any no-emulator harness fast.
CAMERA_TIMEOUT_S="${CAS_FLOW_CAMERA_TIMEOUT_S:-300}"
deadline=$((SECONDS + CAMERA_TIMEOUT_S))
photo_evidence_id=""
state_json=""
while [ $SECONDS -lt $deadline ]; do
  state_json="$(curl -s "$CAS_FLOW_API_HOST/api/cas/state" -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN")"
  photo_evidence_id="$(echo "$state_json" | jq -r --arg rid "$photo_request_id" '.activeIncident.evidence | map(select(.requestId == $rid and .kind == "photo")) | .[0].id // ""')"
  if [ -n "$photo_evidence_id" ]; then
    # The upload is atomic, so once the row exists its label is final: a
    # missing or wrong label here is a regression, not a reason to wait.
    camera_label="$(echo "$state_json" | jq -r --arg id "$photo_evidence_id" '.activeIncident.evidence | map(select(.id == $id)) | .[0].camera // "null"')"
    [ "$camera_label" = "front" ] || fail "the photo clip uploaded WITHOUT its front-camera label (/cas/state camera=$camera_label) — the label was dropped between handset and console: $(echo "$state_json" | jq -c '.activeIncident.evidence')"
    break
  fi
  sleep 3
done
[ -n "$photo_evidence_id" ] || fail "no photo evidence for request $photo_request_id within ${CAMERA_TIMEOUT_S}s — the front-camera clip never reached the server: $(echo "$state_json" | jq -c '.activeIncident.evidence // "no-evidence-array"')"
echo "Front-camera photo clip reached the server: $photo_evidence_id, /cas/state carries camera=front (the console evidence panel's source)."

# The upload is the request's completion transition: the photo request must
# now read COMPLETED, proving the labeled upload also satisfied the request.
req_state="$(echo "$state_json" | jq -r --arg id "$photo_request_id" '.activeIncident.captureRequests | map(select(.id == $id)) | .[0].state // ""')"
[ "$req_state" = "COMPLETED" ] || fail "photo capture request $photo_request_id reads '$req_state' after its clip uploaded (expected COMPLETED) — the upload no longer completes the request it answers."
echo "Photo capture request reads COMPLETED after the labeled upload."

# The stored row's label also drives the console's download filename; assert
# that projection too instead of trusting the state payload alone.
disposition="$(curl -s -D - -o /dev/null "$CAS_FLOW_API_HOST/api/cas/evidence/$photo_evidence_id/download" -H "Authorization: Bearer $CAS_FLOW_ENROLLED_TOKEN" | grep -i '^content-disposition:' || true)"
echo "$disposition" | grep -q -- '-photo-front-' \
  || fail "evidence download filename lacks the front-camera label (Content-Disposition: ${disposition:-missing}) — the stored cas_evidence.camera column drifted."
echo "Download endpoint names the clip with its front-camera label: $disposition"

# Handset leg: the device journal must show the FRONT lens captured the
# photo. Together with the server assertions this pins a red to the right
# side of the path: handset labeling vs server storage vs console payload.
adb root > /dev/null 2>&1 || true
adb wait-for-device
journal="$(read_journal_events | sed 's/&quot;/"/g' || true)"
[ -n "$journal" ] || fail "could not read the on-device journal events at $JOURNAL for the camera-label check."
photo_event="$(printf '%s' "$journal" | grep -o '{"type":"EVIDENCE_CAPTURE"[^{}]*"kind":"photo"[^{}]*}' | head -1 || true)"
printf '%s' "$photo_event" | grep -q '"outcome":"CAPTURED"' \
  || fail "no CAPTURED photo event in the device journal — the emulator's front-camera still was not captured: $photo_event"
printf '%s' "$photo_event" | grep -q '"camera":"front"' \
  || fail "the on-device photo capture was NOT labeled front — the policy camera selection did not reach the capture service: $photo_event"
echo "Device journal records the photo captured from the front lens."

# --- Step 5: on-device evidence + final crash check --------------------------

echo "== Evidence phase: on-device journal and crash check =="
adb root > /dev/null 2>&1 || true
adb wait-for-device
journal="$(read_journal_events || true)"
[ -n "$journal" ] || fail "could not read the on-device journal events at $JOURNAL (adb root unavailable?)."
echo "$journal" | grep -q 'CAPTURE_REQUEST_RECEIVED' || fail "no CAPTURE_REQUEST_RECEIVED in the device journal — the handset never picked the request up."
echo "$journal" | grep -q 'CAPTURE_REQUEST_ACK' || fail "no CAPTURE_REQUEST_ACK in the device journal — the handset never acked the request."

sleep 5
pid="$(adb shell pidof "$PKG" || true)"
[ -n "$pid" ] || fail "App process died after the capture-request pickup (was pid $pid)."
assert_no_fatal_crash "the push-less capture flow"

echo "Push-less field kit proof passed: launched with no Firebase configuration (no crash, PUSH_UNAVAILABLE journaled), server journaled CAPTURE_PUSH_UNAVAILABLE, the responder audio request was acked STARTED via the polling path, and the front-camera photo clip kept its camera label from the handset through the stored row to the console's /cas/state payload and download filename."
