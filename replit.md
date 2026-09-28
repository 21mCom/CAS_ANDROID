# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages with the web console at `/` and the mockup Canvas at `/__mockup`
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Self-hosting: `artifacts/api-server/SELF-HOSTING.md` is the production runbook
  (own server, systemd, HTTPS, backups, uptime checks). Production start:
  `pnpm --filter @workspace/api-server run build` then `start:production`.
  Read endpoints that expose incident state require an enrolled device
  credential, same as mutations.

The workspace build supplies the preview defaults required by both Vite
artifacts: `PORT=5173 BASE_PATH=/` for the web console and
`PORT=5174 BASE_PATH=/__mockup` for the mockup Canvas. To build an artifact
directly with a different preview configuration, set `PORT` and `BASE_PATH`
for that package; the workspace command also accepts `WEB_PORT`,
`WEB_BASE_PATH`, `MOCKUP_PORT`, and `MOCKUP_BASE_PATH` when its defaults need
to be changed.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Stale-snapshot merges have silently reverted other tasks' committed work
  several times (see `.agents/memory/concurrent-task-merge-clobber.md`).
  Post-merge hygiene: `node scripts/check-merge-clobber.mjs` (also wired into
  `scripts/post-merge.sh`, window 40) flags files whose blob reverted A→B→A
  and commits whose added lines are mostly gone at HEAD, tracing removals via
  `git log -S`. Deliberate reverts/break-proofs stay actionable-silent: put
  `[no-clobber-check]` in the commit message or extend
  `scripts/merge-clobber-allowlist.json`. Self-test:
  `pnpm --filter @workspace/scripts run test:merge-clobber`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
