---
name: Disposable review database
description: Restricted review environments need explicit local PostgreSQL socket and role settings.
---

Disposable PostgreSQL review runs must use a temporary cluster with an explicit
Unix-socket directory and bootstrap role instead of relying on the host's
default socket path or the `postgres` role.

**Why:** Minimal or managed workspaces may not provide `/run/postgresql`, and
`initdb` creates the current OS user rather than a `postgres` role by default.

**How to apply:** Keep the review runner's cluster, database, role, and local
`DATABASE_URL` scoped to one command, and remove the cluster after both passing
and failing test runs.