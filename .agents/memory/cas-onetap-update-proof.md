---
name: One-tap update field proof lessons
description: Durable verification lessons from the first physical-Pixel self-update proof (N → N+1).
---

Two durable lessons from the first successful one-tap self-update field run on the physical Pixel 11 (2026-10-02):

1. **Post-permission-grant race: the first install handoff can fail verification right after the "Install unknown apps" grant.** The AppOps grant lags the system verifier, so the first commit can come back refused with "Install not allowed for file:…" and an identical retry succeeds. Only that exact refusal text marks the race — the surrounding INSTALL_FAILED_VERIFICATION_FAILURE code is a general verification failure, and any other failure must stay terminal, never retried.

2. **Validate any journal-scraping script against a real device dump before shipping it.** shared_prefs XML entity-escapes its JSON payload, so a pattern written against the raw JSON silently matches zero events on a healthy phone. One unchecked assumption cost a hardware re-run.

3. **Regenerating the pack means publishing a new N+1, not just rezipping APKs.** The pack's baseline N must come from the CURRENT tree (CaptureJournal fails closed on pre-consent-journaling baselines), and the dev server's updates table is append-only with monotonic versionCode — so each regeneration commits a versionCode bump, builds N+1 signed with the field release key, and publishes it. The published row persists in the dev DB across workspace restarts.

**Why:** hardware field runs are expensive; each avoidable re-run costs a physical session.
**How to apply:** when writing field-proof capture scripts, test the extraction against a real (sanitized) dump first; when a hardware update install fails once, retry before diagnosing. When refreshing the one-tap pack, verify every staged APK with `aapt dump badging` + `apksigner verify --print-certs` against the pinned fingerprint before rezipping, and confirm the server manifest reports the new N+1 after publishing.
