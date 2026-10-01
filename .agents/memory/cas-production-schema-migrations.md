---
name: CAS production schema migrations
description: drizzle-kit's non-interactive failure modes are silent exit 0s; snapshot out path must stay relative
---

CAS's production database schema ships as committed drizzle migrations applied by the api-server at boot (production only; dev/test keep `drizzle-kit push`).

**Why:** publishing previously required a manual `push-force` against production from the workspace shell — easy to forget, and repeated on every schema change.

**Durable pitfalls (cost a rejected review round each):**
- drizzle-kit generate prompts interactively on ambiguous diffs (e.g. column renames); without a TTY it prints "Interactive prompts require a TTY terminal" and EXITS 0 writing nothing — a freshness check must grep for that marker, never trust a clean tree.
- drizzle-kit 0.31 mangles an absolute `out` path in config (prepends `./`, ENOENT) — keep `out` relative.
- Piping a test command through `tail`/`grep` in a background run masks its real exit code with the pipe's — the whole suite failed while reporting success.
