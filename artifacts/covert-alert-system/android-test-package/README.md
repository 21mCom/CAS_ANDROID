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

## Measurement notes

The package records trigger time immediately before forwarding and stores both
`wallClockMs` and `elapsedRealtimeMs`, allowing cold/warm/locked/reboot
comparisons on the device. It does not claim a pass automatically: the
operator must record the physical result in the CAS console's Gate 0A
observation and document any abnormal transition, extra splash/frame, wrong
task, broken Back behavior, or stray Recents card.