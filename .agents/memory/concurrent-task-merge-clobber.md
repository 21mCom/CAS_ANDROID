---
name: Concurrent task merges can clobber files mid-task
description: Other project tasks merge into main while a task is in progress; edits based on a pre-merge snapshot can silently revert another task's work. Diff against the merge base before completing.
---

# Concurrent task merges can clobber files mid-task

Multiple project tasks run concurrently against this repo and merge into `main` independently. If another task merges into a file you already read and edited, your commit can be produced from the stale snapshot — silently reverting the other task's routes/handlers while keeping your own change, leaving the file syntactically broken.

**Why:** During the re-queue-note task, a concurrent task merged a new route into `cas.ts` between the initial read and the task commit. The resulting commit replaced the newer file with the stale edited copy: unrelated handlers were reverted and orphaned code was left outside any route. Local typecheck/tests had passed *before* the other merge, so nothing caught it until review.

**How to apply:** Before marking a task complete, run `git diff <merge-base-or-parent> -- <files you touched>` and confirm the diff contains *only* your intended changes. If the file gained commits from another task since you read it, restore the current version (`git checkout <parent> -- <file>`) and re-apply your change surgically, then re-run typecheck and tests.

**Clobbers can reach main committed, not just mid-task:** a stale-snapshot commit reverted earlier route fixes and shipped green because no CI gate ran the api-server typecheck or route tests for that change. It can also strike at completion time: a concurrent repair merges while your task is in flight, and the completion commit (built from your stale snapshot) re-clobbers the file.

**Why:** A green local run only proves the exact working tree that was tested; a task commit assembled from a stale snapshot, or a review merge that resolves conflicts toward the stale side, silently reintroduces the old code.

**How to apply:** When typecheck or tests fail on files you did not touch, suspect a clobber before diagnosing the code itself: diff the broken file against its parent commit to separate the latest task's legitimate changes from reverted hunks, and if another task already landed a canonical repair of the same clobber, restore that version instead of writing a competing one. Signature symptom: contract tests suddenly 400 on previously-working routes, plus tsc errors naming identifiers that belong to a different route's handler.
