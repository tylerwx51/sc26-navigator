#!/usr/bin/env bash
# Create (once) and boot a headless x86_64 emulator. Run inside `nix develop`.
set -euo pipefail
cd "$(dirname "$0")/.."
AVD=sc26_api35
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$PWD/.avd}"
mkdir -p "$ANDROID_AVD_HOME"
if ! avdmanager list avd 2>/dev/null | grep -q "Name: $AVD"; then
  echo no | avdmanager create avd -n "$AVD" -k "system-images;android-35;google_apis;x86_64" -d pixel_6 --force
fi
if ! adb devices | grep -q '^emulator-'; then
  nohup emulator -avd "$AVD" -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect \
    -no-snapshot -camera-back none -camera-front none > "${EMU_LOG:-/tmp/sc26-emulator.log}" 2>&1 &
fi
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
echo "emulator ready: $(adb devices | grep emulator)"
