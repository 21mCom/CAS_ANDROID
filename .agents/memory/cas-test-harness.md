---
name: CAS test harness
description: Multi-process API integration tests need generous startup polling, awaited child shutdown, and explicit server/pool teardown per suite.
---

Every route-suite test file must end with `after(async () => { ...; server.close(); await once(server, "close"); await pool.end(); })` (see cas.test.ts). Without it the `tsx --test` process can linger after the last assertion, and a `pnpm run test` chain looks hung for tens of minutes with no output.

**Why:** a new suite missing the teardown made the contract-test chain stall silently; standalone reruns of both the new suite and the "hung" following suite passed in seconds.

**How to apply:** when adding a `src/routes/*.test.ts` suite, copy cas.test.ts's listen/close scaffolding verbatim, register the suite in the `test:direct` &&-chain, and give it a top-of-file `process.env.CAS_ALERT_TOKEN ??=` plus an enrolled suite credential.


Multi-process CAS tests must allow for cold API startup and await spawned process exits during cleanup.

**Why:** Parallel child API processes can take longer than a one-second readiness window, and signaling without awaiting exit leaves the test runner hanging.

**How to apply:** Keep process readiness polling tolerant of cold starts, capture failures clearly, and await every child exit in both success and timeout cleanup paths.

GitHub-hosted runners boot the spawned child API process fast: the live-secrets burst canary completes in ~2.5s there, far under the 60s readiness window the cold local tsx boot needed (verified green on the first real CI runs, 2026-09-29). Do not widen the window based on local timing alone.

Credential-gate 401s are delayed by a per-IP tarpit whose streaks are process-global and never reset mid-run (successes don't clear them, decay needs 10 quiet minutes), and every test request shares 127.0.0.1 — so any suite that strings intentional rejections must neutralize the schedule or it accumulates minutes of sleep.

**Why:** with the production schedule (250ms doubling, 30s cap) a file with ~13 intentional 401s adds minutes of delay.

**How to apply:** such suites set a near-zero failure-limit config near env setup; tarpit behavior tests install a measurable schedule, capture bursts via the injectable burst sink (not log scraping), and restore in finally.

Outbox rows created in one transaction (e.g. the SMS and XMPP pair from a trigger) share the exact same created_at, so the worker's ORDER BY created_at claim is nondeterministic between siblings.

**Why:** Tests that assume a specific sibling is claimed first flake or assert against the wrong row.

**How to apply:** In outbox worker tests, pin claim order explicitly — hold non-target siblings back with a future next_attempt_at instead of relying on created_at ordering.

DB-touching suites REFUSE to boot outside the contract runner: a shared boot guard requires the runner's disposable-database markers and validates DATABASE_URL against them, so a direct `tsx --test` run fails loudly instead of writing to the dev database.

**Why:** an automated suite once ran against the dev DB with live SMTP secrets in the environment and emailed real responders ~20 times.

**How to apply:** always run DB suites via the contract runner; never hand a suite the dev DATABASE_URL. New DB-touching suites must invoke the shared boot guard at module top, before any credential issuance. The guard must fail closed: the harness flag alone is trivially forgeable by hand, so every runner marker is mandatory, not optional.

In test runs, the app's default delivery wiring forces every provider channel onto the in-process dev sink and the scheduled mailbox health probe is skipped, regardless of configured secrets. Suite-spawned child API processes inherit the markers, so their workers are forced too.

**Why:** the sink only caught gateway channels when credentials were absent; with live secrets configured, tests sent for real.

**How to apply:** when adding a delivery path, route it through the default sender wiring so the forcing covers it. Keep the forcing at the app-wiring layer, not inside the config loader — unit tests drive the loader directly with fixture envs.

Ambient workspace provider secrets leak into test processes and would arm the real channels — the delivery forcing is the control, not per-suite env hygiene.

**Why:** before the guard/forcing existed, the leak made provider-channel assertions fail identically on an unmodified tree, mimicking a regression — and in the field-test incident it is what armed the real sends.

**How to apply:** never treat ambient secrets as absent in tests.
