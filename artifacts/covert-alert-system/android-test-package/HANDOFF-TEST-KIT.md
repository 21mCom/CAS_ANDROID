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

Vocabulary:

- **Console** = the CAS web UI at the server URL. **API base** = `<server URL>/api`.
- **Outbox item states**: `QUEUED` → (`PROCESSING`) → `SENT` or `DEAD_LETTER`.
- **SENT means different things per channel** — see the table; report wording
  matters.

## The four alert channels

| Channel | Who delivers | What `SENT` means | Config |
| --- | --- | --- | --- |
| SMS | The Pixel itself, over its own SIM | Handset reported radio success per responder | Responder numbers on the phone; server runs `CAS_SMS_DELIVERY_MODE=device` |
| WHATSAPP | The console's outbox worker → WhatsApp Business Cloud API messages endpoint | Provider accepted the message (HTTPS POST, idempotency-keyed) | `CAS_WHATSAPP_PROVIDER_URL` + `CAS_WHATSAPP_PROVIDER_TOKEN` + `CAS_WHATSAPP_RECIPIENTS` |
| XMPP | The console's outbox worker → configured provider endpoint | Provider accepted the stanza (HTTPS POST, idempotency-keyed) | `CAS_XMPP_PROVIDER_URL` + `CAS_XMPP_RECIPIENTS` |
| EMAIL | The console's outbox worker → configured provider endpoint | Provider accepted the message | `CAS_EMAIL_PROVIDER_URL` + `CAS_EMAIL_RECIPIENTS` |

The handset never opens the WhatsApp app (or any other app) for alerting —
that keeps the screen silent and keeps responder-provider credentials off
the phone entirely, limiting the damage if the phone is captured.

In the current dev deployment, WHATSAPP, XMPP, and EMAIL point at an
in-process **dev provider sink** (`/api/cas/dev/provider-inbox`) that records
exactly what would have been sent — enough to prove the pipeline end-to-end
without any third-party account. Real provider accounts replace the URLs
later; nothing else changes.

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

`scripts\run-mvp-install.cmd` → installs version `0.5.0-mvp` (versionCode 4).
Pass: `adb shell dumpsys package com.covertalert.pixeltest | findstr versionName`
prints `0.5.0-mvp`.

## T2 — Real SMS alert with location (phone required)

1. On the phone: enter the alert server URL and the **device access token**
   (same value as the server's `CAS_DEVICE_TOKEN` secret), then responder
   number(s), **Save responder numbers**, **Grant SMS permission**, **Grant
   location permission**.
2. **Send MVP alert now**. Pass: the responder's phone receives the SMS from
   the Pixel's own number; the on-screen report shows `MVP_ALERT_OUTCOME`
   SENT then `SMS_SEND_OUTCOME` delivered=1; the console incident's SMS item
   turns `SENT` within seconds (journal shows `DELIVERY_REPORTED`).
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
Watch-CasOutbox -IncidentId <id>
Get-CasProviderInbox
```

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
Server URL: <...>   App version: <0.5.0-mvp?>
T0 preflight:        PASS/FAIL — <notes>
T1 build/install:    PASS/FAIL — <versionName seen>
T2 real SMS:         PASS/FAIL — <responder received? console state? incident id>
T3 SMS dead-letter:  PASS/FAIL — <journal sequence seen>
T4 WhatsApp sink:      PASS/FAIL — <messaging_product/idempotency key seen>
T5 WhatsApp off-phone: PASS/FAIL — <409 seen? pending list SMS-only?>
T6 XMPP sink:        PASS/FAIL — <stanzaId seen>
T7 email sink:       PASS/FAIL — <subject seen>
T8 failure honesty:  PASS/FAIL — <replay:true seen?>
T9 no-data fallback: PASS/FAIL/SKIP — <SMS arrived with data off?>
Console UI check:    incidents page showed all four transport chips with matching states? Y/N
Blockers/questions:  <...>
```

Paste the filled template plus any failing command output back to the
workspace chat.
