---
name: Completion rebases can mangle mainline files, not just revert them
description: A task-completion rebase once corrupted a shared route file on main itself (spliced function bodies, wrong schema identifiers) — always re-validate the post-rebase tree, never trust conflict-marker-only checks
---

The task-completion rebase machinery can produce semantically corrupted
merges — not only in the rebased task's own files, but committed onto
mainline. Observed once: a shared Express route file on main ended up with a
route whose body was another route's transaction (undefined variables), a
zod `.parse()` result read as `.success`, and a whole endpoint spliced out.
The corrupted commit still passed because validation had run pre-rebase.

**Why:** semantic region merging can cross-splice same-shaped code blocks
(two routes with similar transaction bodies), and the corruption is
committed silently when nothing re-validates the post-rebase tree.

**How to apply:**
- After any conflicted completion rebase, run the *full* contract suite and
  a workspace typecheck on the post-rebase state before marking complete —
  they catch the splices. Conflict-marker-only verification does not.
- A rebase can also report "completed cleanly" and STILL revert files that
  both sides touched: observed a squash-commit rebase where the replayed
  snapshot of a shared route file was the task's stale base version —
  mainline's own newer repairs vanished without a single conflict. Before
  completing, diff every file you touched against the pre-rebase mainline tip
  (git log/reflog names it) and confirm none of mainline's changes were lost;
  rebuild damaged files as "mainline's version + your genuine hunks" (recover
  your hunks from the pre-rebase tip in the reflog).
- Mainline can move DURING your completion: another task's merge can land
  after your rebase base, and restoring files to your base's blobs then
  silently discards the newcomer's work (the clobber sweep catches this as
  "reverted blob"). Always restore from the CURRENT main tip, not the base
  you rebased onto — and check the tip again right before marking complete.
- The mangling can also ship in the OTHER task's completion: observed a
  merged mainline commit whose own test file was splice-corrupted (stray
  loop fragments, undefined identifiers) yet landed. If restoring a file
  from a main tip fails typecheck, that commit is itself damaged —
  reconstruct the file as "last clean blob + the change's behavioral intent"
  and let that task's contract suite verify the reconstruction.
- A deliberate repair commit that restores an older blob looks like a revert
  to the clobber sweep; suppress it with a `scripts/merge-clobber-allowlist.json`
  `commits` entry documenting which blob HEAD provably matches.
- When reconstructing a mangled file, treat the affected task's own test
  suite on main as the behavioral spec: if it passes against the
  reconstruction, the reconstruction preserves that task's changes.
- Recovery recipe for a mangled completion commit: reset --hard to the fresh
  mainline tip, `git checkout <pre-rebase-tip> -- <files>` for files the
  concurrent work never touched, and re-merge your hunks onto overlap files
  with `git diff <tip>^ <tip> -- <file> | git apply --3way`. Audit the result
  with an untruncated git status for swept-up stray files before recommitting.
- When the rebase *linearizes a merge* (replays the second parent's commits
  onto the first, skipping the merge commits themselves): conflict
  resolutions recorded in the skipped merge commits are lost, and a
  clean-applying pick can silently move a file away from the intended final
  tree (observed: a duplicate-import break re-introduced into
  lib/db/src/schema/cas.ts despite every conflict round being resolved to the
  verified tree). Always finish by comparing the FINAL tree hash against the
  pre-rebase tip's tree (`git rev-parse HEAD^{tree}` vs reflog tip) — any
  difference is damage to repair. The replay also rewrites SHAs (clobber-check
  allowlist entries naming old SHAs stop matching; add entries for the
  rewritten ones) and breaks the DAG link to any pushed remote tip — re-link
  with a trivial `git merge <remote-tip>` (trees identical by then) and push,
  or subsequent pushes go non-fast-forward again.
- A completion rebase triggered while the task branch carries a big merge
  commit replays BOTH parents' lineages as picks — observed 103k picks for a
  reunification merge, intractable at ~12 picks/min with driver timeouts
  killing git mid-pick. Shortcut that the platform driver accepted: when
  `git merge-tree --write-tree <onto> <tip>` is conflict-free AND the two
  sides' post-merge-base changed-file sets are disjoint (verify with
  `comm -12` on both `git diff --name-only` lists), stop the grind, review
  EVERY `-` line of the tip→union-tree diff, then `git commit-tree
  <union-tree> -p <onto> -p <tip>`, `git reset --hard` to it, truncate
  `.git/rebase-merge/git-rebase-todo` to empty, and call
  continueMergeResolution — it finishes cleanly and keeps the pushed remote
  tip a fast-forward ancestor. Re-run the full battery on the union tree
  before marking complete.
- When background-grinding a rebase from shell scripts: guard the loop with
  `flock` so a retry never spawns a second grinder (two concurrent grinders
  raced on index.lock and triple-appended `done` entries), and never
  `pkill -f <pattern>` from a shell whose own command line contains the
  pattern — it kills the calling shell (exit -1); use exact PIDs from
  `pgrep -a -f ... | grep -v pgrep` output instead.
- The completion rebase LINEARIZES (no --rebase-merges): any merge commit in
  the task branch re-adds its second parent's entire lineage to the pick
  list, so collapsing a huge rebase with a merge commit makes the NEXT
  completion attempt re-replay the same ~103k picks and re-stop on the same
  conflict (observed: three consecutive attempts, same todo, same conflict
  file). Escape: replace the branch with ONE squash commit (parent = current
  mainline tip, tree = the verified union tree) so the rebase has nothing to
  replay and the platform goes straight to validation/review. Then re-link
  the pushed remote tip's ancestry with a merge commit (parents: squashed
  branch tip, remote tip; tree unchanged — verify `git rev-parse
  <both>^{tree}` match first) and fast-forward push. Only safe once the
  branch is a direct child of the mainline tip, or the next completion
  rebase re-triggers the treadmill.
