---
name: Runbook alert recipes are coupled to exact log keys
description: SELF-HOSTING.md alerting recipes grep for literal keys/messages emitted in code; renaming either side silently breaks the operator's alerting.
---

The self-hosting runbook (artifacts/api-server/SELF-HOSTING.md) contains copy-pasteable
alerting recipes that match literal strings in the server's structured logs — e.g. the
credential-burst watchdog greps the journal for the key emitted by the burst recorder in
the cas-auth module.

**Why:** A rename on either side compiles and reads fine; the operator finds out the day a
real attack goes unalerted. When gating this coupling, the check must isolate the *actual
alerting* grep (the installed watchdog script's match string) and compare it directly
against the emitted key. Pooling every grep in the runbook section is not enough: the
manual diagnostic command further down still matches the emitted key while the watchdog's
own grep drifts or is deleted, and the alert silently dies.

**How to apply:** Change any gated log key/message and its runbook recipe in the same
commit. When writing drift gates over documentation recipes, extract the load-bearing
command (the thing that pages someone), not any matching string anywhere in the section,
and prove it with a negative test that drifts only the load-bearing command.
