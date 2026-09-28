---
name: CAS push wake for responder capture requests
description: FCM high-priority data-only messages wake the handset for responder capture requests; polling stays the fallback and the journal records which path honored each request.
---

Responder-requested capture wakes the handset via high-priority, data-only FCM ("cas-capture-request"), which also grants the documented background-start exemption for mic/camera foreground services on an idle phone. The push handler reuses the polling pickup flow (`CaptureRequests.checkPending(via="push")`) so pickup/ack/failure logic stays single-path; the server stores `via` per capture request and journals the wake path ("high-priority push" vs "polling path").

**Why:** responder requests were previously honored only at the handset's next server contact (minutes during a live incident), and idle phones could be denied the background mic/camera start.

**How to apply:**
- The Android kit compiles Firebase Messaging UNCONDITIONALLY; the google-services plugin applies only when `app/google-services.json` (gitignored, deployment-specific) is present at field build. Without it the app must NOT crash — every Firebase call is guarded (`IllegalStateException` → journaled `PUSH_UNAVAILABLE`) and polling remains the wake path. Do not introduce flavors/conditional source sets: AGP cannot conditionally merge a second manifest for the main source set, and flavors break the CI `app-debug.apk` path.
- Server dispatch lives in `artifacts/api-server/src/lib/cas-push.ts` (RS256 JWT → OAuth → FCM HTTP v1, no SDK), configured by `CAS_FCM_SERVICE_ACCOUNT_JSON/_FILE`; it must stay never-throwing, HTTPS-only (loopback exception for test stubs), redirect-refusing (provider-gateway contract), and must skip revoked credentials and prune UNREGISTERED tokens.
- Do NOT surface push fields in `/cas/state` — the console strictly validates that payload; the journal carries the wake path instead.
- Real FCM delivery is unverifiable in this workspace (no Firebase project, no Play Services on the local emulator): server dispatch is proven against loopback stubs, the fallback is proven on the local emulator, and the physical-Pixel proof is handoff drill T10b in HANDOFF-TEST-KIT.md.
