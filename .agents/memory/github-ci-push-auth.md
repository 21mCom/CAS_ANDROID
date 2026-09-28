---
name: GitHub CI push auth (PAT rotation)
description: Current GITHUB_PAT expiry, the push/dispatch commands that work, and the failure modes of every alternative credential for 21mCom/CAS_ANDROID.
---

The workspace pushes and dispatches to GitHub repo `21mCom/CAS_ANDROID` using the `GITHUB_PAT` secret (fine-grained PAT, repo-only, Administration/Contents/Actions/Workflows/Secrets read+write, Secret scanning alerts read+write).

- **Current token expiry: 2026-12-27 02:43:08 UTC** (rotated 2026-09-27; previous token expired 2026-12-16 07:18:47 UTC). Check without printing the token: `curl -s -o /dev/null -D - -H "Authorization: Bearer $GITHUB_PAT" https://api.github.com/repos/21mCom/CAS_ANDROID | grep -i github-authentication-token-expiration`.
- Push (token never prints): `GIT_ASKPASS= GIT_TERMINAL_PROMPT=0 git push "https://x-access-token:${GITHUB_PAT}@github.com/21mCom/CAS_ANDROID.git" main:main`. A Basic `http.extraHeader` also works; Bearer `http.extraHeader` does NOT.
- REST API (runs, jobs, logs, workflow_dispatch, contents API): `Authorization: Bearer $GITHUB_PAT`.
- Single-file commits to remote main without touching divergent local history: GET then PUT `/repos/21mCom/CAS_ANDROID/contents/<path>` with the file's current sha (used for the watchdog's PAT_EXPIRES_AT during rotation).
- Broken alternatives (re-verified 2026-09-17): `replit-git-askpass` mints an invalid ~30-char token (401 everywhere); the GitHub connector's app has no installation on the repo (writes 403). Do not retry either for writes.
- Failure mode when the PAT lapses: every push/dispatch fails 401 and CI iteration stalls. Rotation steps live in `.github/workflows/pat-expiry-watchdog.yml`'s header comment; the watchdog turns red 60 days before the recorded PAT_EXPIRES_AT (update that constant in BOTH the workspace and GitHub copies when rotating — a contents-API PUT updates the GitHub copy and itself proves Contents:write).

**Why:** Two OAuth setup attempts and repeated askpass failures cost several failed CI runs before the PAT path worked; recording the expiry in two places (here and github-ci-access.md) is deliberate so whichever page an agent opens shows it.

**How to apply:** For rotation, request a fresh fine-grained PAT via `requestSecrets` (the user must mint it in GitHub — agents cannot), verify with a workflow_dispatch (204) and check the new expiry header, then update PAT_EXPIRES_AT in both watchdog copies and both memory files.
