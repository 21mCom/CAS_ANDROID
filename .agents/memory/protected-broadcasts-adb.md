---
name: Sending protected broadcasts to the test APK
description: adb shell cannot send BOOT_COMPLETED on API 35; the emulator CI job must adb root first.
---

`adb shell am broadcast -a android.intent.action.BOOT_COMPLETED ...` fails on the API 35 google_apis emulator with `SecurityException: Permission Denial ... uid=2000` — protected broadcasts are not sendable by the shell uid on modern API levels, despite older docs implying otherwise.

**Why:** Verified on a real API 35 emulator in this workspace (2026-09-15): the broadcast was rejected as shell, then succeeded (`Broadcast completed: result=0`) after `adb root`. The launch-smoke-test CI job does `adb root` + `adb wait-for-device` and asserts `adb shell id` shows uid=0 before broadcasting.

**How to apply:** Any local or CI script that injects BOOT_COMPLETED / LOCKED_BOOT_COMPLETED (or other protected broadcasts) into com.covertalert.pixeltest must run `adb root` first; this only works on rootable `google_apis` images, not `google_play` images.
