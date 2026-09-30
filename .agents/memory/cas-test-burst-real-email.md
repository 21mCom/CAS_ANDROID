---
name: Test bursts email real responders when SMTP secrets are live
description: Automated suites/task-agent runs hit the live dev server+DB; with real SMTP configured every incident emails real responders, and rows are wiped after
---

Once real SMTP secrets (CAS_EMAIL_SMTP_*) exist on the dev server, ANY process that creates incidents — including automated test suites run by task agents in this workspace — sends REAL email to every enabled responder. Symptom: inbox bursts of distinct incidents seconds apart, then the incident/outbox rows are wiped (suite teardown), leaving only the recipient's mailbox as evidence.

**Why:** the dev sink only intercepts channels whose credentials are ABSENT; configured secrets route delivery for real, and suites share this workspace's dev DB/server.

**How to apply:**
- Responder rows must only ever be created by an authenticated operator action; the `CAS_*_RECIPIENTS` env lists are a delivery-time fallback, never a source of responder rows (a retired first-read seed once copied them into ENABLED rows holding real addresses). A cas-config.test.ts guard fails if env-backed reads ever create rows again.
- On any inbox flood, check `cas_responders` for enabled rows and disable the offender (`enabled=false`) as the instant stop; legacy disabled `seed-*` rows are safe while disabled.
- Durable guard is the test-delivery-safety work (suites forced to sink + disposable DB). Until it lands, expect a burst whenever agent-driven suites run.
