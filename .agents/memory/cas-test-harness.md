---
name: CAS test harness
description: Multi-process API integration tests need generous startup polling and awaited child shutdown.
---

Multi-process CAS tests must allow for cold API startup and await spawned process exits during cleanup.

**Why:** Parallel child API processes can take longer than a one-second readiness window, and signaling without awaiting exit leaves the test runner hanging.

**How to apply:** Keep process readiness polling tolerant of cold starts, capture failures clearly, and await every child exit in both success and timeout cleanup paths.

Outbox rows created in one transaction (e.g. the SMS and XMPP pair from a trigger) share the exact same created_at, so the worker's ORDER BY created_at claim is nondeterministic between siblings.

**Why:** Tests that assume a specific sibling is claimed first flake or assert against the wrong row.

**How to apply:** In outbox worker tests, pin claim order explicitly — hold non-target siblings back with a future next_attempt_at instead of relying on created_at ordering.