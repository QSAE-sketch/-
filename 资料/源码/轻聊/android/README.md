# 轻聊 · Android 客户端

把线上「轻聊」站点装进 Android 应用：**WebView 承载 + 移动端适配 + 原生存储桥**。

> **站点业务逻辑零改动。** 本工程不包含任何站点业务逻辑，前端（`public/`）与服务端（`server.js`）
> 一个字节都没有修改。APK 只做容器：加载网址、接管文件选择/下载、处理返回键、适配窄屏，
> 外加**设置页所需的原生存储能力**（清缓存 / 选目录 / 落盘）。

> 📱 目标机型与适配方案详见 [`../docs/红米Note2适配方案.md`](../docs/红米Note2适配方案.md)
> （红米 Note 2 / 骁龙 410 / 2GB RAM / Android 5.x 的实测数据、关键取舍与模块结构）。


---

## 一、技术方案

| 层 | 做法 |
|---|---|
| 页面承载 | 单个 `WebView` 加载 `res/values/strings.xml` 里的 `app_url`（带 sharecode 的分享链接） |
| 鉴权透传 | 首次访问网关下发 `__wb_rsc` Cookie，`CookieManager` 接管后所有 XHR 自动带上 |
| 登录态 | 开启 **DOM Storage** —— 站点用 `localStorage` 保存登录令牌与断点续传的上传 id |
| 文件上传 | 接管 `WebChromeClient` 的文件选择回调（API 21+ 用 `onShowFileChooser`，API 19/20 用旧版 `openFileChooser`）——⚠️ 见下方「已知限制」 |
| 文件下载 | 接管 `DownloadListener`，转交系统 `DownloadManager`，并把 WebView 的 Cookie 一起带上 |
| 返回键 | 弹层 → 聊天页 → 列表页 → 二次确认退出，逐层复用**站点自己的**按钮，不复制业务逻辑 |
| 移动端适配 | 站点自带 `viewport width=device-width`；容器侧禁用缩放、固定字号缩放 100%、隐藏滚动条、状态栏染成主题色 |
| 视频 | 接管 `onShowCustomView` 支持全屏播放，返回键先退出全屏 |
| **原生存储桥** | `addJavascriptInterface` 注入 `window.QLNative`，只暴露**存储类**能力（清缓存 / 选目录 / 落盘），不注入任何业务逻辑 |
| 前后台挂起 | `onPause` → `web.onPause()` + `window.__qlSetActive(false)` 停轮询；`onResume` 反向恢复 |
| 弱网容错 | 注入可重试错误页（`loadDataWithBaseURL`），主文档加载失败才替换，避免子资源失败误伤 |

### 原生存储桥（`window.QLNative`）

站点前端通过一个**异步 JSON 桥协议**调用原生能力：

```
JS   → window.QLNative.<method>(cbId, argsJson)
原生 → web.evaluateJavascript("window.__qlNative(cbId, json)")   // 完成后回灌
```

| 方法 | 参数 | 作用 |
|---|---|---|
| `getCacheInfo` | — | 统计本机缓存真实占用（含 WebView 的 `app_webview/Cache`） |
| `clearCache` | — | 清缓存（主线程 `clearCache(true)` + 后台线程删盘上目录） |
| `pickSaveDir` | — | 弹目录选择器：系统 Downloads / 应用私有目录 / 外部存储根目录 / **浏览其它文件夹（SAF）** |
| `saveFile` | `{url,name,mime}` | 下载文件并落盘到选定目录（树形 URI 走 SAF，普通路径走自带流式下载） |

设计约束：

- **UI 操作一律切回主线程**（`runOnUiThread`），目录扫描 / 删除 / 下载走**独立后台线程**，
  老设备上 eMMC 随机 IO 约 5ms，绝不在主线程做磁盘操作。
- **只暴露存储类方法**，不注入聊天、房间、账号等业务能力 —— 容器保持"薄"。
- 无原生桥时（浏览器打开站点），前端自动降级为 Web API 实现，功能不缺失。


### 设置页三项功能（原生存取链路）

站点前端（`public/app.js`）负责编排与二次确认，**实际存储动作全部走原生桥**：

| 功能 | 原生实现 | 降级链（每步都回报「实际保存路径」） |
|---|---|---|
| **清除缓存** | 主线程 `WebView.clearCache(true)`；后台线程删除 `getCacheDir()` / `getExternalCacheDir()` / `getCodeCacheDir()` / **`app_webview/Cache`** / 旧版 `dataDir/webview` | 无桥 → 前端清 `Cache Storage` + 一次性本地键 |
| **清除聊天记录** | **不碰原生存储**，纯前端水位（`ll_hidden_rev`），服务端数据不动 | 无需降级 |
| **自定义下载路径** | `AlertDialog` 四选一：系统 Downloads / 应用私有目录 / 外部存储根目录 / **浏览其它文件夹（SAF `ACTION_OPEN_DOCUMENT_TREE` + `takePersistableUriPermission`）** | 任意路径 → 应用私有目录（`getExternalFilesDir` → `getFilesDir` 兜底） |

落盘分支：

- **SAF 树 URI** → `DocumentsContract.createDocument()` 写入用户选的目录（API 21+ 可用）
- **普通路径** → 自带 `HttpURLConnection` 流式下载，读 `Content-Disposition` 取原始文件名，
  先写 `.part` 再改名，避免半截文件
- **系统 Downloads** → 交系统 `DownloadManager`；不可用时降级私有目录

> ⚠️ **缓存统计的真实位置**：WebView 的 HTTP 缓存**不在** `getCacheDir()`，
> 而在 `/data/data/<pkg>/app_webview/Cache`。只清 `getCacheDir()` 会显示「0 B」却什么都没清掉
> —— 这是实测踩过的坑，现已覆盖全部缓存目录。

### 返回键行为（与站点层级一一对应）

| 当前界面 | 返回键行为 | 实现方式 |
|---|---|---|
| 弹层（成员面板/创建房间等） | 关闭弹层 | 点击站点 `#modalCancel` |
| **设置页** | 回到「我的」 | 点击站点 `#setBackBtn` |
| 聊天页 | 回到房间列表 | 点击站点 `#backBtn` |
| 主界面 | 有历史则回退，否则「再按一次退出轻聊」 | `canGoBack()` + 二次确认 Toast |
| 视频全屏 | 先退出全屏 | `onHideCustomView()` |

判定当前层级靠读取站点真实 DOM（`#modal` / `#chat` / `#auth` 的 `hide` class），
**不修改站点任何一行代码，也不复制站点的状态逻辑**。

---

## 二、构建

### 环境要求

| 组件 | 本机实测版本 | 说明 |
|---|---|---|
| JDK | 22.0.2 | AGP 8.5 要求 ≥ 17 |
| Android SDK | build-tools 34.0.0 / platform android-34 | |
| Gradle | 8.9（`D:\android-sdk\gradle-8.9`） | AGP 8.5.2 要求 ≥ 8.7 |
| Android Gradle Plugin | 8.5.2 | 首次构建自动下载 |

### 完整构建命令

```bash
cd chatapp/android

# Debug 包（自动使用 ~/.android/debug.keystore）
D:/android-sdk/gradle-8.9/bin/gradle clean assembleDebug

# Release 包（使用本工程的专用密钥库）
D:/android-sdk/gradle-8.9/bin/gradle clean assembleRelease

# 两个包一起出
D:/android-sdk/gradle-8.9/bin/gradle clean assembleDebug assembleRelease
```

产物路径：

- `app/build/outputs/apk/debug/app-debug.apk`
- `app/build/outputs/apk/release/app-release.apk`

### 关键配置

| 项 | 值 | 位置 |
|---|---|---|
| applicationId | `com.qingliao.app` | `app/build.gradle` |
| versionCode / versionName | `8` / `1.4.3` | 读项目根 `version.json`（`app/build.gradle`） |
| minSdk / targetSdk / compileSdk | 19 / 34 / 34 | `app/build.gradle` |
| 混淆 (R8) | **关闭** | 保证与站点行为完全一致 |
| 资源压缩 | **关闭** | 同上 |
| 第三方依赖 | **无**（零 androidx，纯平台 API） | Release APK **96.3 KB**（v1.4.3） |

### 签名

- **Release**：`keystore/qingliao-release.jks`，别名 `qingliao`，口令见 `keystore.properties`
  （v1 JAR + v2 APK 签名方案均已校验通过）
- **Debug**：AGP 自动生成的 `~/.android/debug.keystore`
- ⚠️ `qingliao-release.jks` 必须妥善保管 —— 换密钥后已安装用户将无法覆盖升级

### 改站点地址

改 `app/src/main/res/values/strings.xml` 里的 `app_url` 即可，无需动代码。

---

## 三、目录结构

```
chatapp/android/
├── settings.gradle / build.gradle / gradle.properties / local.properties
├── keystore.properties              # 签名配置
├── keystore/qingliao-release.jks     # release 密钥库
├── tools/
│   ├── make_icons.py                # 代码生成启动图标（无外部素材）
│   ├── verify_apk.sh                # APK 产物校验脚本（badging / 签名 / dex）
│   ├── adb19.sh                     # adb 连接辅助（API 19 模拟器）
│   └── adb21.sh                     # adb 连接辅助（API 21 模拟器，每次自动重建 adb server）
├── docs/screenshots/                # 双端验证截图（api19 / api21 / api30）
└── app/
    ├── build.gradle
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml
        ├── java/com/qingliao/app/
        │   ├── MainActivity.java      # 容器主体：返回键 / 文件选择 / 下载 / 全屏 / 权限
        │   ├── WebKit.java            # WebView 能力开关
        │   ├── AppBridge.java         # 原生存储桥（清缓存 / 选目录 / 落盘），仅存储类能力
        │   ├── AppChromeLegacy.java   # API 19/20 的 WebChromeClient（两个旧签名）
        │   ├── AppChrome21.java       # API 21+ 的 WebChromeClient
        │   ├── AppWebViewClient.java  # API 19~22 的导航控制 + 弱网错误页
        │   ├── AppWebViewClient23.java# API 23+ 的导航控制（onReceivedError 新签名）
        │   └── AppDownloadListener.java
        └── res/                       # 图标 / 主题 / 站点地址
```

### 为什么拆成两个 WebViewClient

`onReceivedError` 在 API 23 上换成了 `onReceivedError(WebView, WebResourceRequest, WebResourceError)`，
老签名在 API 23+ 已废弃。若把两套签名塞进同一个类，**Dalvik 在 API 19/20 上做类校验时
会报 `VerifyError`**（方法签名引用了不存在的类）。因此高版本专属实现被拆到独立类，
由 `WebKit` 按 `Build.VERSION.SDK_INT` 二选一加载。`AppChrome21` / `AppChromeLegacy` 同理。

---

## 四、兼容性说明

### 已知限制：Android 4.4 / 4.4W 无法选择文件（平台限制，非本工程缺陷）

**现象**：在 API 19 模拟器上点击站点附件按钮（📎）不弹出文件选择器。

**根因**（已逐层取证，非推测）：

1. API 19/20 框架里的文件选择回调签名与 API 21+ 完全不同，本工程已按真实签名实现：
   ```
   API 19/20 : openFileChooser(ValueCallback<Uri[]>, String acceptType, String capture) → void
   API 21~32 : openFileChooser(WebView, ValueCallback<Uri[]>, String, String[]) → boolean（已废弃，转发 onShowFileChooser）
   API 33+   : 只有 onShowFileChooser(WebView, ValueCallback<Uri[]>, FileChooserParams) → boolean
   ```
   签名来自反编译设备上的 `/system/framework/framework.jar`（`dexdump` 读 locals 拿到形参名）。
2. 但 **KitKat 的 Chromium WebView provider 根本不会调用这个回调**：
   `webviewchromium.odex`（设备上真正执行的那份 dex）里 `openFileChooser` 出现 **0 次**，
   它的内部钩子是 `AwContentsClient.showFileChooser(...)` / `runFileChooser(...)`，
   且**没有**通往 `WebChromeClient` 的桥接。
3. 对照实验：同一台设备上的**系统自带浏览器**点「Choose File」同样毫无反应 →
   证明这是 Android 4.4 WebView 的平台限制，与本工程无关。
   旁证：`Tab$3`（浏览器自己的 WebChromeClient 子类）确实重写了
   `openFileChooser(ValueCallback, String, String)`，但 provider 从不回调它。

**结论**：Android 5.0（API 21）起文件上传才可用；本工程已完整实现并实测通过
API 21 / 30 的 `onShowFileChooser` 路径。若要保证文件功能 100% 可用，
把 `app/build.gradle` 里的 `minSdk` 改成 `21` 即可（改一行）。

### 其他兼容性要点

- **minSdk 19（Android 4.4）**：为兼容红米 Note 2，聊天/房间/文件收发列表全部可用，
  仅「选择本地文件」受上述平台限制影响。
- **API 19/20 的回调写法**：`openFileChooser` 自 API 21 起已从 SDK 移除，
  所以代码里**刻意不加 `@Override`**（加了在 compileSdk 34 下无法编译），
  但在 API 19/20 上运行时按相同签名可被系统回调（部分厂商 ROM 的 4.4 WebView 会走这条路径）。
  为避免低版本 WebView 的类校验问题，API 21+ 的实现被拆到独立的 `AppChrome21` 类。
- **不依赖 androidx**：只用平台原生 API，避免旧系统上 androidx 的兼容坑，也把包体压到 96 KB 上下。
- **网络**：站点为 https，Manifest 已设 `usesCleartextTraffic=false`。
- **权限**：`INTERNET`、`ACCESS_NETWORK_STATE`；`WRITE_EXTERNAL_STORAGE` 仅在
  Android 9 及以下（`maxSdkVersion=28`）需要，用于把下载文件存进「下载」目录，运行时申请。
- **旧版权限机制适配**（Android 5.x 是重点）：

  | 系统版本 | 机制 | 本工程做法 |
  |---|---|---|
  | API 21～22（Android 5.0/5.1） | **没有运行时权限**，安装即授予 | 直接读写，不弹窗 |
  | API 23～28（Android 6.0～9） | 运行时权限 | 首次写外部目录前申请 `WRITE_EXTERNAL_STORAGE`，被拒即降级私有目录 |
  | API 29+（Android 10+） | 分区存储，普通写外部目录被拒 | **不申请**该权限，直接走 SAF / 应用私有目录 |

  `WRITE_EXTERNAL_STORAGE` 在 29+ 申请反而是无效且有审核风险的写法，故用
  `maxSdkVersion=28` 限定，并在 29+ 时主动跳过申请。

---

## 五、验证记录

### 5.1 功能验证（2026-11-07）

| 环境 | 验证内容 | 结果 |
|---|---|---|
| API 30 / Android 11 / 1080×1920 | 安装 → 启动 → 登录 → 主界面 → 公共聊天室 → 点 📎 | ✅ `documentsui/.picker.PickActivity` 正常唤起，Intent 为 `act=GET_CONTENT cat=[OPENABLE] typ=*/*` |
| API 19 / Android 4.4.2 / 320×640 | 安装 → 启动 → 登录 → 公共聊天室 → 历史消息渲染 → 返回键 | ✅ 全部通过；返回键在聊天页正确回到房间列表，不退出 App |
| API 19 | 点 📎 选择文件 | ⚠️ 不弹选择器 —— KitKat WebView 平台限制（见上） |
| 静态检查 | Lint `NewApi` 计数 | 0 |

### 5.2 Android 5.0（API 21）专项验证 —— 目标机型模拟

环境：**Android 5.0.2 (API 21) x86 模拟器**，`wm density 320` + `wm size reset`
→ 逻辑 **360×640 dp**，与红米 Note 2 完全一致。截图见 `docs/screenshots/api21-*.png`。

| 验证项 | 预期 | 实测结果 |
|---|---|---|
| 冷启动（Activity → 首帧） | 流畅 | **429 ms** |
| 应用进程 PSS | 不爆 | **44.1 MB**（45140 KB） |
| 前台 CPU（聊天页 2.5s 轮询） | 低 | 8 tick / 12s ≈ **0.67% 单核** |
| **退后台 CPU** | 显著下降 | 1 tick / 12s ≈ **0.08% 单核**（降 8 倍） |
| 设置页打开 / 返回键 | 正常 | ✅ 设置页正常渲染，返回键先回「我的」再退出 |
| **清除缓存** | 显示真实占用并释放 | ✅ 显示 39.0 KB → 清除后 0 B；磁盘 `app_webview/Cache` **60KB → 4KB** |
| **清除聊天记录（第一层）** | 提示含「仅影响本地数据」 | ✅ 弹层正文含 `⚠️ 此操作仅影响本地数据` |
| **清除聊天记录（第二层）** | 独立二次确认 | ✅ 标题「再次确认」 |
| **清除后本机** | 不再显示 | ✅ 消息区空白，**登录态保留** |
| **清除后服务端** | 数据不动 | ✅ 服务端仍有 1 条消息（rev 3），其它设备照常可见 |
| **下载路径选择器** | 原生 4 项 | ✅ 系统 Downloads / 应用私有目录 / 外部存储根目录 / 浏览其它文件夹（SAF） |
| **SAF 目录树** | 能唤起 | ✅ 系统目录树选择器正常弹出（截图 api21-10） |
| **降级提示** | 明示实际路径 | ✅ 「系统下载管理器不可用（Unable to create directory: /storage/sdcard/Download），已降级保存到应用私有目录：/data/data/com.qingliao.app.debug/files/方案测试.pptx」，**中文原名保留** |
| 弱网 / 断网 | 可重试 | ✅ 注入错误页，不白屏、不闪退 |

> 📌 **CA 库**：API 21 模拟器镜像的 CA 库是 2014 年的，缺 `DigiCert Global Root G2`
> （站点证书链为 leaf ← DigiCert Secure Site OV G2 TLS CN RSA4096 SHA256 2022 CA1 ← 根），
> 会报 `Trust anchor not found`。解法同 API 19：把**中间证书**当用户 CA 注入
> `/data/misc/keychain/cacerts-added/5bef71b4.0`（哈希由 `openssl x509 -subject_hash_old` 得到），
> 重启模拟器后站点正常加载。**这是模拟器镜像年代问题，与 APK 无关** ——
> 真机 Android 4.4 及以上系统都自带 DigiCert 根证书。

### 5.3 性能基线（Release 包，API 21 模拟器）

| 指标 | 实测 |
|---|---|
| Release APK 体积 | **96.3 KB**（v1.4.3） |
| 应用 PSS | 44.1 MB |
| 冷启动 | 429 ms |
| WebView HTTP 缓存 | 39 KB（刚访问完站点） |

---

> ⚠️ **API 19 补充**：Android 4.4 模拟器镜像的 CA 库同样是 2014 年的，不认识站点当前的
> DigiCert 链（`Trust anchor not found`），需要把中间证书作为锚点注入
> `/data/misc/keychain/cacerts-added/5bef71b4.0`（4.4 上用户 CA 默认对所有应用生效，
> 比改只读的 `/system` 分区更省事）。与 API 21 的处理方式一致。
