---
name: CAS provider gateway contract
description: Safety invariants the CAS SMS/XMPP delivery adapters must keep when talking to external providers.
---

The CAS outbox delivery adapters (`artifacts/api-server/src/lib/delivery-providers.ts`) enforce a provider contract that future changes must not weaken:

- A provider 409 only counts as delivered when it carries `X-Idempotency-Replayed: true`; any other 409 is a permanent "rejected" failure. Treating bare 409 as success silently loses alerts.
- Provider endpoints must be HTTPS; plain HTTP is allowed only for loopback test stubs.
- Redirects are never followed (`redirect: "manual"` + permanent failure on 3xx): 301/302 can drop the POST body and fake delivery, 307/308 can forward alert content and bearer credentials to a cleartext origin.

**Why:** two completion-code-review rejections found that bare-409 acceptance and default redirect following could mark an undelivered alert as SENT or disclose alert content.

**How to apply:** any change to provider submission, response classification, or URL handling must keep these invariants and their contract tests in `artifacts/api-server/src/routes/cas.test.ts` passing; extend the tests when adding new provider behaviors.
