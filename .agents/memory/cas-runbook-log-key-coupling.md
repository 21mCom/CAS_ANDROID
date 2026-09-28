---
name: Runbook alert recipes are coupled to exact log keys
description: SELF-HOSTING.md alerting recipes grep for literal keys/messages emitted in code; renaming either side silently breaks the operator's alerting.
---

The self-hosting runbook (artifacts/api-server/SELF-HOSTING.md) contains copy-pasteable
alerting recipes that match literal strings in the server's structured logs — e.g. the
credential-burst watchdog greps the journal for `casAuthRejectionBurst`, the key emitted
by defaultBurstRecorder in the cas-auth module.

**Why:** Nothing in CI ties the runbook's match strings to the code that emits them, so a
rename on either side compiles fine and only fails the day a real operator relies on the
alert. The project already treats this class of coupling as a drift-gate pattern elsewhere.

**How to apply:** When changing any log key or message that the runbook matches on, update
the runbook recipe in the same change; when editing runbook recipes, verify the match
string against the emitting code (emit the line with NODE_ENV=production and grep it).
