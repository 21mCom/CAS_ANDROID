---
name: Android emulator jobs on GitHub CI
description: Emulator jobs must run on ubuntu-latest + KVM + x86_64 (macOS runners cannot boot an emulator), and android-emulator-runner's script block executes under dash — no pipefail, single-line bash invocation only.
---

Two CI-only traps for CAS_ANDROID emulator jobs (neither reproduces locally):

1. **macOS runners cannot boot the Android emulator.** macos-latest is an
   Apple Silicon VM without nested virtualization; the emulator dies at
   launch with `HVF error: HV_UNSUPPORTED` (actions/runner-images#9460), so
   an emulator job on macOS fails before the first test command runs.
   **How to apply:** put every emulator job on ubuntu-latest with the KVM
   udev-rule step and `arch: x86_64`. For a disposable PostgreSQL on ubuntu,
   use the preinstalled apt binaries (`/usr/lib/postgresql/*/bin`), a
   `$RUNNER_TEMP` cluster, and a non-default port (e.g. 55432) so the
   stopped packaged cluster on 5432 is never touched.

2. **android-emulator-runner runs `script:` via `/usr/bin/sh`, which is dash
   on ubuntu.** `set -o pipefail` dies with `Illegal option -o pipefail`
   (exit 2) before the script does anything.
   **How to apply:** keep `script:` a single-line `bash path/to/harness.sh`
   and put strict mode inside the bash script. A multi-line strict-mode
   block that works on macOS (where sh is bash in POSIX mode) fails
   instantly on ubuntu.

Known flake: any `adb root` in an emulator job (initial acquire or
post-reboot re-acquire) can fail on a transient adbd disconnect — observed
both as `adb: unable to connect for root: closed` and as a fast non-zero
exit ~1 s after a successful APK install; a rerun of the same tree passes.
No retry is built into the scripts.
