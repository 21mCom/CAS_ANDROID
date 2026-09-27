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
- When reconstructing a mangled file, treat the affected task's own test
  suite on main as the behavioral spec: if it passes against the
  reconstruction, the reconstruction preserves that task's changes.
