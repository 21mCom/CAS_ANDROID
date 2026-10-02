---
name: One-tap update field proof lessons
description: Durable verification lessons from the first physical-Pixel self-update proof (N → N+1).
---

Two durable lessons from the first successful one-tap self-update field run on the physical Pixel 11 (2026-10-02):

1. **A first install attempt can fail and succeed on immediate retry.** The field journal showed the first handoff to the system installer fail with a verification refusal right after the "Install unknown apps" grant, then install cleanly on an identical retry. Field guides and update UX should treat a first-attempt failure as retryable, not fatal.

2. **Validate any journal-scraping script against a real device dump before shipping it.** shared_prefs XML entity-escapes its JSON payload, so a pattern written against the raw JSON silently matches zero events on a healthy phone. One unchecked assumption cost a hardware re-run.

**Why:** hardware field runs are expensive; each avoidable re-run costs a physical session.
**How to apply:** when writing field-proof capture scripts, test the extraction against a real (sanitized) dump first; when a hardware update install fails once, retry before diagnosing.
