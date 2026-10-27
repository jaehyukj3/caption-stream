// 강의 자막 송출 안드로이드 앱.
// 화면은 웹 송출 페이지(/host)를 그대로 띄우고, 음성인식만 앱이 직접 한다 (sherpa-onnx, 폰 CPU 여러 코어 사용).
// 필요: app/libs/sherpa-onnx-1.13.8.aar (scripts/build-android.sh가 받아 둔다)
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val site = System.getenv("SITE_URL") ?: "https://caption-relay.jaehyukj3.workers.dev"

android {
    namespace = "io.github.jaehyukj3.captionhost"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.jaehyukj3.captionhost"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("APP_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("APP_VERSION_NAME") ?: "dev"
        buildConfigField("String", "SITE", "\"$site\"")
        // 요즘 안드로이드 폰은 거의 모두 64비트 ARM. 사이트 파일 한 개 25MB 제한 때문에도 하나만 넣는다.
        ndk { abiFilters += "arm64-v8a" }
    }

    // 업데이트 설치가 되려면 항상 같은 키로 서명해야 한다 (시험 배포용 키, 저장소에 포함)
    signingConfigs {
        create("release") {
            storeFile = file("../signing/caption-host.jks")
            storePassword = "caption-host"
            keyAlias = "caption-host"
            keyPassword = "caption-host"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging {
        jniLibs {
            // 자바(코틀린) 연결 라이브러리만 쓰므로 C/C++ API 라이브러리는 뺀다
            excludes += listOf("**/libsherpa-onnx-c-api.so", "**/libsherpa-onnx-cxx-api.so")
            // 압축해 넣어 APK를 작게 (설치 때 풀린다)
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation(files("libs/sherpa-onnx-1.13.8.aar"))
}
