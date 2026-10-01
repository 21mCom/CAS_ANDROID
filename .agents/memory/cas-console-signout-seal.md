---
name: Sealing the CAS console on sign-out
description: Console sign-out must invalidate in-flight requests via a generation guard; clearing storage and resetting state alone lets a held response re-open the sealed console.
---

Signing the CAS console browser out takes three layers, and skipping any of them leaves a privacy hole:

1. Clear the credential from BOTH browser stores (session + persisted).
2. Unmount the shell/routes immediately and keep them hidden until a state load authenticates with a fresh credential (a `signedOut` gate rendering a blank backdrop) — route components hold their own fetched data (responder lists, email settings) in local state, so resetting only provider state leaves that data visible.
3. Bump an authentication generation and have every state-applying callback capture it before its request and compare after. Without this, a state response held from before sign-out lands afterwards, clears the lock, and re-opens the console while no credential is stored.

**Why:** a completion review reproduced both bypasses in Chromium with intercepted API responses: (a) sign-out from a data page left route-local data mounted behind the enrollment dialog, and (b) a held previous-session state response released after sign-out + enrollment cancellation dismissed the locked surface and restored incident data with empty credential stores.

**How to apply:** any new credentialed fetch flow in the console must apply its results only through a generation-checked path (the shared reload), and any new session-teardown action must bump the generation. When writing browser proofs for sign-out, delay the previous session's *state response* (not just re-enrollment) and assert the console stays sealed.
