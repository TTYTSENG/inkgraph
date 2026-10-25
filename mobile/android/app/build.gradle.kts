plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "app.inkgraph.capture"
    compileSdk = 36
    defaultConfig {
        applicationId = "app.inkgraph.capture.dev"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-test"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
