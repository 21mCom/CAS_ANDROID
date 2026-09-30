---
name: Post-merge gate confirmation
description: A green post-merge setup can hide a silently-skipped gate (warn-and-exit-0); automatic run logs are not kept in the workspace — verify via the runner's log content or a worktree replay.
---

# Confirming a post-merge hook ran (vs. silently skipped)

Hooks in scripts/post-merge.sh are often designed to warn-and-exit-0 when
their inputs are missing (e.g. check-merge-clobber.mjs exits 0 with
"skipped (not a git repository)" / "empty window" when history is
unavailable). A successful setup run therefore does NOT prove the gate
executed — only the log content does.

**Why:** Post-merge environments do not persist the automatic setup run's logs
anywhere readable (not /tmp, /var/log, or ~/.local/state), so after the fact
you cannot quote the first run's log; and a silent skip looks identical to a
pass from the outside.

**How to apply:**
- To observe the real runner: `runPostMergeSetup({ taskRef })` in
  CodeExecution is the same runner the system invokes after a merge. It returns
  `{ success, stdoutPath, stderrPath, durationMs, timeoutMs }`; grep the stdout
  file for the hook's own output lines AND for its skip warnings, and compare
  durationMs against the configured timeout (`getPostMergeConfig()`).
- To establish what a sweep would have computed at an earlier merged snapshot
  (when the literal first run's log is gone): `git worktree add /tmp/x <sha>`
  at the merge commit and run the exact hook command there. Tools anchored at
  HEAD (`git log -N HEAD`, `git show HEAD:path`) then see byte-identical input
  to that snapshot's run. Report this as a replay, not as the first run itself.
- Supporting negative evidence: no repair commits to the hook/script since
  wiring (a failed automatic run would have alerted the next session and left
  a fix).
