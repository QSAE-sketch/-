---
name: intranet-tunnel
description: 一键把本机服务（网站/游戏/接口/桌面应用）暴露到公网，让外网任何人都能访问。主打"用户只说一句话、AI 全自动完成"：自动探测端口、自动安装穿透工具（cloudflared quick tunnel 免登录，或 ssh localhost.run 零下载）、自动启动隧道并提取公网 URL、用完自动停止。适合不懂技术的小白用户，也适合需要快速临时穿透的开发者。触发词：内网穿透、穿透、公网访问、外网访问、让别人访问我的、把端口露出去、远程访问、tunnel、ngrok、frp、cloudflare tunnel。
agent_created: true
trigger_keywords:
  - 内网穿透
  - 公网访问
  - 外网访问
  - 让别人访问我的
  - 把端口露出去
  - 远程访问
  - 穿透
  - tunnel
  - ngrok
  - frp
  - cloudflare tunnel
  - 暴露到公网
---

# 内网穿透助手 Skill

## 概述

把运行在用户本机（127.0.0.1 / localhost）上的服务，通过一个临时公网隧道暴露出去，
让不在同一局域网的人也能直接访问。本 Skill 的核心理念是 **"用户只动嘴，AI 跑断腿"**：

- 用户只需说一句类似「把我的游戏/网站露出去」「让朋友能访问」或「把 3000 端口穿透」；
- AI 自动完成：**探测端口 → 安装工具 → 启动隧道 → 提取公网 URL → 交给用户**；
- 用户拿到 URL 发别人即可；说一声「停」AI 就关掉隧道。

**零注册、零配置优先**：默认走免登录方案，不需要用户去任何网站注册账号。

## 触发条件

用户说出类似以下内容时加载此 Skill：

- "帮我把我的网站穿透出去，让朋友能玩"
- "把 3000 端口暴露到公网"
- "让外网能访问我电脑上的这个程序"
- "做个内网穿透 / tunnel"
- "我想让别人连我的游戏服务器"
- "ngrok / frp / cloudflare tunnel 帮我弄一下"

## 方案选型（AI 自动决定，用户无需关心）

| 优先级 | 方案 | 是否需注册 | 是否需下载 | 适用情况 |
|--------|------|-----------|-----------|----------|
| 1（默认） | **cloudflared quick tunnel** | 否（免登录） | 是（首次 ~30MB，已缓存则跳过） | 绝大多数场景，最稳定 |
| 2（兜底） | **ssh localhost.run** | 否 | 否（用系统自带 ssh） | 无法下载 cloudflared、或想零下载时 |
| 3（高级） | ngrok / frp / 花生壳 | 是（需用户已有 token/服务器） | 视情况 | 用户主动要求、或已有账号/服务器 |

- 默认用方案 1；脚本内置自动降级：方案 1 下载失败或启动异常时，自动尝试方案 2。
- 只有在用户**明确说**"用 ngrok / 用 frp / 我有服务器"时，才走方案 3，并引导用户提供 token 或服务器地址。

## AI 工作流

### 第 0 步：确认要穿透的端口（尽量不问，自动探测）

1. 如果用户**已经说了端口号**（如「3000」），直接用。
2. 如果用户只说了服务名（如「我的网站」「游戏」）但没说端口：
   - 先自动探测本机正在监听的端口，列出来用一句话请用户确认，而不是长篇大论：
     - Windows：`netstat -ano | findstr LISTENING`
     - Linux/macOS：`ss -ltnp 2>/dev/null || lsof -i -P -n | grep LISTEN`
   - 把探测结果整理成「你电脑上现在开了这些端口：80 / 3000 / 8080，要露哪个？」让用户回一个数字即可。
   - 若探测到明显是 Web 服务的端口（80/443/3000/5000/8080/8000），可主动建议最常用的那个。
3. 全程只用**一句话**反问，不要让用户做选择题堆砌。

### 第 1 步：启动隧道（AI 全自动，核心）

直接调用本 Skill 提供的脚本（脚本已处理下载、安装、启动、URL 提取的全部脏活）：

```bash
# 用本机托管的 Python 运行（Windows 示例路径，其他系统同理）
python "<skill>/scripts/start_tunnel.py" --port <端口> --method auto
```

- `<skill>` 指本 Skill 目录（即包含此 SKILL.md 的目录）。
- `--method auto` 让脚本自动选 cloudflared，失败降级 ssh。也可显式 `--method cloudflared` / `--method ssh`。
- **必须后台运行**：用运行工具的「后台执行」方式启动该脚本，因为它会常驻不退。
- 脚本会把日志写到固定位置 `~/.workbuddy/intranet-tunnel/tunnel.log`，
  并在拿到公网地址后写入 `~/.workbuddy/intranet-tunnel/tunnel.url`，同时向 stdout 打印一行：
  `[TUNNEL_READY] https://xxxx.trycloudflare.com`（或 localhost.run 的地址）。

**拿 URL 的方法**：启动后轮询读取 `~/.workbuddy/intranet-tunnel/tunnel.url` 文件，
内容出现即代表隧道已建立，读出其中的 URL。

### 第 2 步：把结果交给用户（极简）

拿到 URL 后，用大白话告诉用户，例如：

> 🌐 搞定！把这个链接发给你朋友，他点开就能访问了：
> **https://xxxx.trycloudflare.com**
> 你本机服务不用关，保持开着就行。想停止的时候跟我说一声「停」。

- 强调：**只要本机服务还在跑、隧道没关，链接就一直有效**。
- 提醒安全（见下方「安全提示」）：只露必要端口，用完即停。

### 第 3 步：停止隧道

用户说「停 / 关掉 / 不用了」时，运行：

```bash
python "<skill>/scripts/stop_tunnel.py"
```

脚本会读取 PID 文件并结束隧道进程，清理日志。结束后告诉用户「已关闭，链接失效」。

## 脚本说明（scripts/）

- **start_tunnel.py**：跨平台（Windows/Linux/macOS）。参数：
  - `--port`（必填，要暴露的本机端口）
  - `--method auto|cloudflared|ssh`（默认 auto）
  - `--url <本机地址>`（可选，默认 http://localhost:PORT）
  - 行为：确保状态目录存在 → 检测/下载 cloudflared → 启动隧道（输出重定向到日志）→
    轮询日志用正则提取公网 URL → 写入 `tunnel.url` 并打印 `[TUNNEL_READY]` 标记 → 保持前台常驻。
  - 下载会通过环境变量 `http_proxy` / `https_proxy` 走代理（如果用户设了的话）。
  - 全程中文日志，方便排错。
- **stop_tunnel.py**：读 `~/.workbuddy/intranet-tunnel/tunnel.pid` 结束进程，清理状态文件。

> 注意：脚本是给 AI 直接调用的「确定性工具」，不要把整段脚本读进上下文逐行推理；
> 只在需要排查问题或按本机环境微调时才读它。

## 常见问题（AI 自助处理，无需打扰用户）

- **cloudflared 下载慢/被墙**：脚本会自动降级到 ssh localhost.run；
  若用户有代理，可提示其设置 `http_proxy` / `https_proxy` 环境变量后重试。
- **端口被占用 / 连接拒绝**：确认本机该端口确实有服务在监听（用第 0 步的探测命令），
  隧道本身只是转发，本机服务必须先跑起来。
- **URL 迟迟不出现**：读 `tunnel.log` 看报错；多半是网络不通或下载失败，按上面降级处理。
- **Windows 没有 ssh 客户端（localhost.run 兜底失败）**：提示用户安装 Git Bash 或
  Windows 可选功能 OpenSSH；或直接重试 cloudflared（给它更长时间下载）。

## 安全提示（必须向用户说明）

- 公网隧道 = 把本机端口向全网开放，**任何人拿到链接都能访问**。只暴露必要的端口和服务。
- 不要穿透含敏感数据的服务（如数据库、内网管理后台），除非你信任访问者。
- **用完即停**：离开前让 AI 关掉隧道，链接立即失效，最安全。
- quick tunnel 地址是随机域名、随时变化，不适合做长期固定服务；长期需求请引导用户用
  自有域名 + cloudflared 命名隧道，或 frp 自建（方案 3）。

## 输出规范

- 中文交互，口语化，像跟小白说话。
- 用户侧动作压到最少：一句话给端口/服务名 + 领 URL + 一句「停」。
- AI 侧动作尽量隐蔽完成，只在「下载工具」「已就绪」「已停止」三个节点给用户简短反馈。
