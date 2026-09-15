# CAS Pixel 11 — MVP Handoff (Windows machine + attached Pixel 11)

**Goal:** prove the MVP alert loop on the personal Pixel 11 — one tap on the phone
sends a real alert trigger to the CAS server, and the incident appears in the CAS
console for an operator to acknowledge and resolve.

**What this MVP does:** phone → HTTPS POST → durable P1 incident in the console.

**What this MVP deliberately does not do yet:** notify responders by SMS/XMPP
(server provider gateways are not configured), capture location, or record
evidence. Those are the next milestones, not part of this handoff.

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

Note: the development URL works while the CAS workspace is running. If the team
publishes the app, use the published URL instead — it is stable and stays up.

## Step 6 — Send the first real alert

1. Tap **Send MVP alert now**.
2. The on-screen report should record `MVP_ALERT_OUTCOME` with `outcome: SENT`
   and an incident id.
3. On any browser, open the CAS console at the server address, then open the
   incidents/overview view: a P1 incident in `ACTIVE_UNACKED` state appears.
4. In the console, acknowledge and resolve the incident.

Expected behavior for repeat taps: while an incident is still active, another
tap folds into the same incident (trigger count increases) instead of creating
duplicates. This is by design.

## Step 7 — Record Gate 0A sign-off (console, any browser)

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
| No incident appears in the console | Confirm the console is the same server URL the phone used; check the server is running |

## Safety notes

- This build adds exactly one network call (the alert POST) and no other new
  capability. It does not send SMS, access location, capture evidence, change
  Device Owner state, or reboot the phone.
- Gate 0A harness scripts (`run-pixel11-qualification.cmd`, `run-pixel11-full.cmd`)
  are unchanged and remain available; the physical 200-repeat evidence from
  2026-09-14 stays valid.
- Uninstall any time with `adb uninstall com.covertalert.pixeltest`.
