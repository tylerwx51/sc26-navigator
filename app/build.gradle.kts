plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val gitCommitCount: Int = (findProperty("sc26.versionCode") as String?)?.toInt()
    ?: providers.exec { commandLine("git", "rev-list", "--count", "HEAD") }
        .standardOutput.asText.get().trim().toInt()

val releaseKeystore: File = file(
    (findProperty("sc26.keystore") as String?)
        ?: System.getenv("SC26_KEYSTORE")
        ?: "${System.getProperty("user.home")}/.config/sc26-navigator/signing.keystore"
)

android {
    namespace = "org.sc26.navigator"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "org.sc26.navigator"
        minSdk = 26
        targetSdk = 35
        // versionCode = number of commits on HEAD, so every published commit is a
        // strictly newer Android update (the phone's first install was code 1).
        // The tag/Release for a build is "v$versionName" (see scripts/publish.sh).
        versionCode = gitCommitCount
        versionName = "1.0.$gitCommitCount"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            // The key the installed phone app is signed with. It is NOT in the repo
            // (the repo is public). Android rejects updates signed with any other key,
            // and the only fix is uninstalling, which wipes saved ★ sessions.
            storeFile = releaseKeystore
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (releaseKeystore.exists()) {
                signingConfigs.getByName("release")
            } else {
                logger.warn("WARNING: $releaseKeystore missing; release APK signed with the local debug key. It will NOT update the phone install.")
                signingConfigs.getByName("debug")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    androidResources {
        // keep SVG / JSON assets uncompressed-friendly and never strip them
        noCompress += listOf("json")
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")

    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.test.espresso:espresso-web:3.6.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
