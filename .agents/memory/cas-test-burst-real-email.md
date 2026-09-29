---
name: Test bursts email real responders when SMTP secrets are live
description: Automated suites/task-agent runs hit the live dev server+DB; with real SMTP configured every incident emails real responders, and rows are wiped after
---

Once real SMTP secrets (CAS_EMAIL_SMTP_*) exist on the dev server, ANY process that creates incidents — including automated test suites run by task agents in this workspace — sends REAL email to every enabled responder. Symptom: inbox bursts of distinct incidents seconds apart, then the incident/outbox rows are wiped (suite teardown), leaving only the recipient's mailbox as evidence.

**Why:** the dev sink only intercepts channels whose credentials are ABSENT; configured secrets route delivery for real, and suites share this workspace's dev DB/server.

**How to apply:**
- The `seed-email-1` row's provenance is solved: it was NOT external. The retired `ensureCasRespondersSeeded` first-read migration (removed from cas-delivery-config.ts) copied `CAS_*_RECIPIENTS` env secrets into ENABLED responder rows on the first console load — the `seed-*` ids were deterministic (`seed-<transport>-<n>`), which is why no workspace source matched a real address. Responder rows can now only be created by an authenticated operator POST; env lists are a delivery-time fallback only. A cas-config.test.ts guard fails if env-backed reads ever create rows again.
- The legacy disabled seed-* rows may still exist in the dev DB (safe while disabled; only an explicit console PATCH can re-enable). On any inbox flood, check `cas_responders` for enabled rows and disable the offender (`enabled=false`) as the instant stop.
- Durable guard is the test-delivery-safety work (suites forced to sink + disposable DB). Until it lands, expect a burst whenever agent-driven suites run.
