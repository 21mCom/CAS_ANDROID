---
name: Concurrent task merges can clobber files mid-task
description: Other project tasks merge into main while a task is in progress; edits based on a pre-merge snapshot can silently revert another task's work. Diff against the merge base before completing.
---

# Concurrent task merges can clobber files mid-task

Multiple project tasks run concurrently against this repo and merge into `main` independently. If another task merges into a file you already read and edited, your commit can be produced from the stale snapshot — silently reverting the other task's routes/handlers while keeping your own change, leaving the file syntactically broken.

**Why:** During the re-queue-note task, a concurrent task merged a new route into `cas.ts` between the initial read and the task commit. The resulting commit replaced the newer file with the stale edited copy: unrelated handlers were reverted and orphaned code was left outside any route. Local typecheck/tests had passed *before* the other merge, so nothing caught it until review.

**How to apply:** Before marking a task complete, run `git diff <merge-base-or-parent> -- <files you touched>` and confirm the diff contains *only* your intended changes. If the file gained commits from another task since you read it, restore the current version (`git checkout <parent> -- <file>`) and re-apply your change surgically, then re-run typecheck and tests.
