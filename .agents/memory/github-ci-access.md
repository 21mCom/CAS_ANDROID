---
name: GitHub CI access for CAS_ANDROID
description: How to push and observe GitHub Actions for the CAS_ANDROID repo — the OAuth connector is scope-less and the Replit git credential helper times out; use the GITHUB_PAT secret; expect concurrent-session push races.
---

The project's GitHub remote is `21mCom/CAS_ANDROID`:

- The **OAuth GitHub connector** authenticates but was granted **zero scopes** (`x-oauth-scopes` empty) — writes get 403 "Resource not accessible by integration", and reauthorization did not add scopes. The built-in Replit git credential helper (`replit-git-askpass`) also consistently times out minting a token. Do not retry either for write operations.
- The **`GITHUB_PAT` secret** (workspace secret, fine-grained PAT scoped to the repo with Contents + Workflows write) is the working credential. Push with an explicit credentialed URL and askpass disabled so the token never prints: `GIT_ASKPASS= GIT_TERMINAL_PROMPT=0 git push "https://x-access-token:${GITHUB_PAT}@github.com/21mCom/CAS_ANDROID.git" main:main`. (`http.extraHeader` auth does NOT work — "invalid credentials".) Use `Authorization: Bearer $GITHUB_PAT` for the Actions REST API (runs, jobs, logs, `workflow_dispatch`).
- When the repo is public, runs/branches can be polled unauthenticated.
- The PAT has an expiry; if pushes start failing with 401, ask the user for a fresh fine-grained PAT (Contents + Actions + Workflows: read/write) via the secrets flow.
- Multiple agent sessions push to this repo from the same workspace — always `git fetch` and rebase onto FETCH_HEAD/origin/main immediately before pushing, and expect non-fast-forward rejections.
- Pushing workflow-file or kit-script changes auto-triggers the "Windows test-kit entry points" workflow (its push path filter covers them); a full run takes ~5–10 minutes on windows-latest.
- GitHub PUSH PROTECTION (GH013) blocks pushes whose new commits contain secret-shaped strings — the journal secret-scan tests' Stripe doc-example `sk_live_4eC39...` fixture trips it. The printed `unblock-secret/...` URL needs a logged-in browser (404s with a PAT); work around by pushing a scratch branch based on GitHub's own main with the flagged files at their remote versions, or ask the user to unblock via the URL.

**Why:** Two OAuth setup attempts and repeated askpass timeouts failed before the PAT path worked, and a concurrent session caused a rejected push mid-task — this cost several failed CI runs to learn.

**How to apply:** For any "confirm CI on GitHub" or push-to-GitHub task in this project, go straight to GITHUB_PAT via the credentialed URL, poll `/actions/runs` for the workflow, and rebase-then-push.
