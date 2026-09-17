---
name: GitHub CI access for CAS_ANDROID
description: How to push and observe GitHub Actions for the CAS_ANDROID repo — the OAuth connector is scope-less; use the GITHUB_PAT secret; expect concurrent-session push races.
---

The project's GitHub remote is `21mCom/CAS_ANDROID`. As of 2026-09-17:

- The **OAuth GitHub connector** (`connection:conn_github_...`) authenticates but was granted **zero scopes** (`x-oauth-scopes` empty) — it cannot create repos, push, or see private content, and reauthorization did not add scopes. Do not retry it for write operations.
- The **`GITHUB_PAT` secret** (workspace secret, fine-grained PAT scoped to the repo with Contents + Workflows write) is the working credential. Push with an askpass helper so the token never prints: `GIT_ASKPASS=<script echoing $GITHUB_PAT> GIT_TERMINAL_PROMPT=0 git push origin main`. Use `Authorization: Bearer $GITHUB_PAT` for the Actions REST API (runs, jobs, logs).
- When the repo is public, runs/branches can be polled unauthenticated; a `workflow_dispatch` POST needs the PAT.
- Multiple agent sessions push to this repo from the same workspace — always `git fetch` and `git rebase origin/main` immediately before pushing, and expect non-fast-forward rejections.
- Pushing workflow-file or kit-script changes auto-triggers the "Windows test-kit entry points" workflow (its push path filter covers them); a full run takes ~5–10 minutes on windows-latest.

**Why:** Two OAuth setup attempts failed before the PAT path worked, and a concurrent session caused a rejected push mid-task; this cost three failed CI runs to learn.

**How to apply:** For any "confirm CI on GitHub" or push-to-GitHub task in this project, go straight to GITHUB_PAT + askpass, poll `/actions/runs` for the workflow, and rebase-then-push. If the PAT expires, see the follow-up task about CI pushes surviving token expiry.
