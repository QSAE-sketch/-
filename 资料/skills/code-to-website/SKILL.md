---
name: code-to-website
description: "把 code-generator 生成的代码（Python/JS/CLI 等）转换为单个自包含的 HTML 网站，输出可供 html-to-windows-exe 打包。当用户说"做成网页""转成网页""转换成网站""网页化""转成 HTML""code to website"时触发。作用在 code-generator 之后、html-to-windows-exe 之前，打通 pipeline。"
agent_created: true
---

# Code To Website - 代码转网站

## 定位

这条 skill 处于 pipeline 中间层：

```
code-generator（生成代码） → code-to-website（转网页） → html-to-windows-exe（打包 exe）
```

**输入**：code-generator 生成的各类代码（Python 脚本、JS 程序、CLI 工具等）
**输出**：单个自包含 HTML 文件（所有 CSS/JS 内联，零外部依赖）
**后续**：联动 html-to-windows-exe 打包成 Windows exe

---

## 核心规则（必须遵守）

### 1. 输出格式
- **必须**是单个 `.html` 文件，所有 CSS 写在 `<style>` 标签内，所有 JS 写在 `<script>` 标签内
- **不得**引用外部文件（图片、字体、JSON 等），除非通过 data URI 内联
- **尽量**不依赖外部 CDN，如必须使用（例如 Chart.js），提供本地回退方案
- **保留**原代码的所有核心功能和逻辑，不能阉割

### 2. UI 设计
- 分析输入代码的功能，设计对应的 Web 交互界面
- 界面风格默认用**现代极简**，如果原代码是像素/复古风则保持一致
- 确保交互友好、响应式（能用就行，不追求完美适配）
- 提供输入区域、操作按钮、结果展示区等基本要素

### 3. PWA 支持（iPhone 友好）
由于最终可能通过 desktop-to-remote-web 发布成远程网站，**生成 HTML 时必须默认加上 PWA 支持**，让 iPhone/iPad 用户能"添加到主屏幕"当原生 App 用：

- 在 HTML 中嵌入 inline `<link rel="manifest">`（通过 data URI 内联 manifest JSON）
- manifest 内容：设置名称、图标（用 emoji 或 SVG data URI 代替图片文件）、`display: standalone`、主题色
- 内联一段 service worker 注册脚本（sw 代码直接写在 `<script>` 里，用 `Blob URL` 或直接在页面内通过 `Cache-Control` 相关逻辑模拟）
- 添加 `<meta name="apple-mobile-web-app-capable" content="yes">` 和对应的启动图标 meta
- **不得**引用外部图片/PWA 资源文件——全部通过 data URI / inline 内联

这样用户通过 Safari 打开远程网站后，点"分享→添加到主屏幕"，图标、启动页、无浏览器栏，体验就像原生 App。

### 5. 转换策略
根据输入代码类型采用不同转换方式：

| 输入类型 | 转换方式 |
|---------|---------|
| Python 脚本（计算/数据处理类） | 重写为 JS 实现核心逻辑，HTML 做 UI |
| Python CLI 工具 | 用 HTML 表单/文本框模拟 CLI 输入输出 |
| JS 代码（逻辑模块） | 包装在 HTML 页面中，加 UI 交互层 |
| 简单算法/工具类 | 直接嵌入式实现，单页搞定 |
| 游戏类（如终端游戏） | 转 Canvas/Div 绘制 + 事件处理 |

### 6. pipeline 联动
- 转换完成后，**自动问**："要把它打包成 Windows exe 吗？（可联动 html-to-windows-exe）"
- 如果用户说"打包"，立即联动 html-to-windows-exe skill

---

## 工作流程

### Step 1: 理解输入代码
- 读取 code-generator 生成的代码
- 识别代码类型、核心功能、输入输出方式
- 如果代码不清或缺失关键部分，先问清楚

### Step 2: 设计 Web 界面方案
在脑子里或草稿中确定：
- 页面布局（输入区 / 操作区 / 结果区）
- 交互方式（按钮点击 / 表单提交 / 实时反馈）
- 数据流向（用户输入 → 逻辑处理 → 结果展示）

### Step 3: 生成 HTML
- 写出完整的单 HTML 文件
- 内联所有资源
- 保证核心逻辑完整可用
- 测试确认无语法错误

### Step 4: 展示并询问后续（完整 pipeline 联动）
- 告诉用户文件位置
- **询问是否需要走完整 pipeline**，展示以下选项：

```
[生成代码] → [转网页] → [打包 exe] → [远程网站] → [修 bug] → [转 APK]
  ↑                                    ↑
  刚才做的                             一条龙走完
```

具体询问流程：
1. "要把它打包成 Windows exe 吗？" → 联动 **html-to-windows-exe**
2. 如果打包了 exe："要把它转成远程可访问的单机网站吗？" → 联动 **desktop-to-remote-web**
3. "要跑一遍 bug-fixer 全面检测修复吗？" → 联动 **bug-fixer**
4. 体验满意后："要打包成 Android APK 吗？" → 联动 **to-apk**
5. 如果过程中发现问题，左边箭头回到 code-generator 重新来过

**pipeline 完整链条（6 个 skill）**：
```
code-generator → code-to-website → html-to-windows-exe → desktop-to-remote-web → bug-fixer → to-apk
```

---

## 触发词

当用户说以下内容时触发本 skill：
- 「做成网页」「转成网页」
- 「代码转网站」「转换成网站」「网页化」
- 「转成 HTML」「code to website」
- 「加个界面」「加个 UI」
- 「给这个代码套个壳」

## 联动注意事项

- **code-generator**：如果 code-generator 生成的代码有问题，先跑 bug-fixer 修好再转
- **html-to-windows-exe**：输出文件路径传给 html-to-windows-exe 做输入
- **desktop-to-remote-web**：不冲突，那个是针对已有桌面应用远程化，这个是代码→网页化
