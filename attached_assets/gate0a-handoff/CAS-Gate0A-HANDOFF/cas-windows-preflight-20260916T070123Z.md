# CAS Pixel Gate 0A Windows preflight

- **Overall status:** `PASS`
- **Generated (UTC):** `2026-09-16T07:01:23.2797805Z`
- **Target mode:** `physical`
- **Computer:** `CORDINATOR`

## Checks

| Status | Required | Check | Observed | Expected |
| --- | --- | --- | --- | --- |
| PASS | True | Android SDK environment variables | Using C:\Users\CAS_DEV\AppData\Local\Android\Sdk | ANDROID_SDK_ROOT or ANDROID_HOME points to the Android SDK folder. |
| PASS | True | JAVA_HOME | C:\Users\CAS_DEV\AppData\Local\Programs\Eclipse Adoptium\jdk-25.0.4.101-hotspot | JAVA_HOME points to a JDK 17 or newer installation. |
| PASS | True | Java command | Java 25.0.4.1 (major 25) at C:\Users\CAS_DEV\AppData\Local\Programs\Eclipse Adoptium\jdk-25.0.4.101-hotspot\bin\java.exe | JDK 17 or newer. |
| PASS | True | Java PATH entry | C:\Users\CAS_DEV\AppData\Local\Programs\Eclipse Adoptium\jdk-25.0.4.101-hotspot\bin | JAVA_HOME\bin is present in PATH. |
| PASS | True | Android SDK folder | C:\Users\CAS_DEV\AppData\Local\Android\Sdk | An existing Android SDK folder. |
| PASS | True | Android platform-tools | C:\Users\CAS_DEV\AppData\Local\Android\Sdk\platform-tools\adb.exe | platform-tools\adb.exe exists in the selected SDK. |
| PASS | True | platform-tools PATH entry | C:\Users\CAS_DEV\AppData\Local\Android\Sdk\platform-tools | The SDK platform-tools folder is present in PATH. |
| PASS | True | ADB command | Android Debug Bridge version 1.0.41 | ADB responds to adb version. |
| PASS | True | Android build-tools | 36.0.0 | Build-tools 35.0.0 or newer. |
| PASS | True | Android API 35 platform | C:\Users\CAS_DEV\AppData\Local\Android\Sdk\platforms\android-35\android.jar | platforms\android-35\android.jar exists. |
| PASS | True | Git Bash command | C:\Program Files\Git\bin\bash.exe | Git Bash is available for the guarded Pixel 11 Gate 0A runner. |
| PASS | True | Gradle command | Gradle 9.7.0 at C:\Gradle\gradle-9.7.0\bin\gradle.bat | Gradle 8.9 or newer. |
| PASS | False | Android command-line tools | C:\Users\CAS_DEV\AppData\Local\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat | sdkmanager.bat is available for optional, confirmed SDK preparation. |
| PASS | True | Physical-device ADB status | Authorized physical device detected: 67270DLKY00E9K         device product:cubs model:Pixel_11 device:cubs transport_id:9 | An authorized physical device appears as device in adb devices -l. |
| SKIPPED | False | Android Emulator tool | Skipped because target mode is physical. | Not evaluated. |
| SKIPPED | False | Emulator ADB status | Skipped because target mode is physical. | Not evaluated. |

## Safety record

- This preflight does not install an APK, change Device Owner state, reboot a device, send a message, or capture evidence.
- Device actions performed: `False`
- SDK preparation actions: `None`

## Attachments

Attach this Markdown file and the matching JSON file to the CAS field-run record. A `BLOCKED` result means the Gate 0A run must not continue. A `WARN` result requires the operator to resolve or document the warning before the field run.
