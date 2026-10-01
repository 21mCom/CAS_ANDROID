---
name: Publish rehearsal vs uncommitted .replit drift
description: A local publish-readiness rehearsal failure on the Reserved VM check can be uncommitted workspace .replit drift, not a code regression
---

The publish-readiness rehearsal (scripts/rehearse-publish-readiness.mjs) reads the WORKING-TREE `.replit`. On 2026-10-01 the workspace `.replit` was found with an uncommitted flip to `deploymentTarget = "cloudrun"` while HEAD committed `"vm"` — the rehearsal failed locally on its very first check while the committed tree was fine.

**Why:** the environment (or a prior session) can modify `.replit` without committing; the flip to cloudrun would silently break the always-on worker posture if it ever got committed.

**How to apply:** if the rehearsal fails on the Reserved VM static-posture check, run `git status -- .replit` / `git diff .replit` before touching code. Restore the committed posture by writing `git show HEAD:.replit` to a temp file and calling `verifyAndReplaceDotReplit` (direct edits are rejected — see dot-replit-edit-flow.md).
