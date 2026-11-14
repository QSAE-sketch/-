# 2026-08-06 守·安卓模拟器构建调试 + OpenClaw 换 key + lite 媒体台

## 1. 守·安卓模拟器（QEMU + Android-x86）构建过程（工作区 13-59-19，8/6）
> 注：模拟器「便携化归档 + 守闪电下载归档」已在 2026-08-07 事件归档；本条补的是**归档前没进 U盘库的构建/调试细节**（细粒度 bug 与发现见对应资源条目）。
- 5 连环坑（xsave 卡死 / bootindex / tb-size 内存 / 进程泄漏 / 主板不一致）→ WHPX 启用后装机 2 分 → 30 秒。
- 分辨率（nomodeset + UVESA_MODE / 注册表 HIGHDPIAWARE）；APK 安装链路实测 + 兼容性误报修正（ARM 翻译 houdini 能跑）。
- 引擎指纹检测（Unity / Unreal ARM-only 禁用安装）；网络 e1000 + 动态接口名（wlan0）。
- 本机硬件检测 `host_info`；离线整包（2.25GB）；打包 bug（spec 路径 / GRUB 补丁）。
- 首屏检测慢（DISM）→ 2.75s；DirectBoot 绕过 GRUB；黑窗（CREATE_NO_WINDOW）。
- VM 自动发现 + 导入；图标生成 + 依赖复用 junction + 下载加 PATH + auto_reuse。
- 钓鱼游戏转悠闲钓鱼.apk（本地 Gradle）。

## 2. OpenClaw 换智谱 key（工作区 15-15-28）
- OpenClaw 是独立 AI 应用（非 WorkBuddy），配置在 `.openclaw/openclaw.json`（models.providers.zhipu.apiKey）。
- 换 key + 删所有旧备份；限流根因 = glm-4.7-flash 全局 429（换 key 可能仍限）。
- 用户偏好：勿擅自把默认模型从 glm-4.7-flash 切走（唯一真免费）。

## 3. 轻享·三合一媒体台 lite-media-platform（工作区 16-46-05）
- 纯前端单文件 + localStorage 断点续听（音乐 / 故事 / 视频）。
- Python wave 合成音乐 / 故事；imageio-ffmpeg 生成测试视频（ffmpeg 真路径用 get_ffmpeg_exe()，mandelbrot 无 duration 用 -t）。
- Windows TTS 被安全策略拦 → 改 Python 合成。
