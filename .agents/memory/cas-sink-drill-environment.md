---
name: CAS sink drill environment
description: Why T4/T6/T7 sink drills in this workspace need a standalone no-SMTP api-server instance, and how to run one safely.
---

This workspace has real `CAS_EMAIL_SMTP_*` secrets set, so the EMAIL outbox adapter picks direct SMTP (`deliveredTo=smtp:<host>`) and the T7 sink drill sends REAL alert emails to the real recipient list instead of the dev sink. There is no console primary mailbox (cas_email_accounts empty); the env secrets alone cause this.

**Why:** A routine T4/T6/T7 drill run against the main api-server sent live emails. The SIMULATED label only appears when delivery goes through the dev provider sink (`deliveredTo=dev-sink`).

**How to apply:** To run the kit's sink drills (HANDOFF-TEST-KIT.md T4/T6/T7) faithfully here: stop the managed `artifacts/api-server` workflow (its outbox worker would otherwise race to claim items and send via SMTP), then start a standalone instance with `env -u CAS_EMAIL_SMTP_HOST -u CAS_EMAIL_SMTP_USER -u CAS_EMAIL_SMTP_PASSWORD PORT=8099` and all three `CAS_*_PROVIDER_URL` pointed at `http://127.0.0.1:8099/api/cas/dev/provider-inbox/<channel>` (the `.replit` URLs point at the managed instance's port, so they must be overridden). `CAS_EMAIL_FROM` no longer needs to be set by hand — the `.replit` shared env now pins it (`cas-alerts@responder.example`, matching the XMPP from-JID precedent), so the sink's email payload always carries the `from` the kit doc promises. Also: a trigger queues the handset SMS item too, so `Watch-CasOutbox` always runs to its timeout on API-only drills unless you simulate the handset receipt with `Send-CasDeviceReceipt`; the drill pass criteria are per-channel, so the timeout warning is cosmetic.
