#!/usr/bin/env bash
# 안드로이드 송출 앱(android/)을 빌드해 사이트에 올릴 폴더로 복사한다.
# 필요: JDK 17, Android SDK(ANDROID_HOME), gradle
# 사용: bash scripts/build-android.sh <출력 폴더(client/dist/app)>
# 환경 변수: APP_VERSION_CODE(정수) APP_VERSION_NAME SITE_URL
set -euo pipefail
out="${1:?출력 폴더}"
root="$(cd "$(dirname "$0")/.." && pwd)"
aar="$root/android/app/libs/sherpa-onnx-1.13.8.aar"
if [ ! -f "$aar" ]; then
  mkdir -p "$(dirname "$aar")"
  curl -fsSL -o "$aar" https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-1.13.8.aar
fi

cd "$root/android"
set +e
gradle --no-daemon assembleRelease 2>&1 | tee build.log
status=${PIPESTATUS[0]}
set -e
if [ "$status" -ne 0 ]; then
  # 컴파일 오류를 GitHub 화면에 보이게
  grep -E '^e: |error:|What went wrong' -A3 build.log | head -40 | while IFS= read -r line; do echo "::error title=android::$line"; done
  exit "$status"
fi

apk="app/build/outputs/apk/release/app-release.apk"
mkdir -p "$out"
cp "$apk" "$out/caption-host.apk"
size=$(stat -c %s "$out/caption-host.apk")
# 사이트 정적 파일은 한 개 25MiB까지
[ "$size" -lt $((25 * 1024 * 1024)) ] || { echo "::error title=android::APK가 25MB를 넘습니다 ($size)"; exit 1; }
printf '{"versionCode":%s,"versionName":"%s","size":%s}\n' "${APP_VERSION_CODE:-1}" "${APP_VERSION_NAME:-dev}" "$size" > "$out/version.json"
echo "안드로이드 앱: $out/caption-host.apk ($((size / 1024 / 1024))MB)"
