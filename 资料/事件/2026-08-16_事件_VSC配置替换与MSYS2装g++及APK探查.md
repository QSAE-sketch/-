# 2026-08-16 事件 · VSC配置替换 + MSYS2装g++ + Via浏览器识别 + APK工具讨论

## 背景
- 大佬桌面有 `Code-用户配置` 文件夹，想用它替换本机 VSC 的 User 目录（%APPDATA%\Code\User）。
- 本机原本没有 g++，无法编译 C++。
- 桌面有个 `Via浏览器.apk`，大佬想知道是啥、能不能"用"。

## 过程
1. **VSC 用户配置替换（已做）**
   - 先备份当前 User → `Code\User.backup-20260816`（60 文件，可回退）。
   - 核查：源配置全英文（settings.json 含 godotTools / g++ / code-runner），无中文需改；源比目标多 `profiles\` 和 `agent-sessions.code-workspace`。
   - 当时 VSC 未运行；robocopy 覆盖 544 文件 0 失败。
   - 验证：目标 settings.json 已换成源版本，新增项到位。**需重启 VSC 才生效**。

2. **MSYS2 + g++ 安装（已做）**
   - 来源：`D:\QQ\msys2-base-x86_64-20240507.sfx.exe`（MSYS2 base 自解压包），大佬双击解压到 `D:\QQ\msys64`。
   - 首次双击 `D:\QQ\msys64\msys2.exe` 跑完 pacman GnuPG 密钥初始化（窗口自动退出为正常现象）。
   - 我接管：`pacman -Syu` 三轮更新底座 + `pacman -S mingw-w64-x86_64-gcc` 装 g++ **16.2.0**。
   - 用户 PATH 加入 `D:\QQ\msys64\mingw64\bin`（新开终端生效）。
   - 实测：写 hello.cpp → g++ 编译 → 运行成功。
   - 另建桌面 + 开始菜单 `MSYS2.bat` 快捷方式（解决"开始菜单搜不到"，便携版无开始菜单项）。

3. **Via浏览器.apk 识别（已做）**
   - 桌面 `Via浏览器.apk`（2.5MB）= **Via Browser**（包名 mark.via，上海知为网络科技）。
   - 极简轻量安卓浏览器：广告拦截、油猴脚本、隐私保护、资源嗅探、多搜索引擎。
   - 关键：APK 不能在 Windows 直接跑，需安卓模拟器/手机。

4. **"手搓能用APK的东西"讨论（放弃）**
   - 大佬想做个能用 APK 的工具；探查发现系统已有 adb（两处路径）+ 腾讯 Androws / TapTap 模拟器，但当时无任何模拟器在线。
   - 我提方案：选 APK → adb 装进模拟器 → 启动。大佬嫌步骤麻烦，说"算了不玩了"放弃。

## 成果
- VSC 配置已替换（重启即生效）
- g++ 16.2.0 可用（新终端敲 `g++ --version` 即出）
- Via浏览器已识别
- APK 使用工具：未做

## 遗留
- VSC 需重启生效
- g++ 当前旧会话 PATH 需重开终端
- U盘"新计划"当时未到（详细说明在U盘），未处理
- APK 工具放弃（如日后想做，本机 adb + Androws/TapTap 已就绪，直接可做）

## 关联文件
- 资源/2026-08-16_发现_机器1装好MinGW-w64_g++16.2.0.md
- 资源/2026-08-16_发现_桌面Via浏览器APK是Via_Browser轻量浏览器.md
- 资源/2026-08-16_发现_机器1已有adb与Androws_TapTap模拟器.txt
