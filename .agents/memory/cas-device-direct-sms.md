---
name: CAS device-direct SMS mode
description: The alerting handset, not a server gateway, delivers device channels (SMS, WhatsApp) when CAS_SMS_DELIVERY_MODE=device; contract and invariants of that mode plus the dev provider sink.
---

CAS alert delivery splits channels two ways:

- **Device channels** (`CAS_DEVICE_CHANNELS`, comma-separated, default `SMS`; supported: SMS, WHATSAPP) apply when `CAS_SMS_DELIVERY_MODE=device`: the Pixel handset delivers them itself and reports outcomes back. SMS goes over the handset's SIM; WHATSAPP is tap-to-send handoff into the official app (the free WhatsApp app has no unattended-send API), so a SENT WhatsApp item means "handed to WhatsApp", not delivery-confirmed.
- **Gateway channels** (XMPP, EMAIL, and SMS in gateway mode) are delivered by the outbox worker through provider adapters configured via `CAS_<CHANNEL>_PROVIDER_URL` + `_RECIPIENTS` (+ optional `_TOKEN`/`_FROM`). The trigger route only queues outbox items for channels that can deliver (enabled device channels + configured providers) — an unconfigured channel must never create a row that can only dead-letter.

Invariants (do not weaken without updating the contract tests in `cas.test.ts`):

- The worker must never claim device-channel transports in device mode; a server-side claim could only fail "not-configured" and would race the handset's receipt.
- `POST /api/cas/incidents/:id/device-receipt` (body: `channel`, `results`) is the only transition for device items: all-ok → SENT, any failure → immediate DEAD_LETTER (no server retry; recovery = fix config on handset → console re-queue → handset picks up from `GET /api/cas/outbox/device-pending` → re-send → receipt). The legacy `/sms-receipt` route is a fixed-SMS alias so old APKs cannot cross channels.
- Receipts are replay-safe (duplicate receipt for a SENT item → 200, no re-journal) and rejected (409) in gateway mode or for a channel not in CAS_DEVICE_CHANNELS.
- The handset endpoints require the shared token (`X-CAS-Device-Token` vs `CAS_DEVICE_TOKEN`): fail-closed 503 when unset, 401 on mismatch — a forged receipt could otherwise mark an unsent alert SENT.
- The trigger queues only the handset's requested∩enabled device channels (body `deviceChannels`; omitted = all enabled; unknown → 400, not-enabled → 409) plus provider-configured gateway channels — never an undeliverable row. The handset must honor `reused: true` by not re-sending physically (fold-in queues nothing new).
- Responder numbers are masked (last 2 digits) in the journal and outbox lastError. Full numbers travel only in the receipt POST body to the owner's own console over HTTPS; the handset's own number never leaves the device.
- A QUEUED device item with no receipt means the handset has not reported (possibly no data) — the stuck-pipeline warning staying lit is intentional honesty, not a bug.
- The handset sends the alert SMS even when the trigger POST fails (no-data fallback).

**Dev provider sink:** when `NODE_ENV != production` and `CAS_DEV_PROVIDER_SINK=1`, the API mounts `/api/cas/dev/provider-inbox` (POST per channel honoring the idempotency-replay contract, GET/DELETE to inspect/clear). Point `CAS_XMPP_PROVIDER_URL`/`CAS_EMAIL_PROVIDER_URL` at its loopback URLs to prove the gateway path without third-party accounts; the Windows handoff kit's drills assert against it. Never enable in production.

**Why:** the owner chose device-direct to avoid gateway subscriptions and to keep alerts working with SMS-only signal; these rules keep the console's durable ledger truthful without a server-side sender.

**How to apply:** any change to outbox claiming, the receipt/pending endpoints, channel queueing in the trigger route, or the Android `DeviceSmsSender`/`WhatsAppAlerter` must preserve the above; the gateway-mode provider contract (cas-provider-gateway-contract.md) still applies unchanged to gateway adapters.
