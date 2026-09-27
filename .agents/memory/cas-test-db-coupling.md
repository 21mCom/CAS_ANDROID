---
name: CAS DB-heavy test files must run sequentially
description: api-server test files that share the review database can change each other's behavior — run them in separate sequential tsx --test invocations
---

Test files under artifacts/api-server that touch the database all share the
same disposable review DB (scripts/run-cas-contract-tests.mjs). Node's test
runner executes multiple files in concurrent subprocesses, so two DB-heavy
files can interfere: e.g. cas-config.test.ts writes cas_responders rows that
change what cas.test.ts's trigger fan-out queues (the env-recipient fallback
only applies while cas_responders is completely empty).

**Why:** `tsx --test a.test.ts b.test.ts` runs files concurrently by default;
shared mutable config tables make fan-out behavior depend on cross-file timing.

**How to apply:** package.json `test:direct` keeps cas-config.test.ts in a
second `&&`-chained `tsx --test` invocation so it never overlaps cas.test.ts.
Any future DB-touching suite must join the sequential chain, not the
concurrent file list, and must leave cas_responders/cas_message_templates
empty in beforeEach/after (the env-fallback state the older suite expects).
