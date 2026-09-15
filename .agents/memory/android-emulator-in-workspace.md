---
name: Android emulator in this workspace
description: Recipe for standing up a working Android SDK + emulator locally despite no KVM and a small home-dir quota.
---

A full Android emulator CAN run in this workspace, contrary to earlier assumptions:

- **Disk:** the home filesystem has a ~5G per-user quota (an SDK + system image is ~5G+ and will fail with "Disk quota exceeded"). Put everything on the 256G workspace volume (e.g. a git-excluded `.android-env/` dir with `sdk/`, `avd/`, `gradle-dist/`, `gradle-user-home/`) and set `ANDROID_HOME`, `ANDROID_AVD_HOME`, `GRADLE_USER_HOME` accordingly.
- **GUI libs:** the emulator binary needs `libX11.so.6`, absent from the container; find it in the nix store (`ls -d /nix/store/*libX11-*/lib`) and export via `LD_LIBRARY_PATH`.
- **No KVM:** pass `-no-accel` (x86_64 works under TCG despite the scary "requires hardware acceleration" check that only fires *without* the flag). Cold boot takes ~7 minutes; `am start -W` can report `Status: timeout` on a healthy app. Right after cold boot, package scanning lags — a launch immediately after install can fail with "Activity class does not exist"; wait a few seconds.
- **Toolchain:** download cmdline-tools from dl.google.com and the pinned Gradle from services.gradle.org; system java 17 works. Network access to dl.google.com / services.gradle.org / Maven repos is available.
- **Lifecycle:** workspace restarts kill the emulator and background shells, but everything on the workspace volume persists; relaunch the same AVD.

**Why:** standing this up once enabled real end-to-end APK/emulator verification locally when GitHub CI was unreachable; future Android verification tasks can reuse the recipe.

**How to apply:** Follow this recipe instead of concluding emulator verification is impossible; only *physical* Pixel runs still need the hardware workstation.
