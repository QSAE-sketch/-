#!/usr/bin/env bash
# APK 产物校验：包信息 / 签名 / 权限 / dex 内容
set -u
SDK=/d/android-sdk
BT=$SDK/build-tools/34.0.0
APK="${1:?用法: verify_apk.sh <apk路径>}"
AAPT=$(ls $BT/aapt2.exe 2>/dev/null || echo "$BT/aapt2")
APKSIGNER="$BT/apksigner.bat"

echo "════════ 产物信息 ════════"
ls -lh "$APK"
echo ""
echo "SHA-256: $(sha256sum "$APK" | cut -d' ' -f1)"
echo ""

echo "════════ badging（包名/版本/SDK/权限/特性）════════"
"$AAPT" dump badging "$APK" 2>/dev/null | grep -E "^package:|^sdkVersion:|^targetSdkVersion:|^application-label:|^uses-permission:|^uses-feature:|^launchable-activity:|^native-code" | head -25
echo ""

echo "════════ 签名校验 ════════"
"$APKSIGNER" verify --print-certs --verbose "$APK" 2>&1 | grep -E "Verifies|Verified using|Signer #1 certificate DN|Signer #1 certificate SHA-256|Number of signers|^DOES NOT VERIFY" | head -12
echo ""

echo "════════ 关键类是否打包 ════════"
"$BT/dexdump.exe" -f "$APK" 2>/dev/null | head -2 >/dev/null
unzip -l "$APK" 2>/dev/null | grep -E "classes.dex|resources.arsc|AndroidManifest" | head -5
