---
name: CAS persistence
description: Durable incident and readiness behavior for the CovertAlertSystem console.
---

Resolved incidents remain the selected incident in API state responses so responders can inspect the full append-only journal after reload; only non-resolved incidents are eligible for trigger reuse.

**Why:** Hiding the latest resolved record made the server retain history that the console could not show, undermining the response workflow.

**How to apply:** Keep incident events append-only and return the latest incident for inspection while using status filtering only when deciding whether a new trigger should reuse an incident.