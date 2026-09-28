import groovy.json.JsonSlurper

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

android {
    namespace = "com.covertalert.pixeltest"
    compileSdk = declaredApiLevel

    defaultConfig {
        applicationId = "com.covertalert.pixeltest"
        // minSdk/targetSdk pin the approved-device baseline (Pixel 11, API 35+);
        // they are a product contract, not a workstation prerequisite.
        minSdk = 35
        targetSdk = 35
        versionCode = 6
        versionName = "0.7.0-push"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
}