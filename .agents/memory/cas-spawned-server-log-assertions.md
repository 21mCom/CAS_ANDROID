---
name: Spawned API server log assertions must poll
description: pino-pretty's async transport means child-process server logs land after the fact they describe; one-shot log assertions flake/fail.
---

When a test spawns the real api-server (`process.execPath --import tsx/esm src/index.ts`) and asserts on its captured stdout/stderr, the dev logger (lib/logger.ts) writes through pino-pretty, a worker-thread transport. Log lines arrive in the parent's pipe buffer asynchronously — a one-shot `assert.match(output, ...)` right after readiness sees an empty buffer even though the event happened.

**Why:** pino-pretty runs in a thread-stream; the parent must give it time to flush before matching.

**How to apply:** wrap log assertions in a poll-with-deadline helper (pattern.test on the accumulated buffer, retry every ~50ms). Same for post-SIGTERM "stopped" lines — poll after exit, streams may still be flushing. Two related traps in these fetch-heavy suites: `assert.equal(resp.status, 200, await resp.text())` evaluates the message eagerly and consumes the body before `.json()` (branch on status instead); and live-server boot proofs must strip NODE_ENV=test / CAS_TEST_DISPOSABLE_DB from the child env, because index.ts deliberately disables the mailbox probe worker under test-harness markers.
