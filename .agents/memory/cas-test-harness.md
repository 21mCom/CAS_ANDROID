---
name: CAS test harness
description: Multi-process API integration tests need generous startup polling and awaited child shutdown.
---

Multi-process CAS tests must allow for cold API startup and await spawned process exits during cleanup.

**Why:** Parallel child API processes can take longer than a one-second readiness window, and signaling without awaiting exit leaves the test runner hanging.

**How to apply:** Keep process readiness polling tolerant of cold starts, capture failures clearly, and await every child exit in both success and timeout cleanup paths.

Credential-gate 401s are delayed by a per-IP tarpit whose streaks are process-global and never reset mid-run (successes don't clear them, decay needs 10 quiet minutes), and every test request shares 127.0.0.1 — so any suite that strings intentional rejections must neutralize the schedule or it accumulates minutes of sleep.

**Why:** with the production schedule (250ms doubling, 30s cap) a file with ~13 intentional 401s adds minutes of delay.

**How to apply:** such suites set a near-zero failure-limit config near env setup; tarpit behavior tests install a measurable schedule, capture bursts via the injectable burst sink (not log scraping), and restore in finally.

Outbox rows created in one transaction (e.g. the SMS and XMPP pair from a trigger) share the exact same created_at, so the worker's ORDER BY created_at claim is nondeterministic between siblings.

**Why:** Tests that assume a specific sibling is claimed first flake or assert against the wrong row.

**How to apply:** In outbox worker tests, pin claim order explicitly — hold non-target siblings back with a future next_attempt_at instead of relying on created_at ordering.

Direct `tsx --test` runs use the shared dev `DATABASE_URL`, so a running api-server workflow's outbox worker (10s tick) claims and settles test rows mid-suite, producing dozens of wrong-incident assertion failures that vanish when rerun.

**Why:** a green-then-red flip with no code change between runs cost a debugging round; the failures looked like real regressions (wrong transport, wrong counts) because the dev worker was delivering test rows to the live sink.

**How to apply:** validate DB-heavy suites via the contract runner (`pnpm --filter @workspace/api-server run test` — disposable review database), or stop the api-server workflow before direct `tsx --test` runs; never trust a direct run's failures while the workflow is up.