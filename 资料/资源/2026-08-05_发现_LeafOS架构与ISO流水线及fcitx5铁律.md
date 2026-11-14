# 发现：LeafOS 架构 + ISO 流水线 + fcitx5 铁律（2026-08-05）

- LeafOS = 网页体验版伪系统（商店 / 浏览器 / 记事本 / 远程商店）；**真系统需 Wine**（最终打包 ISO）。
- ISO 基 = Debian live + live-build，在 **WSL2 Ubuntu** 构建（需管理员分两段 + 重启）。
- 构建坑：`build-iso.ps1` BOM 乱码、阿里 DNS 解微软下载解析失败、build.sh 换清华镜像。
- **铁律**：中文 Linux 必须内置 fcitx5 / ibus（用户亲踩坑）；Wine 必要。
- 8/7 构建成功：MyOS-20260807.iso 2.0GB 可启动、进 chromium kiosk、localhost 通；
  修 live-boot 缺失 / isolinux ldlinux.c32 缺失 / systemd enable 失败 三坑。
