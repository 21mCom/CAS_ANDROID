---
name: Android emulator in this workspace
description: A full Android emulator works here despite no KVM — but its modem never registers, so outbound-SMS flows can only be verified up to the radio send.
---

A full Android emulator CAN run in this workspace. Durable constraints:

- **Storage:** the overlay home + /tmp share a small quota; the workspace volume is large — put SDK/AVD/Gradle state and logs there. Under quota pressure JVMs die with SIGBUS in hsperfdata; set `_JAVA_OPTIONS=-XX:-UsePerfData`.
- **No KVM:** boot with `-no-accel` (x86_64 works under TCG); cold boot takes minutes and post-boot package scanning lags, so retry installs/launches rather than failing fast.
- **GUI libs:** the emulator binary needs libX11 from the nix store via `LD_LIBRARY_PATH`; run headless with `-no-window`.
- **Snapshots:** restoring snapshots after TCG boots corrupts system_server; run `-no-snapshot` and wipe userdata between runs.
- **Networking into the device:** qemu's 10.0.2.2 host alias does NOT reach this container's loopback — use `adb reverse` and have the device talk to 127.0.0.1.
- **No cellular modem:** the emulated modem never registers here (no `isms` binder service; every `SmsManager` op, including `divideMessage`, throws UnsupportedOperationException) even though telephony features are declared. Feature checks do not predict this. Do not burn cycles trying to make outbound SMS work locally: verify everything except the radio-accept leg here, and let CI/hardware own the SENT assertion. An unfinished-batch state is likewise unreachable locally (divideMessage fails before any send), so it can only be seeded or produced on hardware.

**Why:** these were each multi-hour dead ends; the recipe is reusable for any future Android verification task.

**How to apply:** follow this recipe instead of concluding emulator verification is impossible; only physical Pixel runs still need the hardware workstation.
