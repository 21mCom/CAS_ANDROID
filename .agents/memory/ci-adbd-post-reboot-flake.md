---
name: CI adbd post-reboot disconnect flake
description: adbd on the GitHub CI emulator transiently closes the adb connection right after a PIN-protected reboot; root re-acquires there need a bounded retry, and the fake-adb harness can model the flake.
---

On the pinned CI emulator image (API 35 google_apis, pixel_6, x86_64), adbd can transiently refuse connections right after a PIN-protected reboot: `adb root` fails with `adb: unable to connect for root: closed`, and the identical job goes green on rerun with no changes (observed on real GitHub runs in Sep 2026).

**Why:** One real run failed after every app-level check had passed purely on this disconnect; without a retry, every PR randomly goes red. A persistent failure (non-rootable image) must still go red, so the retry has to be bounded (~12 attempts / 60s worked).

**How to apply:** Any `adb root` re-acquire that runs after an emulator reboot, force-stop, or adbd restart in a CI script needs a bounded retry loop around root + the `uid=0` probe, not a single attempt. When changing the boot-smoke script, extend `verify-launch-smoke-detection.sh`'s fake adb (it can model the closed-connection window per scenario) so the flake-recovers-green and persistent-fails-red behavior stays pinned in the selftest workflow.
