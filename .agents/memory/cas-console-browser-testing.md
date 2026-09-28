---
name: Browser-testing the credentialed CAS console
description: How to drive the credential-gated CovertAlertSystem console in Playwright/testing-subagent proofs without the enrollment prompt.
---

To run real-browser proofs against the CovertAlertSystem console (web artifact) + API server:

- Enroll a device credential from the shell: `POST $REPLIT_DEV_DOMAIN/api/cas/devices/enroll` with `authorization: Bearer $CAS_ALERT_TOKEN` (env var, never print) and body `{"label": "..."}` (label is REQUIRED; a bare `{}` fails validation with `error`/`issues`).
- Seed the browser before page scripts run: `page.addInitScript` → `sessionStorage.setItem('cas-device-token', token)`. Key is `cas-device-token`. This skips the enrollment `window.prompt` entirely; the real token lets the main `/api/cas/state` load succeed so the app shell renders.
- Inject drifted/outage responses with Playwright `page.route('**/api/cas/<path>', ...)` fulfilled as HTTP 200 JSON with one wrong-typed field — the console's Zod mirrors reject it and render the visible red drift UI.
- Cleanup: revoke enrolled credentials afterwards via `POST /api/cas/devices/<id>/revoke` with the enrollment credential, or they accumulate in the dev DB.

**Why:** every console read is credential-gated (anonymous reads were retired), and the outbox poll silently skips when no token is in sessionStorage — without enrollment seeding, drift proofs show nothing.

**How to apply:** any task asking to prove console error/lock/drift screens in a real browser (e.g. the mid-session credential-lock browser proof) — the testing subagent can do all of this itself if told this recipe.
