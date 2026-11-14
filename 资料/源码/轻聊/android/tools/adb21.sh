#!/usr/bin/env bash
# 通用 adb 执行器：保证 adb server 在线 + 设备已连接后执行传入的命令
# 用法: adb21.sh shell getprop ro.build.version.sdk
export MSYS_NO_PATHCONV=1
ADB="D:/android-sdk/platform-tools/adb.exe"
DEV="${WB_DEV:-127.0.0.1:5557}"

$ADB start-server >/dev/null 2>&1
$ADB connect "$DEV" >/dev/null 2>&1
for i in $(seq 1 25); do
  st=$($ADB -s "$DEV" get-state 2>/dev/null)
  [ "$st" = "device" ] && break
  sleep 2
done
if [ "$st" != "device" ]; then echo "DEVICE_NOT_READY state=$st"; exit 1; fi

exec "$ADB" -s "$DEV" "$@"
