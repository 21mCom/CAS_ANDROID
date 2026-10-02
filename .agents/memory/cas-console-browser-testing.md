---
name: Browser-testing the credentialed CAS console
description: Real-browser proofs of the CovertAlertSystem console need a pre-seeded enrolled credential or protected screens render nothing.
---

Every CovertAlertSystem console read (not just mutations) requires an enrolled per-device credential held in browser storage; without one, the app opens the in-app enrollment dialog and its background polling silently does nothing.

**Why:** anonymous console reads were retired for self-hosting, so a real-browser proof that only loads the page cannot see the screens it is meant to verify — drift, lock, and error proofs look like no-ops.

**How to apply:** when a task asks to prove a console error/lock/drift screen in a real browser (directly or via the testing subagent), first enroll a throwaway device credential through the API using the alert token, seed it into sessionStorage before page scripts run (Playwright addInitScript), and revoke the credential afterwards so the dev DB does not accumulate live credentials. The exact endpoints and storage key live in the console/api code — grep for them instead of trusting a copied recipe.

**The disposable-DB environment disables the mailbox probe worker.** `runWithDisposableReviewDatabase` exports `NODE_ENV=test` + `CAS_TEST_DISPOSABLE_DB=1`, and under either the api-server skips `startCasEmailHealthWorker` entirely. A browser proof of probe health must clear both markers in the api-server spawn env (safe only because no proof triggers a delivery) and blank `CAS_EMAIL_SMTP_HOST`/`CAS_EMAIL_PROVIDER_URL` so pre-save ticks skip instead of AUTHing the real mailbox on a fast cadence.

**Harness helper servers must not live in the harness process.** `runWithDisposableReviewDatabase`'s `run()` is spawnSync, so the harness event loop is frozen for the whole Playwright run — an in-process fake server connects but never answers (probes surface as socket-timeout, not the expected classification). Spawn helper servers as child processes (see the fake SMTP server pattern in the browser-proof harness).

**The anti-guessing backoff delays the lock surface.** Rejected-credential 401s are held per client IP with a doubling delay capped at 30s (casAuthFailureDelayMs in cas-auth.ts; the first rejection is free), and the console's own outbox polling keeps the streak warm. A browser proof that checks for the locked surface ~500ms after the failing action sees nothing; assert with a generous timeout (the committed Playwright proof uses 150s). Side effect worth remembering: after a real revocation, the operator can keep seeing stale incident data for tens of seconds before the lock appears.

**A proof that triggers an incident must clear EVERY gateway provider env var.** The browser-proof harness runs the api-server with NODE_ENV=production and the disposable-DB marker off, so test-sink delivery forcing is OFF; the trigger endpoint queues every gateway transport that is provider-configured (endpoint URL + recipients), and the live outbox worker would then contact the real provider. Clearing only CAS_EMAIL_* is not enough — workspace env made XMPP deliverable and a trigger queued a real XMPP row. The harness now blanks all four transports' CAS_*_PROVIDER_URL/TOKEN/FROM/RECIPIENTS plus the SMTP variables; extend that list if GATEWAY_TRANSPORTS ever grows.

**Browser executable:** the workspace has no Playwright-managed browser download; run the harness with CAS_E2E_CHROMIUM_PATH=/repl/tools/bin/chromium (Chromium 152 works with the suite's Playwright).

**The proof suite shares one disposable DB, and the state endpoint selects the newest incident row (even RESOLVED) as the console's active incident.** A proof that creates an incident (even the "Record test event" button) silently re-targets every later proof that expects the seeded incident. Prefer mutation-free setups (e.g. hold a state response across a page reload) or clean up created rows in a finally block.

**Simulating a browser restart needs an init-script gate.** Playwright `addInitScript` re-runs on EVERY navigation, so a script that seeds sessionStorage re-seeds it after `page.reload()` and the "restart" never happens. Gate the seed on a marker (e.g. a localStorage flag the test flips when it clears sessionStorage) before reloading.

**Proofs asserting inline media rendering must upload real decodable bytes.** The evidence upload endpoint stores whatever bytes it gets; the race-guard specs use fake "jpeg" bytes because they never render them. A proof that clicks View and asserts the blob-URL `<img>` must upload a real encoded image and assert `naturalWidth > 0` — a visible `<img>` element alone does not prove the bytes decoded.

**New console UI must keep entity ids out of visible text and test ids unique across panels.** Existing proofs match incident ids with `getByText(...)`; any NEW element rendering the same id as text (e.g. a `<select>` option label) turns those matches into strict-mode violations, and the cascade is ugly (the lock spec fails before its ack, so a later trigger proof sees 200-reused instead of 201). Likewise, when the same entity can render in two panels at once (a clip appears in both the current-alert panel and the past-alert browser), shared `data-testid`s become strict-mode violations too — pass a testIdPrefix prop so each panel's ids are distinct, and write spec locators with the prefix.
