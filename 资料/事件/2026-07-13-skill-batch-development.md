# 2026-07-13 WorkBuddy Skill 批量开发

**时间：** 2026-07-13 11:43 ~ 12:05
**任务：** 使用 skill-creator 批量开发 3 个用户级 WorkBuddy Skill

---

## 做了什么

### 1. 代码生成器 (code-generator)

**位置：** `~/.workbuddy/skills/code-generator/`

**流程：** 描述需求 → 不清就问（语言/功能/输入输出）→ 生成代码 → 联动 bug-fixer 自检 → 询问是否做网站或桌面应用

**打磨过程：**
- 初始版写了手动自检步骤
- 大佬提出联动已有的 bug-fixer skill，改为直接调用 bug-fixer 做质检

### 2. 桌面应用转远程单机网站 (desktop-to-remote-web)

**位置：** `~/.workbuddy/skills/desktop-to-remote-web/`

**架构：** Flask/FastAPI + WebSocket + 单用户 Session 锁
**远程方案：** ngrok / Cloudflare Tunnel / 自定义中继
**流程：** 分析桌面应用 → 构建 Web 服务 → 配置隧道 → bug-fixer 自检 → 可继续转 APK

### 3. 转 APK (to-apk)

**位置：** `~/.workbuddy/skills/to-apk/`

**方案：**
- A - WebView 包装（网站/HTML 应用，最常用）
- B - Chaquopy（Python 桌面应用）
- C - Capacitor（Electron/Node.js 应用）

**流程打磨：**
- 初始：先自检→构建
- 大佬要求改为：先自检→构建→**再查一遍**→询问后续（两遍检查）
- 中间有一次误改回一遍，后来又恢复为两遍检查

### 4. 全链路整合

已有技能与新技能形成了完整 Pipeline：
```
code-generator → code-to-website → html-to-windows-exe → desktop-to-remote-web → bug-fixer → to-apk
```

---

## 关键发现

- WorkBuddy 的 Skill 存在 `~/.workbuddy/skills/` 下即可自动识别
- Skill 之间可以相互调用（code-generator 调 bug-fixer，desktop-to-remote-web 调 to-apk）
- `skill-creator` 的 `init_skill.py` 可快速初始化 Skill 目录
- SKILL.md 的 YAML frontmatter 中的 `trigger_keywords` 影响自动匹配

---

## 当前技能全家桶

| # | Skill | 状态 |
|---|-------|------|
| 1 | bug-fixer | ✅ 已有 |
| 2 | code-generator | ✅ 新建 |
| 3 | code-to-website | ✅ 已有 |
| 4 | html-to-windows-exe | ✅ 已有 |
| 5 | desktop-to-remote-web | ✅ 新建 |
| 6 | to-apk | ✅ 新建 |
| 7 | skill-creator | ✅ 内置 |
