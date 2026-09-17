---
name: Launch smoke detection lessons
description: Durable detection-design lessons from proving the emulator smoke test goes red on crash-on-launch.
---

Two non-obvious behaviors proven on a real API 35 emulator (2026-09-15):

1. `adb shell am start -W` exits 0 with `Status: ok` even when the app throws in `onCreate` and dies seconds later. A successful `am start` is never proof of survival — process liveness (`pidof`) and logcat greps are the real detectors.
2. `adb logcat -d | tail -200` can completely miss the fatal-crash block on a slow/noisy emulator; system chatter pushes it out of the tail. Surface `grep -B2 -A30 'FATAL EXCEPTION'` explicitly on failure paths.

**Why:** Both were observed during live crash-on-launch verification of the launch-smoke-test CI job; (2) meant the red run initially lacked the crash evidence a reviewer needs.

**How to apply:** When writing or reviewing any CI launch/crash detection script, keep an independent liveness check after a delay, never rely on am start's exit code, and grep the fatal block rather than only tailing logcat.
