---
name: CAS alert API credential gate
description: The CAS alert-mutation endpoints require a Bearer token (CAS_ALERT_TOKEN secret) and fail closed when it is unset.
---

Every CAS mutation endpoint requires `Authorization: Bearer <CAS_ALERT_TOKEN>`.

**Why:** anyone who could reach the server URL used to be able to create P1 incidents or mutate responder state; rejections are recorded without logging the presented token.

**How to apply:**
- With CAS_ALERT_TOKEN unset the server fails closed (401 on every guarded request) — a "broken" console after a redeploy usually means the secret is missing.
- When gating an endpoint, sweep every non-test caller too — the debug SMS-flow activity, the emulator CI harnesses, and the PowerShell drill script each authenticate separately and silently break with 401s if missed; repack the committed handoff ZIP afterwards or operators get a pre-gate build (the mvp-handoff-freshness CI job enforces this).
- The web console keeps the token in sessionStorage (a 401 clears it and re-asks); the Android app stores it in device-protected SharedPreferences.
- Express 5 quirk: inserting a pre-typed middleware (`RequestHandler`) into a `router.post("/path/:id", mw, handler)` chain widens `req.params.id` to `string | string[]`; annotate the handler as `Request<{ id: string }>` rather than casting.
