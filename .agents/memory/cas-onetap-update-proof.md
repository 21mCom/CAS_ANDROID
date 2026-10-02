---
name: One-tap update field proof lessons
description: Hardware quirks and evidence rules from the first physical-Pixel self-update proof (N → N+1).
---

Two non-obvious findings from the first successful one-tap self-update field run on the physical Pixel 11 (2026-10-02):

1. **First install attempt can fail with `INSTALL_FAILED_VERIFICATION_FAILURE` and succeed on immediate retry.** Journal showed CONFIRM_PROMPT_SHOWN → FAILED (status 3, "Install not allowed for file:///data/app/vmdl…tmp") right after the "Install unknown apps" grant, then an identical retry installed cleanly. Field guides and update UX should expect a possible one-time retry, not treat the first failure as fatal.

2. **Journal-scraping scripts must match the journal's actual key.** TestStore writes each event under `"type"`, and shared_prefs XML HTML-escapes quotes (`&quot;`). A capture script regex written against `"event"` silently matched nothing on a healthy phone. When scraping shared_prefs XML, unescape entities first and grep for `"type"`.

**Why:** both cost a re-run in a hardware session where each round-trip is expensive.
**How to apply:** when writing or debugging field-proof capture scripts, verify the regex against a real journal dump before shipping the pack; when an update install fails once on hardware, retry before diagnosing.
