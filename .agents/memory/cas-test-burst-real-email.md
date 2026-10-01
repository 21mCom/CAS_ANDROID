---
name: Test bursts email real responders when SMTP secrets are live
description: With real SMTP secrets on the dev server, any process that creates incidents emails real responders; suites are now forced onto the dev sink + a disposable DB
---

Once real SMTP secrets (CAS_EMAIL_SMTP_*) exist on the dev server, ANY process that creates incidents sends REAL email to every enabled responder — including automated test suites run by task agents in this workspace. Symptom during the incident: inbox bursts of distinct incidents seconds apart, then the incident/outbox rows are wiped by suite teardown, leaving only the recipient's mailbox as evidence.

**Why:** the dev sink only intercepts channels whose credentials are ABSENT; configured secrets route delivery for real, and suites historically shared this workspace's dev DB/server.

**How to apply:**
- Never run a DB-touching suite against the dev DATABASE_URL; the contract runner's disposable database plus the per-suite boot guard (assertDisposableTestDatabase) is the only sanctioned path. If a suite lacks the guard, add it before running anything.
- The `seed-email-1` row's provenance is solved: it was NOT external. The retired first-read migration (`ensureCasRespondersSeeded`, removed from cas-delivery-config.ts) copied `CAS_*_RECIPIENTS` env secrets into ENABLED responder rows on the first console load — the `seed-*` ids were deterministic (`seed-<transport>-<n>`), which is why no workspace source matched a real address. Responder rows can now only be created by an authenticated operator POST; env lists are a delivery-time fallback only. A cas-config.test.ts guard fails if env-backed reads ever create rows again.
- Legacy disabled `seed-*` rows may still exist in the dev DB (safe while disabled; only an explicit console PATCH can re-enable). On any inbox flood, check `cas_responders` for enabled rows and disable the offender (`enabled=false`) as the instant stop.
- Durable guard HAS LANDED: the test-delivery-safety work (suites pointed at a disposable DB, with `assertDisposableTestDatabase()` refusing to boot against anything else) is in the tree, so agent-driven suite runs no longer burst real responders. If a burst recurs, look for a suite that bypasses the guard or a live dev-server process created the incident outside any suite.
