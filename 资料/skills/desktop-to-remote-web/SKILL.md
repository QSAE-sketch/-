---
name: 桌面应用转远程单机网站
description: 把桌面应用程序转换为单人可远程访问的网站。单用户模式（非联机），通过 WebSocket + Flask/FastAPI 实现，远程访问用 ngrok/Cloudflare Tunnel 或自定义中继。触发行：把桌面应用转成网站、做远程访问、变网页版、做个远程连接。
agent_created: true
trigger_keywords:
  - 转成网站
  - 远程访问
  - 网页版
  - 远程连接
  - 远程单机
  - 桌面应用转网页
  - convert to web
  - remote access
  - single user remote
---

# 桌面应用转远程单机网站 Skill

## 概述

把桌面应用程序转换为一个可以通过网络远程访问的网站，但只允许单人使用（非联机、非多用户）。采用类似聊天应用的技术架构：**Flask/FastAPI + WebSocket + HTML/CSS/JS 前端 + 隧道远程访问**。

## 触发条件

用户说出类似以下内容时加载此 Skill：

- "把这个桌面应用转成网页版"
- "做个远程访问"
- "转成可以远程连接的网站"
- "做成远程单机版"
- "像聊天应用那样远程连接"

## 工作流程

### 第 1 步：分析桌面应用

先搞清楚要转换的桌面应用是什么：

1. **读取并分析源码**（如果用户给了路径）
   - 使用什么框架？（Tkinter、PyQt、WxPython、Electron、WinForms 等）
   - 核心功能逻辑是什么？
   - 有什么交互界面？（按钮、输入框、列表、图表等）
   - 依赖哪些库/模块？

2. **如果用户没给代码，只是描述功能**：
   - 问清楚桌面应用的功能和交互方式
   - 确认有无外部依赖（数据库、API、本地文件等）

3. **评估转换方案**：

   | 原应用类型 | 转换方案 |
   |-----------|---------|
   | Python GUI（Tkinter/PyQt等） | 用 Flask/FastAPI 重写交互逻辑，保留核心功能代码 |
   | Electron/Node.js | 用 Express + WebSocket 包装，前端用 HTML/CSS/JS |
   | 其他语言（C++/C#/Java等） | 抽象核心逻辑，用 Python 重写 Web 版 |
   | 只是概念/功能描述 | 直接从零搭建 Flask/FastAPI + WebSocket 应用 |

### 第 2 步：构建 Web 服务器（Flask/FastAPI + WebSocket）

核心架构：

```
[浏览器] ←WebSocket→ [Flask/FastAPI 服务器] ←→ [应用核心逻辑]
                ↑
         单用户锁（同一时间只允许一个连接）
```

1. **创建项目结构**：

```
project/
├── app.py              # 主服务器入口
├── static/
│   └── index.html      # 前端界面
├── core/               # 核心业务逻辑（复用桌面应用的逻辑）
│   └── logic.py
└── requirements.txt    # 依赖列表
```

2. **实现关键组件**：

   **Flask/FastAPI 服务端**：
   - 提供 REST API 处理非实时请求
   - 使用 WebSocket（Flask-SocketIO / FastAPI WebSocket）处理实时交互
   - **单用户 Session 锁**：用全局变量记录当前连接 session_id，新连接时检查是否已被占用

   **单用户控制逻辑**（核心设计）：
   ```python
   # 示意——单用户 session 锁
   active_session = None  # 当前活跃的 session id
   
   @socketio.on('connect')
   def handle_connect():
       global active_session
       if active_session is not None:
           # 拒绝连接，发送"当前有用户在使用"提示
           emit('busy', {'message': '当前有用户在使用，请稍后再试'})
           return False
       active_session = request.sid
       emit('connected', {'message': '连接成功，你是当前唯一用户'})
   
   @socketio.on('disconnect')
   def handle_disconnect():
       global active_session
       if request.sid == active_session:
           active_session = None
   ```

   **前端界面**：
   - 使用 HTML/CSS/JS 纯前端
   - 通过 WebSocket 连接服务端
   - 实现响应式布局（手机/电脑都能访问）
   - 显示连接状态（已连接 / 等待 / 繁忙）
   - **必须加上 PWA 支持**，让 iPhone 用户能添加到主屏幕当原生 App 用：
     * `<meta name="apple-mobile-web-app-capable" content="yes">`
     * `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`
     * `<meta name="theme-color" content="应用主题色">`
     * `<link rel="apple-touch-icon" href="data:image/svg+xml,...">`（用 data URI 内联 SVG 图标，不要用外部图片文件）
     * inline manifest：用 data URI 内联一个简版 manifest JSON，设置 name、display: standalone、icons（用 data URI SVG）
     * service worker：用 Blob URL 注册内联 service worker，实现简单离线缓存
   - 添加到主屏幕后，打开无浏览器栏、有独立图标、启动画面

3. **复用桌面应用的核心逻辑**：
   - 把桌面应用中的业务逻辑抽取为独立模块（`core/logic.py`）
   - 不要在 Web 版里重新实现业务逻辑，直接 import 复用
   - GUI 交互层需要重写为 WebSocket 事件

### 第 3 步：配置远程访问（隧道）

构建完成后，配置远程访问让外部网络能连进来：

1. **推荐方案：ngrok**
   ```
   ngrok http 5000
   ```
   - 启动后生成公网 URL（如 `https://xxxx.ngrok.io`）
   - 把 URL 发给用户即可远程访问

2. **备选方案：Cloudflare Tunnel**
   ```
   cloudflared tunnel --url http://localhost:5000
   ```
   - 不需要注册，生成更快
   - 国内访问速度看网络状况

3. **自建方案：自定义中继**
   - 如果有公网服务器，搭建 WebSocket 中继
   - 客户端服务器 → 中继 → 浏览器
   - 适用于对延迟/安全有要求的场景

4. **提供运行脚本**：
   - 生成启动脚本（`start.bat` Windows / `start.sh` Linux/Mac）
   - 一键启动服务器 + 隧道

### 第 4 步：运行 bug-fixer 自检

网站构建完成后，**调用 bug-fixer skill** 做全面检查：

1. 加载 `bug-fixer` 技能（`Skill` 工具加载 `bug-fixer`）
2. 告诉 bug-fixer：「转换后的远程网站，检查服务端和前端代码有没有 bug」
3. bug-fixer 会完成：语法检查 → 逻辑检查 → 修复 → 全量检测
4. **等 bug-fixer 确认无 bug 后**，才进入下一步

### 第 5 步：询问后续操作

自检通过后，询问用户：

> "远程单机网站做好了！要不要：\n1️⃣ 直接启动服务器测试\n2️⃣ 转成 APK 安卓应用（用 to-apk skill）\n3️⃣ 两个都搞"

## 输出规范

- 项目结构清晰，每个文件注明用途
- 提供 `requirements.txt` 和启动脚本
- 中文界面，口语化提示
- Windows 优先（`.bat` 启动脚本）
- 输出 ngrok/Cloudflare 的下载和使用说明

## 注意事项

- **强调单用户限制**：这是设计约束，不是 bug
- 如果用户想改成多用户，不建议在本次转换范围内
- 国内环境 ngrok 可能被墙，备选 Cloudflare Tunnel
- 敏感功能（文件操作、系统命令）要在前端提示权限和安全风险
- 确保 WebSocket 连接有重连机制（断线自动重连）
- 如果桌面应用使用了本地硬件（摄像头、串口等），需要在 Web 版中说明限制
