---
name: Browser-testing the credentialed CAS console
description: Real-browser proofs of the CovertAlertSystem console need a pre-seeded enrolled credential or protected screens render nothing.
---

Every CovertAlertSystem console read (not just mutations) requires an enrolled per-device credential held in browser sessionStorage; without one, the app shows an enrollment prompt and its background polling silently does nothing.

**Why:** anonymous console reads were retired for self-hosting, so a real-browser proof that only loads the page cannot see the screens it is meant to verify — drift, lock, and error proofs look like no-ops.

**How to apply:** when a task asks to prove a console error/lock/drift screen in a real browser (directly or via the testing subagent), first enroll a throwaway device credential through the API using the alert token, seed it into sessionStorage before page scripts run (Playwright addInitScript), and revoke the credential afterwards so the dev DB does not accumulate live credentials. The exact endpoints and storage key live in the console/api code — grep for them instead of trusting a copied recipe.
