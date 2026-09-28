---
name: Fix a risk class at a shared boundary, not per call path
description: When a task closes a risk class (e.g. credential loss must lock the CAS console), enumerate every caller of the underlying primitive — page-level catches bypass provider-level handling and reviewers treat partial coverage as incomplete.
---

When closing a risk class, fix it at a shared boundary that cannot be bypassed, or enumerate every call site of the underlying primitive.

**Why:** The mid-session credential-lock task named only the provider's `handleActionError` paths, so the first fix covered those; two review rounds then flagged promise-returning actions whose callers catch errors locally (requeue/capture/import), and finally direct `casAuthedFetch` callers in settings pages (responders, capture policy, templates, evidence downloads) that still bypass the lock. Each partial fix was rejected as leaving the same risk open elsewhere.

**How to apply:** Before implementing, grep for all callers of the primitive the risk flows through (e.g. `casAuthedFetch`) and prefer enforcing the behavior inside the primitive or a single wrapper every caller must use, over handling it per call site. Expect review to check the paths the task text did *not* name.
