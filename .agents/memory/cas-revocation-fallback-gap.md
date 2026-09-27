---
name: CAS revocation fallback gap (closed server-side)
description: The shared-device-token fallback is retired server-side once any credential row exists, so a revoked handset cannot resume with the shared token — the handset-side gap below is moot but documented for history.
---

RESOLVED (server-side): requireDeviceAccess now refuses the shared
CAS_DEVICE_TOKEN once any device credential exists (revocation keeps the
row), so the handset-side reset described below can no longer bypass
revocation. The handset-side description remains as historical context for
why the server gate exists.

Known revocation-boundary gap in the CAS test handset app: MainActivity's
"Save alert credential" handler clears the enrolled token AND resets the
provisioned flag the moment a *different* credential is typed — before that
credential is verified. DeviceSmsSender then falls back to the still-stored
shared device token (X-CAS-Device-Token) for device-pending pickup and
receipts, and the server's requireDeviceAccess accepts shared-token-only
requests by design (legacy handsets). Net effect: someone holding a revoked
phone can enter an arbitrary string and resume mutating delivery state.

**Why:** the provisioned flag was made resettable on input save to allow
deliberate re-enrollment, but that re-enables the legacy fallback for
unverified input.

**How to apply (fix direction from review):** keep the provisioned flag
sticky until a *successful, authenticated* re-enrollment completes — never
re-enable the legacy fallback on mere input save. Longer term: retire or
explicitly cut over shared-token auth for pickup/receipts on deployments
that use revocable per-device credentials, and test that a revoked handset
cannot use shared-token-only requests or resume after entering an invalid
enrollment credential. Regression coverage exists only for
revoked-Bearer-plus-shared-token, not this fallback path.
