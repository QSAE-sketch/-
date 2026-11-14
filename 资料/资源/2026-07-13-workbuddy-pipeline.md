# 资源记录：WorkBuddy 6-Skill Pipeline 完整体系

## 日期
2026-07-13

## 来源
对话：少年 AI 搭子 · 技能开发与悠闲钓鱼转换

## 内容

### 核心发现：6-Skill 一条龙 Pipeline

把 WorkBuddy 的 6 个用户级 skill 串联成完整链路：

```
code-generator（写代码）
    ↓
code-to-website（转网页） ← 今天新做
    ↓
html-to-windows-exe（打包 exe）
    ↓
desktop-to-remote-web（远程单机网站 + PWA）
    ↓
bug-fixer（修复 bug）
    ↓
to-apk（打包 Android APK）
```

### 关键决策点

1. **desktop-to-remote-web 的真正意义**：不是（仅）远程访问，而是 iPhone 装不了 APK，需要网页版在 Safari 里"添加到主屏幕"当原生 App 用——iOS 跨平台的唯一方案。

2. **PWA 支持**：添加到主屏幕在 iPhone（Safari）和华为/安卓（Chrome/华为浏览器）上都可用。华为没有 Google 服务，推送通知不行，但核心功能没问题。

3. **code-to-website 定位**：介于 code-generator 和 html-to-windows-exe 之间的中间层，负责把代码生成器输出的代码转为单 HTML 网页。

### PWA 实现方式
- 使用 data URI 内联 manifest（避免外部文件）
- Blob URL 注册 service worker
- apple-mobile-web-app-capable meta
- 全部内联，零外部依赖
