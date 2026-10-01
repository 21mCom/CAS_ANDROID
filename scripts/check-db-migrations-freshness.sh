#!/usr/bin/env bash
# Database-migration freshness gate.
#
# The api-server applies the committed drizzle migrations (lib/db/drizzle) at
# boot in production (artifacts/api-server/src/lib/db-schema-ensure.ts). A
# schema edit without a regenerated migration would therefore deploy green
# while the live database silently keeps the old shape. This gate fails unless
# the committed migrations exactly reproduce the current schema:
#
#   1. `drizzle-kit check` proves the committed migration chain is internally
#      consistent (snapshots and SQL in lockstep).
#   2. `drizzle-kit generate` is re-run; ANY resulting change under
#      lib/db/drizzle (modified or new files) means the schema and the
#      committed migrations have drifted.
#
# TTY trap this gate guards against: when the diff is ambiguous (e.g. a
# renamed column — rename, or drop+add?), drizzle-kit asks an INTERACTIVE
# prompt. With no terminal — always the case in CI — it prints "Interactive
# prompts require a TTY terminal" and EXITS 0 WITHOUT WRITING ANYTHING, so a
# clean migration directory afterwards proves nothing. The gate captures the
# generator output and treats an abandoned prompt as drift.
#
# Neither drizzle-kit command connects to a database, so the placeholder
# DATABASE_URL below only satisfies the config's presence check — the gate is
# hermetic and safe to run anywhere.
set -euo pipefail

cd "$(dirname "$0")/.."

export DATABASE_URL="postgresql://migrations-gate:placeholder@127.0.0.1:5432/migrations-gate"

fail() {
  echo "MIGRATIONS_FRESHNESS_FAILED: $1" >&2
  exit 1
}

echo "check-db-migrations-freshness: validating the committed migration chain"
pnpm --filter @workspace/db exec drizzle-kit check --config ./drizzle.config.ts

echo "check-db-migrations-freshness: regenerating migrations to detect schema drift"
generate_output="$(pnpm --filter @workspace/db exec drizzle-kit generate --config ./drizzle.config.ts < /dev/null 2>&1)" || {
  printf '%s\n' "$generate_output" >&2
  fail "drizzle-kit generate exited non-zero (see output above)"
}
printf '%s\n' "$generate_output"

if grep -q "Interactive prompts require a TTY" <<<"$generate_output"; then
  fail "the schema diff is ambiguous (e.g. a renamed column) and drizzle-kit refused to
resolve it without a terminal, so the committed migrations cannot be proven fresh
here. Regenerate in a real terminal and commit the result:

  pnpm --filter @workspace/db run generate"
fi

drift="$(git status --porcelain -- lib/db/drizzle)"
if [ -n "$drift" ]; then
  {
    echo "MIGRATIONS_FRESHNESS_FAILED: lib/db/src/schema and the committed migrations in"
    echo "lib/db/drizzle disagree. Regenerate and commit the result:"
    echo ""
    echo "  pnpm --filter @workspace/db run generate"
    echo ""
    echo "Drifted files:"
    echo "$drift"
  } >&2
  exit 1
fi

echo "check-db-migrations-freshness: committed migrations match the schema"
