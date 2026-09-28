#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
# Post-merge hygiene: catch work silently reverted by a stale-snapshot merge
# (see .agents/memory/concurrent-task-merge-clobber.md). Fails setup when the
# last merges show clobber signatures; deliberate reverts/break-proofs carry
# [no-clobber-check] in their message or an allowlist entry.
node scripts/check-merge-clobber.mjs --window 40
