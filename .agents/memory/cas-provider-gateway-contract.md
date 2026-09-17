---
name: CAS provider gateway contract
description: Safety invariants CAS alert-delivery adapters must keep when talking to external SMS/XMPP providers.
---

CAS outbox delivery adapters enforce a provider contract that future changes must not weaken:

- A provider "already seen this idempotency key" response only counts as delivered when it explicitly confirms a replay; an ambiguous duplicate response is a permanent rejection, not success. Treating it as success silently loses alerts.
- Provider endpoints must be HTTPS; plain HTTP is acceptable only for loopback test stubs.
- Redirects are never followed: some redirects drop the POST body (faking delivery), others can forward alert content and credentials to an unintended origin.

**Why:** these are alert-delivery safety properties — weakening them can mark an undelivered alert as sent or disclose alert content off-origin.

**How to apply:** any change to provider submission, response classification, or URL handling must keep these invariants and their contract tests passing; extend the tests when adding new provider behaviors.
