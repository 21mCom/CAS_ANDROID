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
