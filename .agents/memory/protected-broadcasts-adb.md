---
name: Sending protected broadcasts to the test APK
description: adb shell cannot send BOOT_COMPLETED on API 35; the emulator CI job must adb root first.
---

`adb shell am broadcast -a android.intent.action.BOOT_COMPLETED ...` fails on the API 35 google_apis emulator with `SecurityException: Permission Denial ... uid=2000` — protected broadcasts are not sendable by the shell uid on modern API levels, despite older docs implying otherwise.

**Why:** Verified on a real API 35 emulator in this workspace (2026-09-15): the broadcast was rejected as shell, then succeeded (`Broadcast completed: result=0`) after `adb root`. The launch-smoke-test CI job does `adb root` + `adb wait-for-device` and asserts `adb shell id` shows uid=0 before broadcasting.

**How to apply:** Any local or CI script that injects BOOT_COMPLETED / LOCKED_BOOT_COMPLETED (or other protected broadcasts) into com.covertalert.pixeltest must run `adb root` first; this only works on rootable `google_apis` images, not `google_play` images.

LOCKED_BOOT_COMPLETED sits on the same framework protected-broadcast allowlist (`frameworks/base/core/res/AndroidManifest.xml`), enforced by the same single check — the shell block verified live for BOOT_COMPLETED applies to it.

The same shell-uid denial applies to `am start -n pkg/.NonExportedActivity`: on API 35, uid=2000 gets `SecurityException ... not exported` for non-exported activities, while root (uid 0) is exempt. Driver scripts for debug-only non-exported entry points must `adb root` (and re-run `adb reverse` afterwards — restarting adbd drops reverse tunnels).

**Injection ≠ direct boot:** sending `am broadcast -a ...LOCKED_BOOT_COMPLETED` after the device has unlocked does NOT exercise the pre-unlock path — credential-encrypted storage is already available then, so a CE-storage regression in a receiver stays green. Real direct-boot coverage requires the device to actually be locked: set a lockscreen PIN (`locksettings set-pin`), reboot, assert `sys.user.0.ce_available` is not "true" (calibrate it reads "true" while unlocked first), and let the system deliver LOCKED_BOOT_COMPLETED naturally. The launch-smoke job does exactly this.

**Why:** a code review (2026-09-15) rejected an injected-broadcast phase as overstated direct-boot coverage for exactly this reason.
