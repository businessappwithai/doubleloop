pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    resolutionStrategy {
        eachPlugin {
            when (requested.id.id) {
                "com.google.dagger.hilt.android" -> useModule("com.google.dagger:hilt-android-gradle-plugin:${requested.version}")
            }
        }
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
    versionCatalogs {
        create("libs") {
            val agpVersion = "8.3.0"
            val kotlinVersion = "1.9.23"
            val composeBomVersion = "2024.06.00"
            val composeVersion = "1.6.7"
            val composeMaterial3Version = "1.2.1"
            val composeCompilerVersion = "1.5.14"
            val roomVersion = "2.6.1"
            val hiltVersion = "2.50"
            val lifecycleVersion = "2.7.0"
            val navigationVersion = "2.7.7"
            val retrofitVersion = "2.10.0"
            val okhttpVersion = "4.12.0"
            val coroutinesVersion = "1.7.3"
            val datastoreVersion = "1.0.0"

            // Versions
            version("agp", agpVersion)
            version("kotlin", kotlinVersion)
            version("composeBom", composeBomVersion)
            version("compose", composeVersion)
            version("composeMaterial3", composeMaterial3Version)
            version("composeCompiler", composeCompilerVersion)
            version("room", roomVersion)
            version("hilt", hiltVersion)
            version("lifecycle", lifecycleVersion)
            version("navigation", navigationVersion)
            version("retrofit", retrofitVersion)
            version("okhttp", okhttpVersion)
            version("coroutines", coroutinesVersion)
            version("datastore", datastoreVersion)

            // Plugins
            plugin("android-application", "com.android.application").version(agpVersion)
            plugin("android-library", "com.android.library").version(agpVersion)
            plugin("kotlin-android", "org.jetbrains.kotlin.android").version(kotlinVersion)
            plugin("kotlin-kapt", "org.jetbrains.kotlin.kapt").version(kotlinVersion)
            plugin("kotlin-parcelize", "org.jetbrains.kotlin.plugin.parcelize").version(kotlinVersion)
            plugin("hilt-android", "com.google.dagger.hilt.android").version(hiltVersion)

            // Kotlin
            library("kotlin-stdlib", "org.jetbrains.kotlin:kotlin-stdlib:$kotlinVersion")

            // Android Core
            library("appcompat", "androidx.appcompat:appcompat:1.6.1")
            library("coreKtx", "androidx.core:core-ktx:1.13.0")
            library("material", "com.google.android.material:material:1.11.0")

            // Compose BOM
            library("composeBom", "androidx.compose:compose-bom:$composeBomVersion")

            // Compose UI
            library("composeUI", "androidx.compose.ui:ui")
            library("composeUIGraphics", "androidx.compose.ui:ui-graphics")
            library("composeUIPreview", "androidx.compose.ui:ui-tooling-preview")
            library("composeTooling", "androidx.compose.ui:ui-tooling")
            library("composeRuntime", "androidx.compose.runtime:runtime")
            library("composeFoundation", "androidx.compose.foundation:foundation")
            library("composeMaterial", "androidx.compose.material:material")
            library("composeMaterialIconsExtended", "androidx.compose.material:material-icons-extended")

            // Compose Material3
            library("composeMaterial3", "androidx.compose.material3:material3:$composeMaterial3Version")

            // Compose Integration
            library("composeActivity", "androidx.activity:activity-compose:1.8.1")
            library("composeNavigation", "androidx.navigation:navigation-compose:$navigationVersion")
            library("composeConstraintLayout", "androidx.constraintlayout:constraintlayout-compose:1.0.1")
            library("composeLifecycle", "androidx.lifecycle:lifecycle-runtime-compose:$lifecycleVersion")
            library("composeHilt", "androidx.hilt:hilt-navigation-compose:1.2.0")

            // Lifecycle
            library("lifecycleRuntime", "androidx.lifecycle:lifecycle-runtime-ktx:$lifecycleVersion")
            library("lifecycleViewModel", "androidx.lifecycle:lifecycle-viewmodel-ktx:$lifecycleVersion")
            library("lifecycleViewModelCompose", "androidx.lifecycle:lifecycle-viewmodel-compose:$lifecycleVersion")

            // Room Database
            library("roomRuntime", "androidx.room:room-runtime:$roomVersion")
            library("roomCompiler", "androidx.room:room-compiler:$roomVersion")
            library("roomKtx", "androidx.room:room-ktx:$roomVersion")

            // Hilt Dependency Injection
            library("hilt", "com.google.dagger:hilt-android:$hiltVersion")
            library("hiltCompiler", "com.google.dagger:hilt-compiler:$hiltVersion")

            // Coroutines
            library("coroutinesCore", "org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")
            library("coroutinesAndroid", "org.jetbrains.kotlinx:kotlinx-coroutines-android:$coroutinesVersion")

            // Networking
            library("retrofit", "com.squareup.retrofit2:retrofit:$retrofitVersion")
            library("retrofitGson", "com.squareup.retrofit2:converter-gson:$retrofitVersion")
            library("okhttp", "com.squareup.okhttp3:okhttp:$okhttpVersion")
            library("okhttpLogging", "com.squareup.okhttp3:logging-interceptor:$okhttpVersion")
            library("gson", "com.google.code.gson:gson:2.10.1")

            // DataStore
            library("datastore", "androidx.datastore:datastore-preferences:$datastoreVersion")

            // Navigation
            library("navigationFragment", "androidx.navigation:navigation-fragment-ktx:$navigationVersion")
            library("navigationUi", "androidx.navigation:navigation-ui-ktx:$navigationVersion")

            // Serialization
            library("kotlinxSerialization", "org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

            // Testing
            library("junit", "junit:junit:4.13.2")
            library("junitExt", "androidx.test.ext:junit:1.1.5")
            library("espresso", "androidx.test.espresso:espresso-core:3.5.1")
            library("composeJunit4", "androidx.compose.ui:ui-test-junit4")
            library("composeTestManifest", "androidx.compose.ui:ui-test-manifest")
            library("mockk", "io.mockk:mockk:1.13.10")
            library("turbine", "app.cash.turbine:turbine:1.0.0")
            library("coroutinesTest", "org.jetbrains.kotlinx:kotlinx-coroutines-test:$coroutinesVersion")

            // Bundles
            bundle(
                "compose",
                listOf(
                    "composeUI",
                    "composeUIGraphics",
                    "composeUIPreview",
                    "composeMaterial3",
                    "composeFoundation",
                    "composeMaterial"
                )
            )
            bundle(
                "compose-integration",
                listOf(
                    "composeActivity",
                    "composeNavigation",
                    "composeHilt",
                    "composeLifecycle"
                )
            )
            bundle(
                "room",
                listOf("roomRuntime", "roomKtx")
            )
            bundle(
                "networking",
                listOf("retrofit", "retrofitGson", "okhttp", "okhttpLogging")
            )
            bundle(
                "coroutines",
                listOf("coroutinesCore", "coroutinesAndroid")
            )
            bundle(
                "lifecycle",
                listOf("lifecycleRuntime", "lifecycleViewModel", "lifecycleViewModelCompose")
            )
            bundle(
                "testing",
                listOf("junit", "junitExt", "espresso", "mockk", "turbine", "coroutinesTest")
            )
        }
    }
}

rootProject.name = "TodoApp"

include(":app")