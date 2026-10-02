# CAS — Handoff Test Kit (Windows operator)

For the agentic operator on the Windows workstation with the Pixel 11 attached.
Run the whole matrix in one session and report back with the template at the
bottom. API-side drills use `scripts\cas-api-drills.ps1` so the phone is only
needed for the one path that genuinely requires it (real SMS over the SIM).

**No-screen-flash rule:** no alert path on the device may open another app's
UI — if an attacker is holding the phone, anything that flashes on screen
escalates the situation. The handset only ever sends SMS and POSTs receipts;
every other channel (WhatsApp included) fans out server-side through the
outbox worker. A static CI check (`check-silent-alert-channels.sh`) fails the
build if any alert path regains the ability to surface a third-party UI.
The same rule covers evidence capture (T10): clips are recorded by a
preview-free foreground service, never by launching the camera app, so the
only on-screen trace is the OS recording indicator.

**OS indicator reality (owner-accepted):** stock Android always shows the
green mic/camera indicator while recording. It cannot be hidden and this
build makes no attempt to. Capture never opens app UI; the indicator and the
low-key capture notification are the only traces. The screen does **not**
need to stay on — capture runs fine with the screen off in a pocket.

**Background-start constraint (measured, not assumed):** newer Android may
refuse to *start* mic/camera capture while the app sits idle in the
background. Capture started at trigger time (the app is in the foreground
when the alert fires) always works. Responder-requested capture is picked up
when the handset next contacts the server (trigger, resume, or "Check
re-queued deliveries"); if Android blocks the start, the handset reports the
exact exception to the incident journal (`CAPTURE_FAILED`) so the constraint
is documented from real runs.

Vocabulary:

- **Console** = the CAS web UI at the server URL. **API base** = `<server URL>/api`.
- **Outbox item states**: `QUEUED` → (`PROCESSING`) → `SENT` or `DEAD_LETTER`.
- **SENT means different things per channel** — see the table; report wording
  matters.

## The four alert channels

| Channel | Who delivers | What `SENT` means | Config |
| --- | --- | --- | --- |
| SMS | The Pixel itself, over its own SIM | Handset reported radio success per responder | Console's Responders page (handed to the phone with every trigger and re-queue pickup); the phone's own list is only the offline/unseeded fallback. Server runs `CAS_SMS_DELIVERY_MODE=device` |
| WHATSAPP | The console's outbox worker → WhatsApp Business Cloud API messages endpoint | Provider accepted the message (HTTPS POST, idempotency-keyed) | `CAS_WHATSAPP_PROVIDER_URL` + `CAS_WHATSAPP_PROVIDER_TOKEN`; recipients from the console's Responders page |
| XMPP | The console's outbox worker → configured provider endpoint | Provider accepted the stanza (HTTPS POST, idempotency-keyed) | `CAS_XMPP_PROVIDER_URL`; recipients from the console's Responders page |
| EMAIL | The console's outbox worker → dedicated mailbox over SMTP, or a configured HTTPS provider endpoint | The mailbox's SMTP server (or HTTPS provider) accepted the message — the last hop into the inbox is the responder's spam filtering | `CAS_EMAIL_SMTP_HOST/PORT/USER/PASSWORD` (direct SMTP, TLS mandatory) **or** `CAS_EMAIL_PROVIDER_URL`; recipients from the console's Responders page |

**Who gets alerted and what it says are console settings, not secrets.** The
console's **Responders** page holds the responder circle (per-person SMS /
WhatsApp / email / XMPP channels, enable/disable) and the **Alert text** page
holds the per-channel message templates with a live preview. On first run the
server copies the `CAS_*_RECIPIENTS` environment lists into the circle
(marked "env seed"); from then on the env lists are ignored unless the circle
table is completely empty. Template wording refuses credential-shaped text
and flags SMS bodies that would split into multiple segments. The circle and
the rendered SMS template are handed to the handset with every trigger
answer and re-queue pickup, so console edits apply to the phone's own SIM
sends too — including "text nobody" when every SMS responder is disabled.
Only a phone that cannot reach the console at all falls back to its locally
stored list and offline wording.

The handset never opens the WhatsApp app (or any other app) for alerting —
that keeps the screen silent and keeps responder-provider credentials off
the phone entirely, limiting the damage if the phone is captured.

In the current dev deployment, WHATSAPP, XMPP, and EMAIL point at an
in-process **dev provider sink** (`/api/cas/dev/provider-inbox`) that records
exactly what would have been sent — enough to prove the pipeline end-to-end
without any third-party account. Real provider accounts replace the URLs
later; nothing else changes.

**Live-secrets warning — test bursts hit real responders.** When the server
you drill against holds live `CAS_EMAIL_SMTP_*` or provider secrets, **any
process that fires an alert burst without the test rails emails/messages real
responders.** The automated test suites are the only safe runners: under
`NODE_ENV=test` they force every channel to the dev sink
(`DELIVERY_SIMULATED`) and boot-guard on a disposable database. Anything else
— the drill script in this kit pointed at the live deployment, a hand-run
suite, a load harness — has no such rail: in 2026-09 an automated suite ran
with the live mailbox secrets in its environment and emailed the owner's test
responders ~20 times before anyone noticed. Keep the T4/T6/T7 sink drills on
a dev deployment, and treat any shell that has sourced the server's secrets
as armed.

## T0 — Workstation and server preflight

1. `scripts\run-windows-preflight.cmd` → expect `PASS` (fix any `BLOCKED`).
2. In PowerShell:

   ```powershell
   . .\scripts\cas-api-drills.ps1 -BaseUrl https://<server-host> -DeviceToken <shared-token> -AlertToken <alert-credential>
   Get-CasOutboxStatus
   ```

   `<shared-token>` is the same value as the server's `CAS_DEVICE_TOKEN`
   secret. Pass: `smsDeliveryMode` is `device`, `deviceChannels` contains
   `SMS` only (WhatsApp is a server-side gateway channel now — if it shows
   under `deviceChannels`, the server still runs the retired config),
   `deviceAuthConfigured` is true, worker heartbeat `running` is true.

## T1 — Build and install the app

`scripts\run-mvp-install.cmd` → installs version `0.8.0-selfupdate` (versionCode 7).
Pass: `adb shell dumpsys package com.covertalert.pixeltest | findstr versionName`
prints `0.8.0-selfupdate`.

**Field signing key (required for field builds):** every kit APK is signed with
one pinned release key (the single key entry in the keystore stored in the
workspace secrets). Android only accepts an update signed with the SAME
certificate, so this key is what lets field phones take future kit builds as
in-place updates instead of manual reinstalls. The key material is never
committed — it lives in the workspace secrets
`CAS_RELEASE_KEYSTORE_B64` (base64 of the keystore) and
`CAS_RELEASE_KEYSTORE_PASSWORD`; export both as environment variables before
building. The build then signs the APK with the pinned key, and the packaging
gate (`scripts\build-android-test-apk.ps1`) verifies the APK's certificate
SHA-256 against the committed pin in `signing\field-release-cert.sha256.txt` —
it refuses to package an APK signed with any other key, and refuses to package
at all when the key is absent. Without the secrets the Gradle build itself
falls back to the debug key (fine for CI/emulator drills, never for a phone
going to the field — those APKs can only come from a gated packaging run).

**One-time migration — phones already running a debug-signed install:**
Android will refuse `adb install -r` over the old debug-signed app
(`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). On each such phone, once:
1. `adb uninstall com.covertalert.pixeltest` (this wipes the app's stored
   enrollment — expected),
2. install the key-signed build (`scripts\run-mvp-install.cmd`),
3. on the phone, re-enter the alert server URL and the device access token
   (T2 step 1) and re-grant the SMS/location permissions.
Every later build installs in place — no repeat of this migration as long as
the pinned key stays the signing key.

**Optional — push wake build:** to make responder-requested capture near-real-time
(T10b), place the Firebase project's `google-services.json` (Android app
`com.covertalert.pixeltest`) at `app\google-services.json` before building, and
configure the server with the matching service account (`CAS_FCM_SERVICE_ACCOUNT_*`,
see SELF-HOSTING.md). Without the file the app builds and runs exactly as before —
capture requests are honored on the phone's next server contact (polling), which
remains the fallback in every build.

## T2 — Real SMS alert with location (phone required)

1. On the phone: enter the alert server URL and the **device access token**
   (same value as the server's `CAS_DEVICE_TOKEN` secret), then responder
   number(s), **Save responder numbers**, **Grant SMS permission**, **Grant
   location permission**.
2. **Send MVP alert now**. Pass: the responder's phone receives the SMS from
   the Pixel's own number; the on-screen report shows `MVP_ALERT_OUTCOME`
   SENT then `SMS_SEND_OUTCOME` delivered=1; the console incident's SMS item
   turns `SENT` within seconds (journal shows `DELIVERY_REPORTED`).
   On handsets where `SmsManager.divideMessage` is broken (observed on the
   Pixel running Android 17 / API 37), the app no longer depends on it: the  <!-- toolreq-gate: allow -- the field Pixel's OS is deliberately newer than the kit's declared API floor -->
   app splits the body into valid SMS segments itself (GSM-7 vs Unicode
   limits, escape/surrogate pairs never split) and sends them as a proper
   concatenated multipart message. The journal still shows
   `SMS_DIVIDE_FALLBACK` with the platform's real divide exception PLUS the
   app's own segment count (`appSegments`) and `encoding` — the platform
   call is now diagnostic only. A body goes out as ONE part only when it
   genuinely fits a single segment.
   Field history, 2026-10-01 (Pixel, build 0.8.1, pre-fix): the old
   single-part fallback fired (`reason`: `getGroupIdLevel1`, body 210
   chars) and every part came back `RESULT_ERROR_GENERIC_FAILURE` —
   delivered=0, because one SMS part cannot carry a ~210-char body. That
   failure mode is what app-owned segmentation removes: the same body now
   goes out as multiple valid segments (note: the location clause's `±`
   forces Unicode encoding, so the 70/67-char limits apply, not 160/153).
   Pass criterion is unchanged: the responder actually receives the SMS
   and the journaled radio results are RESULT_OK.
3. The SMS ends with a location sentence: a `maps.google.com` link plus
   `(±Nm, fix Xs old)`. The console incident view shows the same fix with a
   map link, accuracy radius, and fix age. If the phone could not get a fix
   in time, the message says `no fix captured for this alert.` instead —
   never bare coordinates and never a silent omission.
4. Resolve the incident in the console.

## T2b — Location accuracy proof (phone required, outdoors + indoors)

Proves the fix responders receive is trustworthy, not just present.

1. **Outdoors** (sky visible): grant location, send an MVP alert. Compare the
   SMS map link against the phone's true position (e.g. drop a pin in a maps
   app). Pass: the link lands within the stated accuracy radius (`±Nm`) of
   the true position, and the fix age is small (`fix Xs old`, not minutes).
2. **Indoors** (deep inside a building): repeat. Pass: the alert still
   leaves within the bounded wait (~8 s worst case) and either carries a
   coarser fix honestly labeled with a larger `±Nm` radius / a
   `+last-known` age, or says `no fix captured for this alert.` — it must
   not present a stale fix as current and must not wait indefinitely.
3. **Airplane-mode toggle** (optional): with location off at the OS level,
   send once more. Pass: the alert leaves immediately and both the SMS and
   the console say no fix was captured.
4. **Movement re-capture** (outdoors, incident still ACTIVE): keep the app
   open after the send and walk at least 100 m (a short block is enough);
   wait up to ~1 minute at the far point. Pass: the console incident journal
   gains a `LOCATION_UPDATED` entry per accepted fix (`Movement re-capture
   fix #N …` with accuracy `±Nm` and capture age), the incident's location
   panel moves to the newest fix, and the phone's debug journal shows
   `LOCATION_RECAPTURE_STARTED` then `LOCATION_RECAPTURE_FIX` with
   `outcome=POSTED_MOVEMENT`. Fixes arrive at most once a minute however far
   you walk; standing still still re-baselines every 5 minutes
   (`POSTED_PERIODIC`).
5. **Stop on resolve**: resolve the incident in the console, then walk
   another 100+ m. Pass: no new `LOCATION_UPDATED` entries appear, and the
   phone's debug journal shows `LOCATION_RECAPTURE_STOPPED`. On a
   push-enabled build (google-services.json in the kit) the watch tears
   down within seconds of the resolve — reason `push`, preceded by
   `RESOLVE_PUSH_RECEIVED`; the console incident journal shows
   `RESOLVE_PUSH_SENT` at resolve time. On a push-less build the stop lands
   within one movement (or one 5-minute periodic cycle) with reason
   `incident no longer active on the server`, and the console journal shows
   `RESOLVE_PUSH_UNAVAILABLE` at resolve time. The watch never runs longer
   than 2 hours per incident (`duration cap reached`) even if nobody
   resolves it.

## T3 — SMS dead-letter drill (phone required)

1. Save a wrong responder number (`1`), send an alert.
2. Pass: console SMS item → `DEAD_LETTER`, lastError shows
   `ILLEGAL_DESTINATION_ADDRESS` or a radio error with the number **masked**
   (`•••..`), journal shows `DELIVERY_ABANDONED`, and the dead-letter alarm
   appears on the incidents page.
3. Fix the number on the phone, press **Re-queue** on the console incident,
   tap **Check re-queued deliveries** on the phone.
4. Pass: SMS item → `SENT`; journal shows
   `DELIVERY_ABANDONED → DELIVERY_REQUEUED → DELIVERY_REPORTED`. Resolve.

## T4 — WhatsApp through the provider sink (API only)

Same shape as T6/T7 — WhatsApp is a server-side channel now:

```powershell
Clear-CasProviderInbox
Invoke-CasTrigger          # note the incident id
Watch-CasOutbox -IncidentId <id> -Transport WHATSAPP
Get-CasProviderInbox
```

`-Transport WHATSAPP` keeps the watch on the server-side item only: the
trigger also queues the handset's SMS item, and with no phone polling in an
API-only drill it stays `QUEUED`, so an unfiltered watch would burn its whole
timeout and warn even on a pass.

Pass: the incident's WHATSAPP item turns `SENT` within ~15 s (one worker
tick), and the inbox shows a Cloud-API-shaped message
(`messaging_product: "whatsapp"`, `type: "text"`, `text.body` carrying the
alert text) whose `Idempotency-Key` is `<incident>-whatsapp:<recipient>`.
Resolve the incident.

## T5 — WhatsApp stays off the handset (API only)

This drills the no-screen-flash rule at the API boundary: the console must
never treat WhatsApp as something the phone delivers.

1. `Invoke-CasTrigger` on a fresh incident, then `Get-CasDevicePending`.
   Pass: the list offers the handset only its SMS item — never a WHATSAPP
   item.
2. `Send-CasDeviceReceipt -IncidentId <id> -Channel WHATSAPP -Recipient
   "+1555000111" -Ok:$true` → must be refused with HTTP 409
   ("not an enabled device channel"), and the incident's WHATSAPP outbox
   item is unaffected.
3. Re-queue the SMS item from the console, then tap **Check re-queued
   deliveries** on the phone. Pass: only SMS is re-sent; nothing opens on
   the phone's screen.

## T6 — XMPP through the provider sink (API only)

```powershell
Clear-CasProviderInbox
Invoke-CasTrigger          # note the incident id
Watch-CasOutbox -IncidentId <id> -Transport XMPP
Get-CasProviderInbox
```

Pass: the incident's XMPP item turns `SENT` within ~15 s (one worker tick),
and the inbox shows a `chat` stanza whose `stanzaId` equals the
`Idempotency-Key` (`<incident>-xmpp:<recipient>`). Resolve the incident.

## T7 — Email through the provider sink (API only)

Same as T6, watching the EMAIL item (`Watch-CasOutbox -IncidentId <id>
-Transport EMAIL`). Pass: EMAIL item → `SENT`; inbox entry carries
`to`, `from`, `subject` = `CAS P1 alert <incident id>`, and the alert body.

**Expected labeling for T4/T6/T7:** because these drills deliver to the
built-in test inbox, the console no longer shows a bare `SENT` — the chip
reads `SIMULATED — test inbox`, the outbox item's `deliveredTo` is
`"dev-sink"`, and the incident journal carries a `DELIVERY_SIMULATED` event.
That is the pass state; a real provider would show the provider's identity
instead.

## T7b — Email failure honesty: wrong app password (API only, SMTP deployment)

Proves the failure the owner is most likely to hit a year from now — a
rotated or revoked mailbox app password — fails loudly in the console,
never silently. Run once against the real deployment after T7 passes.
Requires a deployment where email sends over direct SMTP (server
`CAS_EMAIL_SMTP_*` secrets or the console's primary mailbox), not the dev
provider sink.

1. Break the credential on whichever configuration owns the channel — the
   banner on the console's **Email delivery** page says which is live:
   - **Server secrets:** set `CAS_EMAIL_SMTP_PASSWORD` to a wrong value
     (e.g. the real app password with one character changed) and restart
     the service (`sudo systemctl restart cas-api`).
   - **Console primary mailbox:** edit the primary mailbox and save a wrong
     app password (no restart; the field is write-only).
2. From the workstation:

   ```powershell
   Invoke-CasTrigger          # note the incident id
   Watch-CasOutbox -IncidentId <id> -Transport EMAIL -TimeoutSeconds 600
   ```

3. Pass — the failure is loud and named:
   - The EMAIL item ends `DEAD_LETTER` (8 attempts with backoff, so allow a
     few minutes) — never stuck `QUEUED`, never silently dropped. The
     console chip reads `EMAIL · DEAD LETTER · abandoned after 8 attempts`
     and its last error starts `authentication (permanent):` — the mailbox
     refused the credentials — and names the recovery
     (`CAS_EMAIL_SMTP_USER` / a fresh app password). No password material
     appears in any error text.
   - The journal shows `DELIVERY_ABANDONED` with the same named error, and
     the dead-letter alarm appears on the incidents page.
   - `Get-CasOutboxStatus` surfaces the failure under `lastDeliveryError`
     from the first failed attempt, well before the retries exhaust.
4. Fix the credential (restore the correct app password — env secret +
   restart, or re-save the console primary mailbox), then re-queue:

   ```powershell
   Invoke-CasRequeue -OutboxItemId '<incidentId>-email'
   Watch-CasOutbox -IncidentId <id> -Transport EMAIL
   ```

   (The console's **Re-queue** button on the EMAIL chip does the same.)
   Pass: EMAIL item → `SENT` within ~15 s (one worker tick); the journal
   shows `DELIVERY_ABANDONED → DELIVERY_REQUEUED`.
5. Resolve the incident.

   If the deployment sends through `CAS_EMAIL_PROVIDER_URL` instead of
   SMTP, the same drill applies to the provider token — the named
   classification is still `authentication (permanent)`.

## T8 — Failure honesty (API only)

1. `Send-CasDeviceReceipt` with `-Ok:$false` against a live incident's SMS
   item → item dead-letters immediately (device channels have no server-side
   retry — by design; the handset is the only agent).
2. Repeat the same successful receipt twice → second call returns
   `replay: true` and the journal gains no duplicate entry.
3. Post a receipt with `channel: "WHATSAPP"` to the legacy
   `sms-receipt` endpoint → it must still only affect the SMS item.
4. Auth: `Get-CasDevicePending` and `Send-CasDeviceReceipt` without
   `-DeviceToken` (reload the script without it) must fail with 401; a wrong
   token must also fail with 401; a forged all-success receipt must leave
   the item `QUEUED`.
5. Alert credential: `Invoke-CasTrigger`, `Resolve-CasIncident`, and
   `Invoke-CasRequeue` without `-AlertToken` (reload the script without it)
   must fail with 401 — those endpoints only accept the server's
   `CAS_ALERT_TOKEN` secret as a Bearer credential.

## T9 — No-data fallback (phone required, optional but valuable)

1. On the phone: disable mobile data and Wi-Fi, keep cellular signal.
2. Send an alert. Pass: the responder still receives the SMS (SIM needs no
   data), while the console shows no incident until data returns. The
   console honestly keeps any unreceipted item `QUEUED` with the
   stuck-pipeline warning lit.


## T10 — Evidence capture playground (phone required)

Proves each capture type lands in the console on the right incident, with
the screen off. The green OS indicator is expected and accepted throughout.
Evidence upload uses the phone's enrolled per-device credential (created
automatically during the first provisioned trigger); a phone whose
credential was revoked from the console cannot upload or pick up capture
requests, and the shared device token is not accepted for evidence.

1. In the console, open **Evidence capture**. Set **Audio** to *Start on
   trigger** and timing to *Immediate*. On the phone: **Grant microphone
   permission**.
2. Send an alert, then immediately lock the phone and set it down. Pass:
   the console incident's evidence panel fills with rolling audio clips
   (`audio · clip 1`, `clip 2`, … up to 6 × 30 s) within a couple of
   minutes, each **Download**-able and playable, and the journal shows
   `EVIDENCE_UPLOADED` per clip. No app UI ever appeared on the phone.
3. Set **Photo** to *Start on trigger*, grant camera permission, alert
   again. Pass: one still photo lands in the panel; the camera app UI never
   opened on the phone.
4. Set **Video** to *Start on trigger*, alert again. Pass: one ~20 s video
   clip lands in the panel, playable after download.
4a. **Camera selector:** on the console **Evidence capture** page, set
   **Camera for photo & video** to *Front and back* and alert again. Pass:
   one still **and** one clip per lens land in the panel, each labeled with
   its camera (`photo · back camera`, `photo · front camera`, …), and the
   downloads are named `…-photo-back-1.jpg` / `…-photo-front-2.jpg`. Then
   try *Front camera* alone. If the phone cannot do concurrent front+back
   capture (Pixel 8 and later can), the journal honestly shows
   `EVIDENCE_CAPTURE … outcome=DEGRADED` and only the back camera is
   captured — record that; it is the measured hardware limit, not a bug.
5. **Timing experiment:** switch timing to *On screen-off* and run the same
   scenario twice — once locking the phone right away, once leaving the
   screen on for ~2 minutes first. Pass: in both runs capture begins only
   after the screen turns off (compare clip content against the immediate
   runs from steps 2–4 and note which catches more useful evidence).
6. **Responder-requested capture:** set **Audio** to *Only when a responder
   asks*. Trigger an alert (no audio should start). From the console
   incident view, press **Request audio capture**, then on the phone tap
   **Check re-queued deliveries**. Pass: the journal shows
   `CAPTURE_REQUESTED → CAPTURE_STARTED → CAPTURE_COMPLETED` and the clip
   lands in the panel. If the phone was idle-locked and Android refused the
   start, the journal instead shows `CAPTURE_FAILED` with the exact
   exception — record that text; it is the measured background-start limit.
7. Resolve the incident. Note in the report-back which timing mode caught
   better evidence and how visible each capture start was.

## T10b — Push wake for responder capture requests (phone required, push build)

Proves the high-priority push path: a responder's capture request wakes the
idle phone immediately instead of waiting for the next check-in. Requires the
push build (T1 optional step: `google-services.json` in the app) and a server
with `CAS_FCM_SERVICE_ACCOUNT_*` configured.

1. On the phone, send one alert and leave the app once (so the push token
   registers). Pass: the on-screen report shows `PUSH_TOKEN_REGISTERED`
   outcome OK. If it shows `PUSH_UNAVAILABLE`, this build has no Firebase
   config — run the rest with the polling expectation instead.
2. Set **Audio** to *Only when a responder asks*. Trigger an alert, lock the
   phone, and set it down — do NOT touch it again.
3. From the console incident view, press **Request audio capture**. Pass: the
   phone starts capturing within seconds while still idle-locked (green mic
   indicator), the journal shows `CAPTURE_PUSH_SENT` at request time and
   `CAPTURE_STARTED` recorded *woken instantly by a high-priority push
   message*, and the clip lands in the panel. No one touched the phone.
4. **Fallback proof:** on the server, unset `CAS_FCM_SERVICE_ACCOUNT_*` (or
   revoke network access to FCM) and repeat step 3. Pass: the journal shows
   `CAPTURE_PUSH_UNAVAILABLE` at request time, the phone honors the request
   on its next contact (app resume or **Check re-queued deliveries**), and
   `CAPTURE_STARTED` names the polling path.
5. Resolve the incident.

## Report-back template

```text
CAS handoff test run — <date> <operator>
Server URL: <...>   App version: <0.7.0-push?>
T0 preflight:        PASS/FAIL — <notes>
T1 build/install:    PASS/FAIL — <versionName seen>
T2 real SMS:         PASS/FAIL — <responder received? console state? incident id; SMS_DIVIDE_FALLBACK exception text if shown>
T2b outdoors:        PASS/FAIL — <accuracy radius ±Nm; fix age; distance link-vs-true position; incident id>
T2b indoors:         PASS/FAIL — <which behavior: coarser fix (radius/age) / +last-known (age) / no-fix sentence; alert left within ~8s?; incident id>
T2b location-off (opt.): PASS/FAIL/SKIP — <alert left immediately? SMS + console both said no fix captured?>
T2b movement re-capture: PASS/FAIL — <LOCATION_UPDATED entries with ±Nm + age? console moved to newest fix? POSTED_MOVEMENT/POSTED_PERIODIC on phone; incident id>
T2b stop on resolve: PASS/FAIL — <no updates after resolve? LOCATION_RECAPTURE_STOPPED reason seen (`push` within seconds on a push-enabled build, else `incident no longer active on the server`); RESOLVE_PUSH_SENT/UNAVAILABLE in console journal>
T3 SMS dead-letter:  PASS/FAIL — <journal sequence seen>
T4 WhatsApp sink:      PASS/FAIL — <messaging_product/idempotency key seen>
T5 WhatsApp off-phone: PASS/FAIL — <409 seen? pending list SMS-only?>
T6 XMPP sink:        PASS/FAIL — <stanzaId seen>
T7 email sink:       PASS/FAIL — <subject seen>
T7b SMTP failure honesty: PASS/FAIL/SKIP — <authentication (permanent) named in chip + journal? SENT after fix + re-queue?>
T8 failure honesty:  PASS/FAIL — <replay:true seen?>
T9 no-data fallback: PASS/FAIL/SKIP — <SMS arrived with data off?>
T10 evidence capture: PASS/FAIL — <which types landed; immediate vs screen-off comparison; camera selector (front/both) honored & labeled?; any CAPTURE_FAILED or DEGRADED detail>
T10b push wake:        PASS/FAIL/SKIP — <push path honored from idle? fallback polling still works?>
Console UI check:    incidents page showed all four transport chips with matching states? Y/N
Blockers/questions:  <...>
```

Paste the filled template plus any failing command output back to the
workspace chat. If an alert send or capture misbehaved, also tap **Copy
debug journal** on the phone and paste that too: the Gate 0A **Copy JSON
report** deliberately filters the journal down to the harness event types
its importer accepts, so alert-send and capture events (`MVP_ALERT_*`,
`MVP_SMS_OUTCOME`, `LOCATION_CAPTURE`, `LOCATION_RECAPTURE_*`, `CAPTURE_*`,
…) only appear in the debug journal — that is the export that shows why a
send failed. Never import the debug journal as a Gate 0A report.

One import prerequisite: the Gate 0A **Copy JSON report** is only accepted by
the console importer when a cover app is selected on the phone (T0/T1 step).
If the session used **Clear cover app (manual trigger only)**, the copied
report carries an empty cover package and the importer rejects it — select any
cover app and copy the report again before pasting it back. The debug journal
is unaffected either way.
