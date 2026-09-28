---
name: CI gate red-proof technique (throwaway branch)
description: How to prove a CI gate actually fails — cut a throwaway branch from the workspace tip, push break + revert immediately, delete branch after; works while remote main diverges.
---

For "prove gate X turns red" tasks on 21mCom/CAS_ANDROID:

- Cut the throwaway branch from the **workspace tip** (scratch clone of `/home/runner/workspace` to /tmp), not from remote main — while histories diverge, remote main may not yet contain the job/script under test (verified: the pushless-capture-flow job existed only in the workspace lineage).
- Push the break commit, then **push the revert immediately after** — the android-test-package-build workflow has no `concurrency:` group and no branch filter on `push:`, so the red and green runs proceed in parallel instead of serially (~halves wall time).
- Poll `/actions/runs?branch=<branch>` and the run's `/jobs` for the specific job's conclusion; fetch the failing job's log via `/actions/jobs/<job_id>/logs` and keep a local copy under `.local/tasks/` as evidence (branch deletion makes the branch ref disappear but runs/logs persist).
- Delete the throwaway branch with `DELETE /git/refs/heads/<branch>` (204) once both runs are captured.
- Expect blast radius: an app-crash break (e.g. unguarded Firebase) fails EVERY launch-based emulator job in the run, not just the gate under test — judge the proof by the target job's own diagnostics.

**Why:** First red-proof (unguarded FirebaseMessaging in CapturePush.syncRegistration, 2026-09-28) went red with the FATAL EXCEPTION stack pointing at the exact call site and green again after revert, in two parallel ~5-minute runs.

**How to apply:** Any follow-up of the form "prove gate X turns red in real GitHub CI" — this replaces both local simulation (rejected by review) and serial break-then-revert pushes.
