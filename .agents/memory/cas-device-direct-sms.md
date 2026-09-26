---
name: CAS device-direct SMS mode
description: SMS is the only device channel; every other channel, WhatsApp included, is delivered server-side so a held phone never flashes alert UI. Contract and invariants of that split.
---

CAS alert delivery splits channels two ways:

- **Device channels** (default SMS only): the alerting handset delivers them itself over its own SIM and reports outcomes back through the device-receipt endpoint.
- **Gateway channels** (everything else, WhatsApp included): delivered by the server-side outbox worker through provider adapters configured via `CAS_<CHANNEL>_PROVIDER_URL` + `_RECIPIENTS` (+ optional `_TOKEN`).

Durable decisions (do not weaken without a deliberate threat-model change):

- **No-screen-flash rule**: if an attacker is holding the phone, nothing alert-related may appear on screen. So no alert path on the device may start a visible activity besides the configured cover app, and device sources must carry no reference to any handoff messenger. The on-screen WhatsApp handoff (wa.me deep link with pre-filled message) was removed for exactly this reason.
- **Server-side fan-out also limits capture damage**: responder-provider credentials (e.g. WhatsApp Cloud API token) live only in server env, never on the handset.
- **Retired-channel compatibility**: the receipt and trigger APIs keep retired device-channel names in their enums so old APKs get a loud 409 ("not an enabled device channel") instead of an opaque 400; the handset then still sends its SMS directly. Listing a retired channel in the device-channels env var is a hard config error (fail closed).
- **Providers without an idempotency contract (WhatsApp Cloud API) need durable dedup on our side**: per-recipient acceptance is persisted, and a retried send skips recipients already recorded as accepted. A crash between the provider's 2xx and the ledger write can still produce one duplicate — that residual risk is accepted and documented, not hidden. Provider payloads must stay strictly within the provider's published schema (Meta rejects unknown fields; the sender phone-number ID belongs in the endpoint path).

**Why:** the owner chose device-direct SMS to avoid gateway subscriptions and keep alerts working with SMS-only signal; the no-screen rule comes from the attack scenario, not from UX preference.

**How to apply:** any new alert channel must default to server-side delivery; device-side delivery requires explicit justification against the no-screen-flash rule. When integrating a provider, check whether it honors an idempotency contract *before* relying on one, and prove the payload against a strict mock of the real API, not a permissive stub.
