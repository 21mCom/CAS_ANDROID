---
name: Publish flow can flip .replit off the Reserved VM target
description: Replit's publish flow rewrites .replit deploymentTarget (committed as "Published your App"); the publish-readiness rehearsal reads the working tree and fails on its first check
---

The publish-readiness rehearsal (scripts/rehearse-publish-readiness.mjs) reads the WORKING-TREE `.replit`, and its very first check requires `deploymentTarget = "vm"` (Reserved VM — required by the always-on in-process workers, see artifacts/api-server/PUBLISH-ON-REPLIT.md).

Replit's publish flow can rewrite that line to `deploymentTarget = "cloudrun"` — first as an uncommitted working-tree change while the publish is in flight, then committed by the platform as a "Published your App" commit (Replit-Commit-Author: Deployment). So a rehearsal failure on the Reserved VM check, or a surprising `cloudrun` value in HEAD, is usually the publish flow's doing, not a code regression.

**Why:** autoscale (cloudrun) freezes the long-running outbox/email-probe workers between requests; the project documents Reserved VM as mandatory, but the platform deploys whatever the publish flow last wrote.

**How to apply:** after any publish, or when the rehearsal fails on the Reserved VM check, run `git log -1 --format='%s %(trailers)' -- .replit` / `git diff .replit` before touching code. Restore the documented posture by writing the good TOML to a temp file and calling `verifyAndReplaceDotReplit` (direct edits are rejected — see dot-replit-edit-flow.md), commit it, and re-run the rehearsal. If the platform committed the flip, the commit must be followed by an explicit restore commit or the CI gate stays red.
