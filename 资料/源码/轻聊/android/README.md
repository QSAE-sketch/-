# 轻聊 · Android 原生客户端

纯 Java 原生实现，**不用 WebView、不加载网页**，界面全部代码绘制。
功能与网页版对齐：主页 / 房间 / 好友 / 网盘 / 我的 五个页签，聊天、好友、房间、网盘、皮肤、设置齐全。

- 包名：`com.qingliao.app`
- 兼容：**Android 5.0.2（API 21）** 起
- 依赖：**零第三方、零 androidx**，只用平台 API
- 体积：Release APK 约 **151 KB**

---

## 一、模块结构

```
app/src/main/java/com/qingliao/app/
├── LoginActivity.java    登录 / 注册；多账号记忆、记住密码、自动登录
├── MainActivity.java     主壳：顶栏 + 内容区 + 底部五页签；页面切换、选文件、权限回调
├── Page.java             页面基类（可滚动容器 + 错误重试 + 空态）
├── HomePage.java         主页：公共聊天室、公告、提示、皮肤入口、其他入口
├── RoomsPage.java        房间：新建 / 搜索加入（密码房）/ 成员 / 踢人 / 禁言 / 房间昵称
├── FriendsPage.java      好友：申请同意拒绝、账号名加好友、点好友直接私聊
├── DrivePage.java        网盘：配额、我的文件/回收站/我的分享、筛选、上传、目录、分享下线
├── MePage.java           我的：资料、皮肤、设置、昵称、头像、权限、关于、退出/注销
├── ChatActivity.java     聊天（房间与私聊共用）：文字/图片/文件、撤回、成员、金色流光
├── SettingsActivity.java 设置：主题三档、金色流光开关、存储清理、下载位置、服务器、关于
├── SkinActivity.java     皮肤中心：搜索 + 色卡 + 应用（解析网页皮肤的 CSS 变量）
├── Ui.java               设计系统：调色板、卡片/按钮/标签/头像/进度条、换行容器、月亮按钮
├── Prefs.java            本机偏好：主题模式、金色流光、皮肤与 CSS 缓存、下载位置
├── Dlg.java              弹层：确认 / 输入 / 提示 / 进度
├── Downloads.java        下载：系统 DownloadManager + 网关 Cookie/token
├── FileUtil.java         选文件后的落盘工具
├── AvatarLoader.java     头像与聊天图片加载（内存 LruCache + 单线程下载）
├── Store.java            本地凭证与多账号（SharedPreferences，密码轻混淆）
└── Api.java              网络层：全部 /api 接口，同步阻塞，调用方放子线程
```

## 二、设计约定

- **视觉**：深蓝底、方角（2–6dp）、细描边、克制的层次；与网页版 2.9.x 手机端对齐。
- **配色来源**：`Ui.palette(dark)` 给两套基础色；皮肤则解析网页皮肤 CSS 里的变量
  （`:root` 与 `:root[data-theme="dark"]` **整块取**，不混用，否则会出现浅顶栏配深正文）。
  解析后对 `--accent` 做一次对比度兜底，保证在深色底上作为文字仍然看得清。
- **皮肤兼容**：不加载 CSS，只取配色；57 套内置皮肤在原生端都能换色。
- **状态栏**：API 23+ 浅色主题用深色状态栏图标；API 21/22 不支持，浅色下把状态栏压深，
  避免白底白图标。

## 三、构建

环境：JDK 17、Android SDK（compileSdk 34）、Gradle 8.9、AGP 8.5.2。

```bash
cd 资料/源码/轻聊/android

# 调试包（applicationId 带 .debug 后缀，便于装两份）
D:/android-sdk/gradle-8.9/bin/gradle assembleDebug

# 正式包
D:/android-sdk/gradle-8.9/bin/gradle assembleRelease
```

产物：

- `app/build/outputs/apk/debug/app-debug.apk`
- `app/build/outputs/apk/release/轻聊-v<版本名>.apk`（文件名由 `version.json` 的 `name` 决定）

归档（版本号必须带在文件名里）：

```bash
cp app/build/outputs/apk/release/轻聊-v3.0.0.apk ../../../资料/游戏成果/轻聊/
```

签名：`keystore/qingliao-release.jks`（别名 `qingliao`，口令见 `keystore.properties`）。
**这个密钥库必须保留** —— 换密钥后已装用户无法覆盖升级。

## 四、关键实现说明

| 能力 | 做法 |
|---|---|
| 网关鉴权 | 首次访问 `/?sharecode=...` 换 Cookie（`CookieManager` 自动维护），之后 `/api/*` 带上 `x-token` |
| 上传 | `init → 逐片 PUT → complete`，片大小听服务端；网盘上传完成后 PATCH 目录 |
| 下载 | 交系统 `DownloadManager`，手动带 `Cookie` 与 `x-token` 头；Android 6–9 先申请存储权限 |
| 私聊 | 走 `/api/dm/:userId` 拿会话房间，**不进房间列表**（与网页语义一致） |
| 聊天轮询 | `since=rev` 增量拉取，2.5s 一次；切后台即停（`onPause` 移除回调） |
| 金色流光 | 站长消息用金色渐变气泡；`Prefs.goldFx()` 关闭后保留金色、停止动画 |
| 聊天缓存 | 页面内只保留最近 120 条；设置里的「清除聊天记录」清本机缓存目录 |
| 皮肤 | `GET /api/skins` 列表 → 并发拉取各自 CSS → 解析变量 → 存本机缓存 |

## 五、验证记录（2026-11-28）

环境：Android 5.0.2（API 21）x86 模拟器，768×1280 / 320dpi（逻辑 360×640dp）。

| 项目 | 结果 |
|---|---|
| 安装 / 冷启动 | ✅ 正常，版本号 3.0.0（code 36） |
| 主页 / 房间 / 好友 / 网盘 / 我的 | ✅ 五页签切换正常，卡片与文字无截断重叠 |
| 登录（账号密码） | ✅ 登录成功进入主界面 |
| 聊天收发 | ✅ 文字发送、气泡追加、输入框清空、轮询增量更新 |
| 网盘 | ✅ 配额显示、类型/目录筛选、文件弹层（下载/分享/移动/重命名/回收站） |
| 分享 | ✅ 显示现有链接、提取码、有效期、下载次数；支持复制与下线 |
| 皮肤 | ✅ 列表加载 57 套、色卡显示、应用后整站换色；浅色/深色两套均正确 |
| 设置 | ✅ 主题三档、金色流光开关、存储清理、下载位置、关于 |
| 兼容性 | ✅ Android 5.0.2 实机镜像；浅色下状态栏/导航栏图标可见 |
