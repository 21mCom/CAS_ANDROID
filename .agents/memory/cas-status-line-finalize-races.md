---
name: Async finalize vs summary status races
description: Inline status lines updated from both a worker-thread summary and an async finalize listener need single-threaded check-and-post and per-tap ownership invalidation.
---

For the CAS handset's inline Send-alert status (and any UI line fed by both a worker-thread "interim" result and an async "final" callback): two review rounds rejected naive fixes.

**The rules that survived review:**
- Attribute every async outcome to the attempt that owns the line (send id), never show outcomes from re-queued or superseded attempts over a newer attempt's status.
- A final outcome must win over an interim summary regardless of callback order — a fast radio can finalize *inside* the send call, before the summary posts.

**What was STILL flagged (residual, known):**
- Reading "already finalized?" on the worker thread and posting the summary on the UI thread is two operations — a finalize landing between them is clobbered by the summary and already marked shown. The check-and-post must be one ordered UI-thread operation.
- Attempt ownership must be invalidated on *every* tap, including preflight early-returns (missing responders / permission), not only after preflight passes.

**Why:** the whole feature exists to prevent "looked sent but wasn't" confusion; a status line that can regress from final to interim recreates it.

**How to apply:** when touching MainActivity's alert status or DeviceSmsSender's outcome publication, serialize the finalize-check + summary-post on the UI thread and call the tracker's attempt-invalidation at the top of the tap handler. See BatchOutcomeTracker.kt for the attribution model.
