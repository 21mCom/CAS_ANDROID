# CAS — Handoff Test Kit (Windows operator)

For the agentic operator on the Windows workstation with the Pixel 11 attached.
Run the whole matrix in one session and report back with the template at the
bottom. API-side drills use `scripts\cas-api-drills.ps1` so the phone is only
needed for the two paths that genuinely require it (real SMS over the SIM,
WhatsApp tap-to-send).

Vocabulary:

- **Console** = the CAS web UI at the server URL. **API base** = `<server URL>/api`.
- **Outbox item states**: `QUEUED` → (`PROCESSING`) → `SENT` or `DEAD_LETTER`.
- **SENT means different things per channel** — see the table; report wording
  matters.

## The four alert channels

| Channel | Who delivers | What `SENT` means | Config |
| --- | --- | --- | --- |
| SMS | The Pixel itself, over its own SIM | Handset reported radio success per responder | Responder numbers on the phone; server runs `CAS_SMS_DELIVERY_MODE=device` |
| WHATSAPP | The Pixel, via the official WhatsApp app | **Handed to WhatsApp** with the alert pre-filled — an operator tap sends it; not delivery-confirmed | WhatsApp checkbox on the phone; server runs `CAS_DEVICE_CHANNELS=SMS,WHATSAPP` |
| XMPP | The console's outbox worker → configured provider endpoint | Provider accepted the stanza (HTTPS POST, idempotency-keyed) | `CAS_XMPP_PROVIDER_URL` + `CAS_XMPP_RECIPIENTS` |
| EMAIL | The console's outbox worker → configured provider endpoint | Provider accepted the message | `CAS_EMAIL_PROVIDER_URL` + `CAS_EMAIL_RECIPIENTS` |

In the current dev deployment, XMPP and EMAIL point at an in-process **dev
provider sink** (`/api/cas/dev/provider-inbox`) that records exactly what
would have been sent — enough to prove the pipeline end-to-end without any
third-party account. Real provider accounts replace the URLs later; nothing
else changes.

## T0 — Workstation and server preflight

1. `scripts\run-windows-preflight.cmd` → expect `PASS` (fix any `BLOCKED`).
2. In PowerShell:

   ```powershell
   . .\scripts\cas-api-drills.ps1 -BaseUrl https://<server-host> -DeviceToken <shared-token> -AlertToken <alert-credential>
   Get-CasOutboxStatus
   ```

   `<shared-token>` is the same value as the server's `CAS_DEVICE_TOKEN`
   secret. Pass: `smsDeliveryMode` is `device`, `deviceChannels` contains
   `SMS` and `WHATSAPP`, `deviceAuthConfigured` is true, worker heartbeat
   `running` is true.

## T1 — Build and install the app

`scripts\run-mvp-install.cmd` → installs version `0.4.0-mvp` (versionCode 3).
Pass: `adb shell dumpsys package com.covertalert.pixeltest | findstr versionName`
prints `0.4.0-mvp`.

## T2 — Real SMS alert (phone required)

1. On the phone: enter the alert server URL and the **device access token**
   (same value as the server's `CAS_DEVICE_TOKEN` secret), then responder
   number(s), **Save responder numbers**, **Grant SMS permission**.
2. **Send MVP alert now**. Pass: the responder's phone receives the SMS from
   the Pixel's own number; the on-screen report shows `MVP_ALERT_OUTCOME`
   SENT then `SMS_SEND_OUTCOME` delivered=1; the console incident's SMS item
   turns `SENT` within seconds (journal shows `DELIVERY_REPORTED`).
3. Resolve the incident in the console.

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

## T4 — WhatsApp handoff (phone required)

1. Tick **Also alert via WhatsApp**, send an alert.
2. Pass: WhatsApp opens with one pre-filled chat per responder; tapping send
   delivers real WhatsApp messages. The console's WHATSAPP item turns `SENT`
   (= handed off) after the report; journal wording says "handed to
   WhatsApp", not "delivered".

## T5 — WhatsApp failure path (phone required, one of two ways)

- If WhatsApp is **not** installed: the report arrives as
  `WHATSAPP_NOT_INSTALLED` and the item dead-letters — then re-queue after
  enabling/installing and tap **Check re-queued deliveries** (it picks up
  both SMS and WHATSAPP re-queued items).
- Or simulate it API-side: `Send-CasDeviceReceipt -IncidentId <id> -Channel
  WHATSAPP -Recipient "+1555000111" -Ok:$false -ErrorText WHATSAPP_NOT_INSTALLED`.

Pass: `DEAD_LETTER` with masked recipient; recovery via re-queue → `SENT`.

## T6 — XMPP through the provider sink (API only)

```powershell
Clear-CasProviderInbox
Invoke-CasTrigger          # note the incident id
Watch-CasOutbox -IncidentId <id>
Get-CasProviderInbox
```

Pass: the incident's XMPP item turns `SENT` within ~15 s (one worker tick),
and the inbox shows a `chat` stanza whose `stanzaId` equals the
`Idempotency-Key` (`<incident>-xmpp:<recipient>`). Resolve the incident.

## T7 — Email through the provider sink (API only)

Same as T6. Pass: EMAIL item → `SENT`; inbox entry carries
`to`, `from`, `subject` = `CAS P1 alert <incident id>`, and the alert body.

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

## Report-back template

```text
CAS handoff test run — <date> <operator>
Server URL: <...>   App version: <0.4.0-mvp?>
T0 preflight:        PASS/FAIL — <notes>
T1 build/install:    PASS/FAIL — <versionName seen>
T2 real SMS:         PASS/FAIL — <responder received? console state? incident id>
T3 SMS dead-letter:  PASS/FAIL — <journal sequence seen>
T4 WhatsApp handoff: PASS/FAIL/SKIP — <chats opened? console state?>
T5 WhatsApp failure: PASS/FAIL/SKIP — <error code seen>
T6 XMPP sink:        PASS/FAIL — <stanzaId seen>
T7 email sink:       PASS/FAIL — <subject seen>
T8 failure honesty:  PASS/FAIL — <replay:true seen?>
T9 no-data fallback: PASS/FAIL/SKIP — <SMS arrived with data off?>
Console UI check:    incidents page showed all four transport chips with matching states? Y/N
Blockers/questions:  <...>
```

Paste the filled template plus any failing command output back to the
workspace chat.
