---
name: Subagent names are environment-scoped
description: A live subagent created in one CodeExecution environment cannot be re-created or continued by name from another; use a fresh name for later review rounds.
---

# Subagent names are environment-scoped

Calling `subagent({ name: "x", ... })` when "x" is a live architect/review subagent born in a different (e.g. earlier compacted) environment fails with "is a live architect subagent born in a different environment".

**Why:** Subagent identity is tied to the environment that created it; after conversation compaction or an environment change, the original cannot be reconnected by re-calling `subagent` with the same name.

**How to apply:** For each new review round, mint a fresh name (e.g. append `-rereview`, `-r2`). Do not retry the same name, and do not assume `sendFollowup` can reach it from the new environment either.
