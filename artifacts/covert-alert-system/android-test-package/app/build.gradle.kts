import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
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
        versionCode = 3
        versionName = "0.4.0-mvp"
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
}