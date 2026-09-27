---
name: Local APK build gate
description: The android-test-package APK build gate can be satisfied locally without CI or an emulator.
---

The packaging APK build gate (build-android-test-apk.ps1) can run locally: install cmdline-tools + `platforms;android-35` + `build-tools;35.0.0` + platform-tools into ~/android-sdk via sdkmanager (skip emulator images), and use the Gradle release pinned in gradle-version.txt (download from services.gradle.org — the nix-store Gradle may be a different version). `gradle :app:assembleDebug --no-daemon` then succeeds with ANDROID_HOME set.

**Why:** a shipped kit once failed to compile because CI was not yet covering the APK build (`break`/`continue` in an inline `getOrElse` lambda is experimental in the pinned Kotlin 2.0.21) — only the local build gate caught it, so local builds are a real substitute for a green CI run.

**How to apply:** for packaging/repackaging tasks, prefer this local build over waiting on CI; afterwards delete `.gradle/` and `app/build/` from the package (the packaging script strips them anyway). Note pwsh via nix profile has multi-minute cold starts — run PowerShell checks as background tasks.
