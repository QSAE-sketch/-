# 轻聊 · 原生客户端（Windows / Android）

这两端都是**真·原生**：界面由系统控件绘制，数据经 HTTP 直连服务端，不加载任何网页、不内嵌 WebView、不用 Electron。

| | 技术 | 体积 | 说明 |
|---|---|---|---|
| Windows | C++ / Win32 + GDI 自绘 | ~580 KB 单文件 | 无运行库依赖，静态链接 |
| Android | Java + 原生 Activity/ListView | ~120 KB | minSdk 19，红米 Note 2 可装 |

## 目录

```
native-win/
  src/json.h        极简 JSON 解析（header-only）
  src/http.h/.cpp   WinHTTP 封装（HTTPS / Cookie / 二进制）
  src/api.h/.cpp    业务接口（登录、房间、消息、文件分块上传）
  src/main.cpp      Win32 窗口 + GDI 绘制 + 后台线程调度
  src/selftest.cpp  命令行自检（不弹窗跑完整链路）
  app.manifest      comctl32 v6 + DPI 感知
  build.bat         一键构建（需 MinGW-w64）

android/app/src/main/java/com/qingliao/app/
  Api.java          网络层（HttpURLConnection + org.json）
  Store.java        本地存储（多账号 / 记住密码）
  LoginActivity.java 登录 / 注册 / 选账号
  MainActivity.java 聊天主界面
  MsgAdapter.java   消息列表
```

## 构建

Windows（需要 MinGW-w64 的 g++ / windres 在 PATH）：

```bat
cd native-win
build.bat
```

Android：

```bash
cd android
JAVA_HOME=/c/Program\ Files/Java/jdk-22 ./../../android-sdk/gradle-8.9/bin/gradle assembleRelease
# 产物：app/build/outputs/apk/release/轻聊.apk
```

## 登录体验（对齐 QQ）

- **记住密码**：密码用系统加密保存在本机（Windows 走 DPAPI，只对当前系统账户可解；Android 走应用私有目录 + 混淆）。下次打开密码框直接隐藏。
- **自动登录**：勾选后下次启动直接进聊天界面。
- **多账号**：登录过的账号以头像横排展示，点选后一键登录；长按头像或「账号管理」可移除。**只有输入过密码并成功登录过的账号才会出现在这里。**

## 内置调试参数（Windows）

| 参数 | 作用 |
|---|---|
| `--base <url>` | 临时指定服务器，如 `http://127.0.0.1:3311` |
| `--shot <bmp>` | 启动后截一张界面图再退出（无人值守验证） |
| `--seed <账号> <密码> [1]` | 写入本地凭据后退出，末尾 `1` 表示设为自动登录 |

## 已知限制

- 原生端暂不显示图片/视频缩略图，图片消息以文件卡片呈现，点击可保存到本机。
- 群管理（转让、解散、禁言等）目前只在网页版提供完整入口。
- 消息轮询 3 秒一次；页面不可见时自动停掉。
