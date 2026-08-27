---
name: Gate 0A hardware access
description: Environment constraint for running the native CAS proxy harness on the reference Pixel.
---

The CAS Gate 0A native harness cannot be physically validated from the normal Replit workspace unless a hardware-run workstation is attached or exposed. Installing `adb`, Gradle, and JDK 17 is not sufficient: the workspace may still lack the Android API 35 SDK and an authorized Pixel ADB endpoint.

**Why:** Gate 0A acceptance depends on physical launch, task, lock-screen, reboot, and observer evidence; emulator or source inspection cannot substitute for the pinned stock Pixel.

**How to apply:** Before attempting a Gate 0A run, confirm both an API 35 SDK and a non-empty `adb devices -l` result for the managed Pixel. If either is absent, record a blocked/no-go outcome and do not create synthetic reports or timing samples.