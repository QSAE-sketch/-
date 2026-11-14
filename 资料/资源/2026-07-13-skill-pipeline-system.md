# Skill Pipeline 体系设计

**发现时间：** 2026-07-13
**来源：** 大佬开发 WorkBuddy Skill 过程中的体系化发现

## 核心发现

通过开发 code-generator、desktop-to-remote-web、to-apk 三个新 Skill，并整合已有的 bug-fixer、html-to-windows-exe，形成了一套完整的 **开发→质检→分发** 技能流水线。

## 6-Skill 完整链路

```
code-generator → code-to-website → html-to-windows-exe → desktop-to-remote-web → bug-fixer → to-apk
```

每个环节职责：

| Skill | 职责 | 触发词 |
|-------|------|--------|
| 代码生成器 | 根据描述生成代码，不清就问 | 写代码、生成代码 |
| code-to-website | 把 CLI/Python 代码转单 HTML | 转成网页 |
| html-to-windows-exe | HTML → Windows exe 打包 | 打包exe |
| 桌面应用转远程单机网站 | 桌面应用 → 单人远程 Web（Flask+WebSocket+隧道） | 转成网站、远程访问 |
| bug-fixer | 代码自检修复（质检员） | 修BUG、检测bug |
| 转 APK | 网站/桌面应用 → Android APK（WebView/Chaquopy/Capacitor） | 转成APK |

## 设计模式

1. **联动质检**：每个生成/转换型 Skill 的输出，都必须经过 bug-fixer 自检再交付
2. **渐进式转换**：从代码 → 网页 → exe → 远程网站 → APK，逐步包装
3. **单用户约束**：远程网站默认单用户 session 锁，非联机
4. **验收闭环**：每次转换完询问"下一步要不要做XX"，不默认全链路执行

## bug-fixer 集成模式

- code-generator：生成代码后 → 丢给 bug-fixer 检查
- desktop-to-remote-web：网站构建后 → bug-fixer 检查
- to-apk：项目搭建后检查一次，构建后再检查一次（两遍）
