---
name: CAS alert API credential gate
description: CAS mutation endpoints require per-device enrolled credentials; the shared CAS_ALERT_TOKEN is enrollment-only (enroll/list/revoke) and fails closed when unset.
---

Every CAS mutation endpoint requires `Authorization: Bearer <per-device token>` issued by `POST /cas/devices/enroll`. The shared `CAS_ALERT_TOKEN` secret only authorizes device-credential management — presenting it to a mutation gets a distinct 401 reason (`enrollment-token-not-authorized`).

**Why:** a single shared token made a leaked phone/console session uncontainable (rotate-everywhere) and unattributable. Only SHA-256 hashes of device tokens are stored (`cas_device_credentials`); the plaintext is returned once at enrollment.

**How to apply:**
- The revocation-bypass lesson (a code review caught this): any client that retains the enrollment credential can silently re-enroll after revocation, defeating it. Provisioned devices must DISCARD the enrollment credential after enrolling, must never auto re-enroll on a 401, and regaining access must be a trusted operator action (re-entering the credential). When adding a new enrolled client, prove two successive post-revocation requests both 401 and that no new credential was issued in between.
- Endpoints a revoked device must not keep using (e.g. the handset receipt/pickup endpoints) must treat a presented enrolled Bearer credential as authoritative — no fallback to a legacy shared token when the Bearer is revoked — or revocation is bypassable there.
- The handset's `provisioned` flag must stay sticky from one successful enrollment to the next: it may only be set (never cleared) on enrollment success, and the enrolled token may only be dropped on a server 401. Clearing either when an unverified credential is saved re-enables the shared-token fallback, so a revoked phone resumes pickup/receipts. `.github/scripts/check-revocation-boundary.sh` statically enforces this; the flag must not become resettable on input save again.
- Revocation is per-request: the gate reads `cas_device_credentials` on every call and never caches. Keep it that way — do not add an auth cache.
- The gate fails closed at both layers: `CAS_ALERT_TOKEN` unset disables enrollment (401 `server-not-configured`); no enrolled rows means all mutations 401. Already-enrolled devices keep working with the secret unset.
- Enrolled device tokens must NOT pass the enrollment gate (a leaked device token must not mint more credentials).
- Changing android-test-package sources stales the committed MVP handoff ZIP (the mvp-handoff-freshness CI job enforces a repack).
- Express 5 quirk: inserting a pre-typed middleware (`RequestHandler`) into a `router.post("/path/:id", mw, handler)` chain widens `req.params.id` to `string | string[]`; annotate the handler as `Request<{ id: string }>` rather than casting.
- Rejections are recorded via `setCasAuthRejectionRecorder` without the presented token; revoked-token rejections also carry the device id.
- Tarpit failure streaks live in the shared `cas_auth_failure_streaks` table (atomic upsert), never in process memory, so multiple API replicas enforce one streak per IP. **Why:** process-local streaks let a guesser's failures dilute across replicas. **How to apply:** never reintroduce in-process streak state; the rejection path must never 500 on a streak-store failure (it degrades to an undelayed 401 + warn line), and `resetCasAuthFailureTracking` is async.
