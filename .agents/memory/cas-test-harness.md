---
name: CAS test harness
description: Multi-process API integration tests need generous startup polling and awaited child shutdown.
---

Multi-process CAS tests must allow for cold API startup and await spawned process exits during cleanup.

**Why:** Parallel child API processes can take longer than a one-second readiness window, and signaling without awaiting exit leaves the test runner hanging.

**How to apply:** Keep process readiness polling tolerant of cold starts, capture failures clearly, and await every child exit in both success and timeout cleanup paths.