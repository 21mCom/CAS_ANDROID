---
name: Android emulator CI runners
description: GitHub-hosted runner constraints for Android emulator CI jobs — macOS cannot boot the emulator; use ubuntu-latest + KVM; emulator-runner script blocks run under dash.
---

GitHub `macos-latest` runners are Apple Silicon VMs without nested virtualization: the Android
emulator dies at launch with `qemu-system-aarch64-headless: failed to initialize HVF`
(actions/runner-images#9460). Emulator CI jobs must run on `ubuntu-latest` with a KVM-enable
step (udev rule + trigger). Separately, reactivecircus/android-emulator-runner executes each
`script:` line via `/usr/bin/sh` (dash on Ubuntu): no `set -o pipefail`, no multi-line state —
put the real logic in a committed bash script invoked as one line.

**Why:** cost several red CI runs (HVF on macOS; "Illegal option -o pipefail" on ubuntu) before
the sms-receipt-flow job first went green on a real run.

**How to apply:** when adding or moving any emulator job in `.github/workflows/`, copy the
ubuntu-latest + KVM + single-line bash script pattern from the launch-smoke job; never schedule
an emulator job on macos-latest, and never put shell strict-mode or multi-line logic in the
action's `script:` block.
