# 2026-08-05 LeafOS 网页伪系统 + ISO 构建

## 网页体验版（8/5）
- `leafos-store` 上传服务端：多版本 / 多类型（exe / zip / txt / ≤3 文件）。
- `leafos-web` 补：浏览器 / 代码高亮 / 远程商店 tab / 壁纸（ImageGen 蓝紫花）。
- 架构定位：网页体验版；真系统需 Wine（Arch → 改 Debian live + live-build 在 WSL2 构建）。
- `leafos-iso/` 建 `build.sh` + `build-iso.ps1` + `config/`。
- 环境：WSL2 需管理员启用 + 重启。

## ISO 构建推进（8/6）
- `build-iso.ps1` 修 BOM 乱码 → 管理员启用 WSL2 → 等重启。
- 手动装 WSL 失败（msi 1603）→ 改脚本 web-download；阿里 DNS 解微软下载解析失败；build.sh 换清华镜像。

## 构建成功（8/7，工作区 2026-08-05-09-34-23）
- MyOS-20260807.iso（1.2 → 2.0GB）构建：
  - 缺 live-boot → 补；isohybrid / syslinux-utils 缺失；
  - isolinux 缺 ldlinux.c32 等 → `prepare-bootloader.sh` 拷贝；
  - systemd enable 失败 → 手动建 wants 软链 + openbox 兜底等 30s。
- 最终 2.0GB 可启动、进 chromium kiosk、localhost 通。

## 状态
网页版 + ISO 构建链路打通，可启动。
