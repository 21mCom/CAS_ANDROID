---
name: CAS outbox status heartbeat
description: The /api/cas/outbox/status worker heartbeat is process-local while outbox counts are database-wide.
---

The CAS outbox status endpoint mixes two scopes: `counts` / `oldestPendingAt` / `lastDeliveryError` come from the shared database (accurate across replicas), but the `worker` heartbeat lives in an in-process registry module so the worker and router can share it without a circular import. If the API ever runs more than one replica, the heartbeat describes only the replica that served the request.

**Why:** the delivery worker and the routes module already import each other's exports, so the heartbeat registry was factored into its own module (`cas-outbox-status`) rather than put in a shared table.

**How to apply:** when changing outbox status or worker behavior, update the registry module and worker instrumentation together; if horizontal scaling is introduced, move the heartbeat to the database or report per-replica identity explicitly.
