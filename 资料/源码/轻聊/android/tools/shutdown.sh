export MSYS_NO_PATHCONV=1
ADB="D:/android-sdk/platform-tools/adb.exe"
$ADB start-server >/dev/null 2>&1
for d in emulator-5554 emulator-5556; do
  $ADB -s $d emu kill >/dev/null 2>&1 && echo "已关闭 $d"
done
