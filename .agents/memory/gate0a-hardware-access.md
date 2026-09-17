---
name: Gate 0A hardware access
description: Physical and emulator target policy for running the native CAS proxy harness.
---

The approved physical Gate 0A target is a stock Google Pixel 11 on API 35 or newer. The Pixel 8a/API 35 environment remains a pinned emulator baseline and can produce simulation evidence only. Physical validation still requires the separate Windows hardware-run workstation and an authorized Pixel ADB endpoint.

**Why:** The project owner selected Pixel 11 as the durable field target. Gate 0A acceptance depends on its physical launch, task, lock-screen, reboot, and observer evidence; the older emulator cannot substitute for that run.

**How to apply:** Require an exact Pixel 11 model match for physical evidence, record its actual Android build/API, and require API 35 or newer. Keep Pixel 8a/API 35 checks exact for emulator evidence. If ADB identity or SDK prerequisites fail, record blocked/no-go. Only *physical* Pixel runs need the hardware workstation — a local TCG emulator can be stood up in the workspace (see android-emulator-in-workspace.md).

A full physical run completed on 2026-09-14 (Pixel 11 / cubs, stock Android 17 / API 37, 219/219 checks). `gate0aPassed: false` in the report is by design — the kit never auto-declares a pass; evidence import plus human sign-off in the console still determines Gate 0A status.