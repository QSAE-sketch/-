---
name: 转 APK
description: 把网站或桌面应用程序生成为 Android APK 安装包。使用 WebView 包装（网站类应用）或 Chaquopy/Kivy（Python 桌面应用）。触发词：转成 APK、生成安卓应用、打包安卓、做成 APK、Android 安装包、make apk。
agent_created: true
trigger_keywords:
  - 转成APK
  - 生成APK
  - 打包安卓
  - 安卓应用
  - Android 安装包
  - 生成安卓
  - APK
  - make apk
  - build android
---

# 转 APK Skill

## 概述

将网站、网页应用或桌面应用程序生成为 Android APK 安装包。根据源应用类型选择最优转换路径：

| 源类型 | 推荐方案 | 说明 |
|-------|---------|------|
| 网站 / HTML 应用 | WebView 包装 | 最简单，把网页嵌进 Android WebView |
| Python 桌面应用 | Chaquopy / Kivy | 嵌入 Python 运行时或重写 UI |
| 已转远程网站的桌面应用 | WebView 包装 | 先经过 desktop-to-remote-web 转换后，直接走 WebView 方案 |
| Electron / Node.js 应用 | Capacitor | 用 Capacitor 包装成混合应用 |

## 触发条件

用户说出类似以下内容时加载此 Skill：

- "把这个转成 APK"
- "生成安卓安装包"
- "打包成安卓应用"
- "做成 APK"
- "手机能用"
- "make an APK"
- "build android app"

## 工作流程

### 第 1 步：分析源应用

先搞清楚要转换的是什么：

1. **读取/分析源码**：
   - 网站/HTML 应用：前端技术栈（纯 HTML/CSS/JS、React、Vue 等）
   - Python 桌面应用：框架（Tkinter、PyQt 等）、依赖库、是否已有 Web 版本
   - Electron/Node.js 应用：依赖、打包配置
   - 如果用户只给了功能描述：先按网站类处理

2. **选择转换方案**：

   **方案 A：WebView 包装（推荐，支持大部分场景）**
   - 适用：纯前端网站、HTML 应用、已有远程地址的桌面转 Web 应用
   - 原理：创建 Android 项目，用 WebView 打开指定 URL 或加载本地 HTML
   - 输出：APK 文件
   - 优点：简单、快速、兼容性好

   **方案 B：Chaquopy（Python 桌面应用）**
   - 适用：Python 桌面应用有复杂后端逻辑、不能简单转为 Web
   - 原理：在 Android 项目中嵌入 Python 运行时
   - 输出：APK 文件
   - 优点：复用 Python 代码，不需要重写
   - 缺点：APK 体积大，构建复杂

   **方案 C：Capacitor（Electron/Node.js 应用）**
   - 适用：已有 Node.js 前端项目
   - 原理：用 Capacitor 包装成混合移动应用
   - 输出：APK 文件

### 第 2 步：生成 APK 项目

#### 方案 A：WebView 包装（最常用）

1. **创建 Android 项目结构**：

```
WebViewApp/
├── app/
│   ├── build.gradle.kts
│   └── src/
│       └── main/
│           ├── AndroidManifest.xml
│           ├── java/com/example/webviewapp/
│           │   └── MainActivity.kt
│           ├── res/
│           │   ├── drawable/         # 应用图标（可选）
│           │   ├── mipmap-hdpi/      # 启动图标
│           │   ├── mipmap-xhdpi/
│           │   ├── mipmap-xxhdpi/
│           │   └── values/
│           │       ├── strings.xml
│           │       └── themes.xml
│           └── assets/
│               └── index.html       # 如果应用是本地 HTML 文件
├── build.gradle.kts
├── settings.gradle.kts
└── gradle.properties
```

2. **核心文件说明**：

   **MainActivity.kt**：
   ```kotlin
   // WebView 配置
   // - 启用 JavaScript
   // - 启用 DOM storage
   // - 设置 WebViewClient
   // - 加载 URL（远程 URL 或本地 assets/index.html）
   // - 处理返回键（WebView.goBack）
   ```

   **AndroidManifest.xml**：
   ```xml
   <!-- 权限：INTERNET（加载远程内容） -->
   <!-- activity 配置：竖屏锁定 / 全屏 -->
   <!-- 允许 cleartext（加载本地页面不需要） -->
   ```

   **build.gradle.kts**：
   ```kotlin
   // minSdk = 21 (Android 5.0+)
   // targetSdk = 34 (Android 14)
   // kotlin 版本
   ```

3. **两种加载方式**：
   - **远程 URL**：加载已部署的网页地址（如 ngrok URL）
   - **本地 HTML**：把 HTML/CSS/JS 文件放入 `assets/` 目录，WebView 加载本地文件
   - **自动选择**：如果有在线地址用远程，否则生成本地版本

4. **APK 构建方法**：

   **方法 1：命令行构建（需要 Android SDK）**
   ```bash
   # 需要安装 Android SDK + Gradle
   cd WebViewApp
   ./gradlew assembleDebug
   # 输出: app/build/outputs/apk/debug/app-debug.apk
   ```

   **方法 2：在线云构建（无需本地 SDK）**
   - 使用 GitHub Actions + 预配置的 Android 构建工作流
   - 生成 `build-android.yml` 工作流文件
   - 用户 push 到 GitHub 自动构建

   **方法 3：提供 EAS Build / Appetize 等在线服务指引**

#### 方案 B：Chaquopy（Python 应用）

1. 适用条件：用户确认使用 Python 且不能转为 Web
2. 创建 Chaquopy 配置的 Android 项目
3. 在 `build.gradle.kts` 中添加 chaquopy plugin
4. Python 源码放入 `app/src/main/python/` 目录
5. 编写 Java/Kotlin 桥接代码调用 Python 模块

#### 方案 C：Capacitor（Node.js 应用）

1. 在项目中安装 Capacitor
2. 配置 `capacitor.config.json`
3. 运行 `npx cap add android`
4. 运行 `npx cap sync` 同步依赖

### 第 3 步：构建选项处理

根据用户需求调整 APK 配置：

| 选项 | 默认值 | 说明 |
|------|-------|------|
| 应用名称 | 自动生成或用户指定 | Android 显示的应用名 |
| 包名 | com.example.app | Android 唯一标识 |
| 应用图标 | 默认图标 | 用户可提供图片替换 |
| 启动画面 | 无 | 可添加加载动画 |
| 全屏模式 | 是 | 隐去状态栏 |
| 横竖屏锁定 | 竖屏 | 可选自动旋转 |
| 离线缓存 | 否 | 启用 WebView 缓存支持离线访问 |

### 第 4 步：运行 bug-fixer 自检

APK 项目搭建完成后，**在构建之前，先调用 bug-fixer skill** 检查：

1. 加载 `bug-fixer` 技能
2. 对项目中的 Kotlin/Java 源码做语法检查
3. 对 HTML/CSS/JS 前端做检查
4. 确认 XML 配置文件格式正确
5. **等 bug-fixer 确认无 bug 后**，才进入下一步构建

### 第 5 步：构建 APK → 再检查一遍

bug-fixer 自检通过后，开始构建 APK：

1. **生成 APK 文件**：
   - 尝试本地构建（如果有 Android SDK）
   - 提供 Gradle 构建文件，用户可以在 Android Studio 中自行构建
   - 提供云构建方案（GitHub Actions）

2. **验证 APK**：
   - 检查 APK 文件是否生成成功
   - 确认签名信息（debug keystore 或 release signing）

3. **再跑一遍 bug-fixer 最终检查**：
   - 构建完成后，再次加载 `bug-fixer` 技能做最终确认
   - 确保构建过程没有引入新问题
   - 等 bug-fixer 确认无误后，才进入下一步

### 第 6 步：询问后续操作

> "APK 项目做好了！要不要：\n1️⃣ 现在尝试构建 APK\n2️⃣ 给你生成构建说明文档\n3️⃣ 先用 desktop-to-remote-web 转成网站再打包 APK（如果还没转）"

## 输出规范

- Android 项目优先用 Kotlin（现代 Android 开发语言）
- 提供完整的 Gradle 项目结构
- 附构建说明（本地构建 + 云构建）
- 中文界面，口语化提示
- 如果用户没有 Android SDK，提供 GitHub Actions 云构建方案

## 注意事项

- **构建 APK 需要 Android SDK**（如果本机没有安装），优先提供云构建方案
- Android SDK 下载量大（数 GB），不作为 Skill 内的重任务
- WebView 包装方案最简单，适合大部分场景
- 国内无法访问 Google Play，生成的 APK 直接发给用户 sideload 安装
- APK 需要签名才能安装，自动使用 debug keystore
- 生产环境需要提醒用户申请签名密钥
- 目标 Android 版本：minSdk 21（覆盖 95% 以上设备）
- 如果桌面应用有硬件依赖（摄像头、GPS 等），WebView 可通过 JavaScript 接口桥接
