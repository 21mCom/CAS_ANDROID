---
name: Browser-testing the credentialed CAS console
description: Real-browser proofs of the CovertAlertSystem console need a pre-seeded enrolled credential or protected screens render nothing.
---

Every CovertAlertSystem console read (not just mutations) requires an enrolled per-device credential held in browser sessionStorage; without one, the app shows an enrollment prompt and its background polling silently does nothing.

**Why:** anonymous console reads were retired for self-hosting, so a real-browser proof that only loads the page cannot see the screens it is meant to verify — drift, lock, and error proofs look like no-ops.

**How to apply:** when a task asks to prove a console error/lock/drift screen in a real browser (directly or via the testing subagent), first enroll a throwaway device credential through the API using the alert token, seed it into sessionStorage before page scripts run (Playwright addInitScript), and revoke the credential afterwards so the dev DB does not accumulate live credentials. The exact endpoints and storage key live in the console/api code — grep for them instead of trusting a copied recipe.

**The anti-guessing backoff delays the lock surface.** Rejected-credential 401s are held per client IP with a doubling delay capped at 30s (casAuthFailureDelayMs in cas-auth.ts; the first rejection is free), and the console's own outbox polling keeps the streak warm. A browser proof that checks for the locked surface ~500ms after the failing action sees nothing; assert with a generous timeout (the committed Playwright proof uses 150s). Side effect worth remembering: after a real revocation, the operator can keep seeing stale incident data for tens of seconds before the lock appears.
