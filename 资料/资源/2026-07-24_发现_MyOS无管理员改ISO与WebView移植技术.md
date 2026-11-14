# 发现：MyOS 无管理员改 ISO / WebView 移植技术（2026-07-24，可复用）

## 1. 无管理员 Windows 改 squashfs / ISO（核心突破）
- squashfs-tools-ng 在 MINGW64 无管理员编译 → 用 **tar 中转**绕开 NTFS 大小写不敏感 + symlink 死结：
  `sqfs2tar` 提取 → Python `tarfile` 流式改 → `tar2sqfs` 回灌 → `xorriso` 写 ISO。
- `xzhrio -map` 语义坑（映射顺序有讲究）。
- 二进制丢失：`tar2sqfs` 丢二进制 → 改用 `sqfstar`。

## 2. 输入框焦点
- Tkinter override-redirect 拿不到 X 焦点 → `focus_force()`。

## 3. 持久化（live-boot overlay）
- persistence 标签 ext4 分区 + `persistence.conf`；`merge_persist.py` → MyOS-persist.iso。

## 4. 中文输入法
- rootfs 无中文 → fcitx5 注入（361 个 deb）；踩坑：stage3 元组顺序写反、`iter_deb` 需 yield 内部 tar。
- fcitx5 不行 → 应用层拼音 `ime.py` + PinyinIME（Ctrl+Space / F8 弹窗，英文不碰键盘）；删全部 IM 环境变量。
- pypinyin 字节要 **gb2312 解码**。

## 5. WebView 版烤 ISO
- 剪贴板 / 壁纸 / 视频 / 浏览器 / 右键菜单 / 记事本落盘 / 商店 `registry_server` 接入，一并烤进 ISO。
