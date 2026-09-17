# CAS Pixel 11 — MVP Handoff (Windows machine + attached Pixel 11)

**Goal:** prove the MVP alert loop on the personal Pixel 11 — one tap on the phone
sends a real alert trigger to the CAS server, and the incident appears in the CAS
console for an operator to acknowledge and resolve.

**What this MVP does:** phone → HTTPS POST → durable P1 incident in the console,
then the handset texts every configured responder directly from its own SIM
(device-direct SMS — no third-party gateway, no subscription) and reports the
outcome back so the console marks the delivery SENT.

**What this MVP deliberately does not do yet:** notify responders by XMPP,
capture location, or record evidence. Those are the next milestones, not part
of this handoff.

Everything runs as a standard Windows user. No administrator rights are needed.

---

## Step 1 — Extract the package

Extract the ZIP to a writable folder, e.g. `Desktop\CAS-Pixel11-MVP`.
Do not run scripts from inside the ZIP preview window.

## Step 2 — Confirm the workstation is still clean

Double-click `scripts\run-windows-preflight.cmd`.

Expect all required checks PASS. This machine already passed preflight during
the Gate 0A run; this is a fast re-verification. If anything is BLOCKED, stop
and resolve it before continuing.

## Step 3 — Connect the phone

1. Unlock the Pixel 11.
2. Connect it with the USB-C data cable.
3. If the phone shows "Allow USB debugging?", approve it.
4. Confirm exactly one device is authorized: run `adb devices -l` in a terminal
   and check for one line ending in `device` with `model:Pixel_11`.

## Step 4 — Build and install the MVP app

Double-click `scripts\run-mvp-install.cmd`.

- It verifies the attached device is the approved Pixel 11 on API 35 or newer.
- Type `INSTALL MVP` when prompted.
- It builds the debug APK and installs it with `adb install -r`.
- Expected finish: `MVP app installed on Pixel 11 (...)`.

The app is named **CAS Pixel Gate 0A** in the launcher (same package, now with
the MVP alert controls added).

## Step 5 — Configure the alert server on the phone

1. Open the app on the phone.
2. In the **Alert server URL** field, paste the server address exactly as
   provided in the accompanying message, e.g.
   `https://<host>.replit.dev`
3. Tap **Save alert server**.
4. In the **Device access token** field, enter the shared handset token — the
   same value as the server's `CAS_DEVICE_TOKEN` secret — and tap **Save
   device token**. Without it the console refuses the phone's pickup and
   receipt calls (401), so delivery states would never update.
5. In the **Alert credential** field, paste the alert token exactly as provided
   in the accompanying message (it is the same value as the server's
   `CAS_ALERT_TOKEN` secret), then tap **Save alert credential**.

The trigger endpoint rejects any request without the alert credential
(HTTP 401), so the incident will not be recorded until it is saved — without
it the phone can still text responders directly, but no incident appears in
the console. Treat both tokens like passwords: do not paste them into the
on-screen report, chat, or email.

Note: the development URL works while the CAS workspace is running. If the team
publishes the app, use the published URL instead — it is stable and stays up.

## Step 6 — Configure responders and SMS permission on the phone

1. In the **Responder numbers** field, enter the responder phone numbers,
   comma-separated, in international format (e.g. `+15551234567`).
2. Tap **Save responder numbers**.
3. Tap **Grant SMS permission** and approve the system dialog. The app sends
   SMS itself, so Android requires this one-time grant.
4. Optional: tick **Also alert via WhatsApp** to have the phone open each
   responder's WhatsApp chat with the alert pre-filled after the SMS goes
   out. The free WhatsApp app has no automatic-send API, so you tap send in
   each chat; the console marks the WHATSAPP item from the handoff report.

## Step 7 — Send the first real alert

1. Tap **Send MVP alert now**.
2. The on-screen report should record `MVP_ALERT_OUTCOME` with `outcome: SENT`
   and an incident id, followed by `SMS_SEND_OUTCOME` showing each responder
   delivered (radio results usually land within a few seconds).
3. Each responder phone receives the alert SMS from the Pixel's own number.
   If WhatsApp alerting is enabled, WhatsApp opens with one pre-filled chat
   per responder — tap send in each; the console's WHATSAPP item turns `SENT`
   when the handoff report arrives ("handed to WhatsApp", not
   delivery-confirmed). XMPP and email items deliver through their configured
   providers and turn `SENT` within one worker tick (~10 s).
4. On any browser, open the CAS console at the server address, then open the
   incidents/overview view: a P1 incident in `ACTIVE_UNACKED` state appears
   and its SMS outbox item shows `SENT` once the handset's receipt arrives.
5. In the console, acknowledge and resolve the incident. The first mutation in
   a browser session asks for the same alert credential the phone uses
   (`CAS_ALERT_TOKEN`); it is remembered until the tab closes. A 401 clears it
   and the next action asks again.

**Dead-letter drill (optional but recommended once):** save an intentionally
wrong responder number (e.g. `1`), send an alert, and watch the console mark
the SMS item `DEAD_LETTER` with a device-reported failure. Fix the number on
the phone, press **Re-queue** on the console incident, then tap **Check
re-queued deliveries** on the phone — the item turns `SENT` and the journal
shows the full abandonment → re-queue → delivery sequence. The same drill
works for the WHATSAPP item when WhatsApp alerting is enabled (with WhatsApp
absent from the phone, the report arrives as `WHATSAPP_NOT_INSTALLED`).

Expected behavior for repeat taps: while an incident is still active, another
tap folds into the same incident (trigger count increases) instead of creating
duplicates, and the handset journals `FOLDED_INTO_ACTIVE` without re-sending
SMS/WhatsApp — matching the console's decision not to queue new deliveries.
This is by design.

## Step 8 — Record Gate 0A sign-off (console, any browser)

The physical Gate 0A run on 2026-09-14 passed 219/219 checks. Its `report.json`
(`cas-gate0a-report-v2`, ~250 KB) was delivered separately:

1. Open the console **Gates** page.
2. Import `report.json` as a file (do not paste it as text).
3. Review the imported evidence and record the Gate 0A observation.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `INSTALL MVP` script says Gradle or adb not found | Run `scripts\run-windows-preflight.cmd` and fix the BLOCKED line |
| Script says zero or multiple devices | Keep only the Pixel 11 attached; approve the RSA prompt on the phone |
| `MVP_ALERT_OUTCOME` = FAILED, "must start with https://" | Fix the server URL and save again |
| FAILED with a timeout or "Request failed" | Check phone internet; confirm the CAS workspace/app is running; confirm the URL |
| HTTP 404/502 from server | The URL must be the app root, not a sub-path; the app appends `/api/cas/incidents/trigger` itself |
| HTTP 401 from server | The alert credential on the phone does not match the server's `CAS_ALERT_TOKEN` secret; re-enter it and save again |
| No incident appears in the console | Confirm the console is the same server URL the phone used; check the server is running |
| `MVP_ALERT_OUTCOME` = NOT_SENT, "SEND_SMS permission not granted" | Grant the permission (Grant SMS permission button), then send again |
| SMS outbox item shows `DEAD_LETTER` with "device-reported failure" | Fix the responder number on the phone, re-queue from the console, then tap **Check re-queued deliveries** on the phone |
| Responder got the SMS but the console still shows QUEUED | The phone has no data connection, so its receipt could not reach the server; it retries on the next send or re-queue check. If the phone's journal shows `SKIPPED` with "no device access token", enter the token (Step 5) and tap **Check re-queued deliveries** |
| `*_RECEIPT_OUTCOME` = FAILED (HTTP 401) | The device access token on the phone does not match the server's `CAS_DEVICE_TOKEN` secret; re-enter it and tap **Check re-queued deliveries** |
| WhatsApp did not open after the alert | WhatsApp is not installed, or the WhatsApp checkbox is off; the console's WHATSAPP item dead-letters with `WHATSAPP_NOT_INSTALLED` |
| Console shows WHATSAPP `SENT` but the responder got nothing | SENT means handed to WhatsApp; a chat was left without tapping send — reopen WhatsApp and finish it |

## Safety notes

- This build adds the alert POST plus device-direct SMS to the responder
  numbers configured on the handset, and no other new capability. It does not
  access location, capture evidence, change Device Owner state, or reboot the
  phone. Sent SMS is not written to the phone's Messages app. The optional
  WhatsApp path only opens pre-filled chats in the official WhatsApp app;
  nothing is sent without the operator's tap.
- Gate 0A harness scripts (`run-pixel11-qualification.cmd`, `run-pixel11-full.cmd`)
  are unchanged and remain available; the physical 200-repeat evidence from
  2026-09-14 stays valid.
- Uninstall any time with `adb uninstall com.covertalert.pixeltest`.

## Step 8 — Record Gate 0A sign-off (console, any browser)

The physical Gate 0A run on 2026-09-14 passed 219/219 checks. Its `report.json`
(`cas-gate0a-report-v2`, ~250 KB) was delivered separately:

1. Open the console **Gates** page.
2. Import `report.json` as a file (do not paste it as text).
3. Review the imported evidence and record the Gate 0A observation.
