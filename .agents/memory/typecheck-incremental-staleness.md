---
name: Typecheck incremental staleness
description: pnpm typecheck in artifacts/api-server uses incremental tsc; a stale tsbuildinfo can report clean while errors exist — verify with --incremental false before declaring done.
---

The api-server typecheck (`tsc -p tsconfig.json --noEmit`) runs incrementally by default. A stale `.tsbuildinfo` can mask real compile errors — including errors introduced by concurrent task merges landing mid-session — so `pnpm run typecheck` can pass while the completion review's `tsc --noEmit --incremental false` fails.

**Why:** A session had typecheck pass repeatedly while the review found 11 errors in `src/routes/cas.ts` caused by a concurrent merge corrupting routes; only the non-incremental run surfaced them.

**How to apply:** After any merge-notification during a session, or before marking a task complete on touched TypeScript packages, run `pnpm exec tsc -p <pkg>/tsconfig.json --noEmit --incremental false` once and re-check that files outside your diff weren't mangled by the merge.
