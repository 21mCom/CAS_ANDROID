---
name: GitHub CI push/auth path
description: How to push to the external CAS_ANDROID GitHub repo and trigger workflows from this workspace — the built-in git credential service times out; use the GITHUB_PAT secret.
---

Pushing to the external GitHub repo (21mCom/CAS_ANDROID) from this workspace only works with the `GITHUB_PAT` secret.

**Why:** The Replit git credential helper (`replit-git-askpass` via `REPLIT_ASKPASS_PID2_SESSION`) consistently times out minting a token, and the OAuth `github` integration connection can read the repo but gets 403 "Resource not accessible by integration" on every write (blobs, dispatches). The `github-app` connection never appears in `listConnections`. A fine-grained PAT was requested from the user and stored as the `GITHUB_PAT` secret.

**How to apply:**
- Push with an explicit credentialed URL, askpass disabled:
  `GIT_ASKPASS= GIT_TERMINAL_PROMPT=0 git push "https://x-access-token:${GITHUB_PAT}@github.com/21mCom/CAS_ANDROID.git" main:main`
  (`http.extraHeader` auth does NOT work — "invalid credentials".)
- Trigger workflows / poll runs with curl + `Authorization: Bearer $GITHUB_PAT` against api.github.com.
- The PAT has an expiry; if pushes start failing with 401, ask the user for a fresh fine-grained PAT (Contents + Actions + Workflows: read/write) via the secrets flow.
- Multiple agent sessions push to this repo concurrently — a push can be rejected non-fast-forward; fetch and rebase onto FETCH_HEAD, then retry.
- GitHub PUSH PROTECTION blocks pushes whose new commits contain secret-shaped strings (GH013). The journal secret-scan tests carry Stripe's doc-example `sk_live_EXAMPLEPLACEHOLDER...` fixture and trip it. The remote prints an `unblock-secret/...` URL, but that flow needs a logged-in browser session — it 404s with a PAT. Workarounds: push a scratch branch based on GitHub's own main (its history is already scanned) with the flagged files kept at their remote versions, or ask the user to unblock via the URL.
