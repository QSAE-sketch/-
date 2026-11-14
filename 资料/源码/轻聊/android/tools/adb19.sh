#!/usr/bin/env bash
# 通用 API19 adb 执行器：保证 adb server 在线后执行传入的命令
export MSYS_NO_PATHCONV=1
ADB="D:/android-sdk/platform-tools/adb.exe"
DEV="${WB_DEV:-emulator-5556}"

$ADB start-server >/dev/null 2>&1
$ADB -s $DEV wait-for-device >/dev/null 2>&1
for i in $(seq 1 20); do
  st=$($ADB -s $DEV get-state 2>/dev/null)
  [ "$st" = "device" ] && break
  sleep 2
done
if [ "$st" != "device" ]; then echo "DEVICE_NOT_READY state=$st"; exit 1; fi

exec "$ADB" -s $DEV "$@"
