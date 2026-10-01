import groovy.json.JsonSlurper
import java.security.KeyStore
import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The responder capture-request wake (FCM) is enabled per build: drop the
// Firebase project's google-services.json into this directory and the plugin
// wires the configuration in. Without the file the build is the polling-only
// kit — Firebase never initializes at runtime (journaled as PUSH_UNAVAILABLE)
// and capture requests are still honored on the handset's next server contact.
// The file holds build configuration, not a credential, but it is deployment-
// specific and stays out of the repo (gitignored).
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

// tool-requirements.json at the package root is the single source of truth for
// the Android SDK platform a workstation and CI must provide; compile against
// exactly that declared platform.
val toolRequirements = JsonSlurper()
    .parseText(rootProject.projectDir.resolve("tool-requirements.json").readText()) as Map<*, *>
val declaredApiLevel = ((toolRequirements["androidSdk"] as Map<*, *>)["apiLevel"] as Number).toInt()

// Field release signing key. Android only accepts an update signed with the
// SAME certificate as the installed app, so every kit APK must be signed with
// this one pinned key from now on — the day the key changes, every field
// phone needs a manual uninstall/reinstall that loses the stored enrollment.
// Key material is NEVER committed: it comes from the workspace secrets
// CAS_RELEASE_KEYSTORE_B64 (base64 of the .keystore file) and
// CAS_RELEASE_KEYSTORE_PASSWORD, exported as environment variables before the
// build (see HANDOFF-TEST-KIT.md T1). The committed half of the pin is the
// certificate's SHA-256 fingerprint in signing/field-release-cert.sha256.txt,
// which the packaging gate (scripts/build-android-test-apk.ps1) verifies the
// built APK against — a certificate fingerprint is public, not a secret.
// When the secrets are absent (e.g. contributor/CI checkouts), builds fall
// back to the default debug key and the gate reports the APK as debug-signed.
val fieldKeystoreB64 = System.getenv("CAS_RELEASE_KEYSTORE_B64")?.trim().orEmpty()
val fieldSigningConfigured = fieldKeystoreB64.isNotEmpty()
if (fieldSigningConfigured && System.getenv("CAS_RELEASE_KEYSTORE_PASSWORD").isNullOrEmpty()) {
    throw GradleException(
        "CAS_RELEASE_KEYSTORE_B64 is set but CAS_RELEASE_KEYSTORE_PASSWORD is not; " +
            "export both (see HANDOFF-TEST-KIT.md T1) or unset both for a debug-signed build."
    )
}

android {
    namespace = "com.covertalert.pixeltest"
    compileSdk = declaredApiLevel

    defaultConfig {
        applicationId = "com.covertalert.pixeltest"
        // minSdk/targetSdk pin the approved-device baseline (Pixel 11, API 35+);
        // they are a product contract, not a workstation prerequisite.
        minSdk = 35
        targetSdk = 35
        versionCode = 8
        versionName = "0.8.1"
    }

    if (fieldSigningConfigured) {
        val fieldKeystoreFile = layout.buildDirectory.get().asFile.resolve("field-release.keystore").apply {
            parentFile.mkdirs()
            writeBytes(Base64.getDecoder().decode(fieldKeystoreB64))
        }
        // Read the key alias from the keystore itself (it holds exactly one
        // PrivateKeyEntry) so the pin travels with whatever alias the owner's
        // keystore uses, instead of hardcoding one here.
        val fieldKeyAlias = KeyStore.getInstance("PKCS12").run {
            fieldKeystoreFile.inputStream().use {
                load(it, System.getenv("CAS_RELEASE_KEYSTORE_PASSWORD").toCharArray())
            }
            val entryAliases = aliases().toList()
            if (entryAliases.size != 1) {
                throw GradleException("The field release keystore must contain exactly one key entry; found ${entryAliases.size}.")
            }
            entryAliases.single()
        }
        signingConfigs {
            create("fieldRelease") {
                storeFile = fieldKeystoreFile
                storePassword = System.getenv("CAS_RELEASE_KEYSTORE_PASSWORD")
                keyAlias = fieldKeyAlias
                keyPassword = System.getenv("CAS_RELEASE_KEYSTORE_PASSWORD")
            }
        }
        // Sign BOTH build types with the pinned key: the kit installs the debug
        // build (scripts/mvp-install.ps1), and those phones are exactly the
        // ones that must stay update-compatible with future kit builds.
        buildTypes {
            debug { signingConfig = signingConfigs["fieldRelease"] }
            release {
                isMinifyEnabled = false
                signingConfig = signingConfigs["fieldRelease"]
            }
        }
    } else {
        buildTypes {
            release {
                isMinifyEnabled = false
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.10.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // Capture-request push wake. The SDK is always compiled in so the service
    // and registration code are exercised by every build; without a
    // google-services.json (see above) Firebase simply never initializes and
    // every Firebase call here is guarded, so the polling-only kit is
    // unaffected.
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
    // JVM unit tests for the android-free cores (SendOutcomeStatus,
    // ReceiptDurability). Run with :app:testDebugUnitTest.
    testImplementation("junit:junit:4.13.2")
}