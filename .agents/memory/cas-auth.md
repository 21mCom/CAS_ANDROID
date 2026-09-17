---
name: CAS alert API credential gate
description: The CAS trigger/ack/resolve/re-queue endpoints require a Bearer token (CAS_ALERT_TOKEN secret); fail-closed when unset.
---

CAS alert mutations (POST incidents/trigger, incidents/:id/ack, incidents/:id/resolve, outbox/:id/requeue) require `Authorization: Bearer <CAS_ALERT_TOKEN>`.

**Why:** anyone who could reach the server URL used to be able to create P1 incidents or mutate responder state.

**How to apply:** when gating an endpoint, also sweep every non-test caller — the debug SMS-flow activity, the emulator CI harness/workflow env, and the PowerShell drill script each authenticate separately and silently break with 401s if missed; the committed handoff ZIP must be repacked afterwards or operators get a pre-gate build.

**Why:** anyone who could reach the server URL used to be able to create P1 incidents or mutate responder state.

**How to apply:**
- With CAS_ALERT_TOKEN unset the server fails closed (401 on every guarded request) and logs a boot warning — a "broken" console after a redeploy usually means the secret is missing.
- The web console keeps the token in sessionStorage (entered via prompt on first mutation; a 401 clears it and re-asks). The Android MVP app stores it in device-protected SharedPreferences via TestStore.
- Rejections are recorded through an injectable recorder (`setCasAuthRejectionRecorder`) so tests prove the record without scraping logs; the presented token is never logged.
- All console writes are now gated (bootstrap, incidents/test, PATCH setup/gates, gate0a/import too — no harness host posts imports over HTTP; CI validates reports offline via the script). The console routes every mutation through casAuthedFetch, including the first-load bootstrap, which prompts on a fresh server.
- Express 5 quirk: inserting a pre-typed middleware (`RequestHandler`) into a `router.post("/path/:id", mw, handler)` chain widens `req.params.id` to `string | string[]` in the handler. Fix by annotating the handler as `Request<{ id: string }>` — do not "fix" it with `String(...)` casts that hide the drift.
