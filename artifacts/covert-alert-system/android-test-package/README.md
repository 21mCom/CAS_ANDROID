# CAS Pixel Gate 0A test package

Disposable native Android harness for the first physical run. It targets the
pinned reference device (**Google Pixel 8a, stock Android, API 35**) and tests
only the proxy-to-cover-app transition.

## Safety boundary

This package has no SMS, network, location, camera, microphone, evidence
capture, incident service, recipient, or production covert behavior. The
`DeviceAdminReceiver` declares no policies; its only purpose is to report
whether the package was provisioned as device owner during the experiment.
All timestamps and outcomes remain in device-local `SharedPreferences`.

## Build and install

From this directory, with Android SDK API 35 and a JDK 17 installation:

```sh
gradle :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

There is intentionally no Gradle wrapper checked in; use the Android toolchain
provided by the hardware-run workstation.

The `adb install -r` command above is a separate, explicit operator action
after the workstation preflight passes. The Windows preflight never runs it and
never uninstalls an APK.

## Pinned emulator rehearsal

The approved emulator contract is deliberately separate from the managed
physical run:

| Setting | Pinned value |
| --- | --- |
| AVD name | `CAS_Pixel_8a_API_35` |
| Device profile | `pixel_8a` |
| Android image | `system-images;android-35;google_apis;x86_64` |
| API level | 35 |
| Architecture | x86_64 |
| Repeatability settings | animation scales `0`; `stay_on_while_plugged_in=3` |
| Evidence label | `simulated-emulator` |

From the copied Windows test kit, the single lifecycle entry point is:

```powershell
scripts\run-pixel-emulator.cmd -Action start
```

`start` creates the pinned AVD when it does not exist, then reuses it for each
rehearsal. The command waits for boot, verifies API 35, x86_64, the QEMU
marker, the pinned AVD identity, the required settings, and a write/read/remove check under
`/data/local/tmp`. It writes labeled JSON and Markdown records to
`emulator-results`.

Available lifecycle actions are:

```powershell
scripts\run-pixel-emulator.cmd -Action create
scripts\run-pixel-emulator.cmd -Action start
scripts\run-pixel-emulator.cmd -Action wait
scripts\run-pixel-emulator.cmd -Action status
scripts\run-pixel-emulator.cmd -Action reset
scripts\run-pixel-emulator.cmd -Action stop
```

`reset` stops only the pinned emulator, starts it with `-wipe-data`, reapplies
the repeatability settings, and reruns every validation check. It never
selects a physical ADB serial. `status` and `wait` are validation-only; they
do not change emulator settings. If the Android system image is missing,
prepare it through the explicitly approved `-PrepareSdk` preflight path before
creating the AVD.

Emulator records are simulation evidence. They are useful for proxy-to-cover
launch, task transitions, local journal behavior, cold/warm/reboot sequencing,
and software regressions. They are not proof of carrier SMS, GPS, SystemUI,
physical lock-screen behavior, managed Device Owner state, launcher behavior on
the field Pixel, or production readiness. Keep the emulator JSON/Markdown
record with the host timing log and mark the run as simulated when importing
or reviewing it.

## Windows workstation preflight

Use the Windows entry point before building or running the disposable package.
It is designed for an operator who should not have to guess which tools or
environment variables are missing:

1. Copy this `android-test-package` directory to the approved Windows test
   workstation.
2. Double-click `scripts/run-windows-preflight.cmd`.
3. Leave the default target as `physical` for the managed Pixel field run.
   Use `scripts/run-windows-preflight.cmd -Target emulator` only when the
   approved emulator is the intended target. `-Target both` checks both paths.
4. Review the plain-language `PASS`, `WARN`, and `BLOCKED` lines. For an
   emulator rehearsal, create/start the pinned AVD with
   `scripts\run-pixel-emulator.cmd -Action start` after the preflight passes.
5. Attach the matching JSON and Markdown files written to `preflight-results`
   to the CAS field-run record. Do not continue a Gate 0A run with a
   `BLOCKED` result.

The command file only starts the PowerShell preflight. The default preflight is
read-only: it checks local tools and reads `adb devices -l`, but it does not
install an APK, change Device Owner state, reboot a device, send a message, or
capture evidence. It returns exit code `0` for `PASS`, `1` for `WARN`, and `2`
for `BLOCKED`.

If the official Android SDK Command-line Tools are already installed, an
operator may explicitly prepare the SDK packages with:

```powershell
scripts\run-windows-preflight.cmd -Target physical -PrepareSdk
```

The script prints the package list and waits for the operator to type
`INSTALL`. Nothing is installed if that confirmation is not provided. The
optional preparation only covers `platform-tools`, `platforms;android-35`, and
`build-tools;35.0.0`; emulator mode also includes the official `emulator`
package and the pinned `system-images;android-35;google_apis;x86_64` package.
It never installs an APK or changes the device.

### Local preflight contract

The workstation must satisfy these checks before the native Gate 0A package is
built or measured:

| Area | Required result |
| --- | --- |
| Java | JDK 17 or newer; `JAVA_HOME` points to the JDK root and `JAVA_HOME\bin` is on `PATH` |
| Android SDK | `ANDROID_SDK_ROOT` or `ANDROID_HOME` points to an existing SDK; if both are set, they point to the same folder |
| Platform tools | `platform-tools\adb.exe` exists and `platform-tools` is on `PATH`; `adb version` succeeds |
| Android platform | `platforms\android-35\android.jar` exists |
| Build tools | Android Build-Tools 35.0.0 or newer exists |
| Gradle | Gradle 8.9 or newer is available on `PATH`; this matches the Android Gradle Plugin 8.7.3 used by the package |
| Physical target | An approved physical device appears as `device` in `adb devices -l`; `unauthorized` and `offline` are blocking states |
| Emulator target | `emulator\emulator.exe` exists; use the pinned lifecycle command to create/start and validate the emulator |

The result JSON uses schema `cas-windows-preflight-v1`. It contains the target
mode, host and tool observations, every check, next steps, the overall status,
and a safety record showing that no device action was performed. Later Gate 0A
commands can include the JSON alongside the in-app report and host timing log.

### Recovery paths

- **Missing SDK or API 35:** In Android Studio, open **Tools > SDK Manager**,
  select Android SDK Platform 35, Android SDK Build-Tools 35.0.0 or newer, and
  Android SDK Platform-Tools, then apply the change with the operator's
  approval. Alternatively, use the script's `-PrepareSdk` path after installing
  the official command-line tools.
- **`JAVA_HOME` or `ANDROID_SDK_ROOT` is missing:** Set the variable to the
  installation folder, not its `bin` or `platform-tools` child folder. If both
  `ANDROID_SDK_ROOT` and `ANDROID_HOME` are present, make them identical or
  clear the obsolete one. Close and reopen the command window after changing
  variables.
- **PATH issues:** Add the JDK `bin` folder, the SDK `platform-tools` folder,
  and the Gradle `bin` folder to the user or approved workstation `PATH`.
  Re-run the preflight from a new window; an old window keeps the old PATH.
- **ADB says `unauthorized`:** Unlock the approved device and accept the RSA
  debugging prompt on the device. If the prompt is missing, use the device's
  Developer options to revoke USB debugging authorizations, reconnect the
  cable, and accept the new prompt. The preflight does not clear authorizations
  or change Device Owner state.
- **ADB says `offline` or no device is listed:** Check the USB cable, Windows
  Device Manager, the selected USB mode, and whether USB debugging is enabled.
  For an emulator, run `scripts\run-pixel-emulator.cmd -Action start` and
  review its API, architecture, boot, settings, and writable-state checks. Do
  not treat a missing device or a passing emulator check as a physical Gate 0A
  pass.
- **Windows permission or antivirus blocks a tool:** Use an approved,
  administrator-reviewed installation location and allow the signed Android
  and Java tools through the organization's policy. Do not work around
  Windows security by downloading replacement binaries or disabling protection.
- **Gradle cannot run:** Confirm the `gradle` executable on PATH is 8.9 or
  newer and that Java points to the same JDK 17+ installation. The package has
  no checked-in Gradle wrapper, so the workstation's approved Gradle
  installation is intentional.

The preflight does not provision Device Owner mode, install or uninstall an
APK, factory-reset a device, send SMS/XMPP, or collect evidence. Those actions,
if ever approved for a later experiment, require a separate explicit procedure
and confirmation.

For a managed-device experiment, provision the package as device owner using
the workstation's approved test-device procedure. The app does not silently
change device-owner state.

## Gate 0A run

1. Open **CAS Pixel Gate 0A** and enter the installed cover package name.
2. Save the cover app and request the pinned proxy shortcut. The launcher owns
   the final pin confirmation.
3. Run the proxy from the shortcut for cold, warm, locked, after reboot, and
   repeat-launch samples (the handoff calls for at least 200 repeats).
4. Exercise Back/Home/Recents, Settings > App info, notifications, and
   Quick Settings with an ordinary observer.
5. Copy the JSON report after each run. It includes wall-clock and elapsed
   trigger timestamps, cover launch outcomes, boot observations, task and
   Recents artifacts, Back observations, permission state, device-owner state,
   shortcut state, and explicit observer review items.

`NOT_LAUNCHED` is a recorded result when the cover package is missing or has no
launcher intent. A failed cover launch never performs any other action.

For a software rehearsal, start the pinned emulator first and run the same
proxy flow. The host log begins with the emulator serial, AVD, API, ABI,
fingerprint, image, and the `simulated-emulator` evidence label. Attach the
matching `emulator-results` JSON/Markdown record as well. Do not import or
describe emulator output as physical evidence.

## Measurement notes

The package records trigger time immediately before forwarding and stores both
`wallClockMs` and `elapsedRealtimeMs`, allowing cold/warm/locked/reboot
comparisons on the device. It does not claim a pass automatically: the
operator must record the physical result in the CAS console's Gate 0A
observation and document any abnormal transition, extra splash/frame, wrong
task, broken Back behavior, or stray Recents card.

The measurement script detects the QEMU marker and writes
`evidenceClass=simulated-emulator` plus image metadata when it is run against
the pinned AVD. This is a software rehearsal log, not a replacement for the
managed Pixel run.