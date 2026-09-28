plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    // Applied by the app module only when a google-services.json is present
    // (responder capture-request push wake); declared here so the version is
    // pinned for field builds.
    id("com.google.gms.google-services") version "4.4.2" apply false
}