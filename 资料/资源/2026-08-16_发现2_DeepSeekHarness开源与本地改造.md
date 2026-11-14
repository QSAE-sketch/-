# 2026-08-16 发现2 · DeepSeek Harness（dsh）开源工具与本地模型改造

> 补存 2026-09-01。盘符 E: 为记忆库，UUID 0a89e2a3-ade1-4f58-ac7d-1edba7e8f167 识别。

## 工具本体
- **DeepSeek Harness (`dsh`)**：DeepSeek 2026-08-13 开源的 AI agent 工具，MIT 协议，GitHub `deepseek-ai/deepseek-harness`。
- 架构：**Cordis 插件系统**（"一切皆插件"），模型后端是独立插件（seam），可替换。
- 版本 v0.1.0-rc.6（npm 包 `@deepseek-ai/dsh`）。
- 人类可用界面：**web**（浏览器，默认 127.0.0.1:3080）+ **headless**（一次性命令行任务）。**无人类用 TUI**（dsh-terminal 是给 agent 跑命令的后端 PTY seam，不是聊天界面）。

## 模型适配器改造（核心可复用经验）
- 官方云端适配器：`@deepseek-ai/dsh-llm-deepseek`，本质是 OpenAI 兼容 chat-completions + SSE 协议。
- 改造路径（最干净、零编译）：
  1. 复制 `dsh-llm-deepseek` → `dsh-llm-local`，改 4 处：包名、PROVIDER 名、`baseURL` 默认指向 `http://localhost:11434/v1`、模型目录换本地（`deepseek-r1:7b`/`qwen2.5:7b`）、API key 可空（本地不需要）、thinking 默认 off（Ollama 不支持 thinking 字段）。
  2. 写 `cordis.patch.yml` 用 `- insert:` 注入 `llm-local` 插件，覆盖 `agent-default-model` 的 provider/model。
  3. 启动：`node bin.js --profile web --patch local-ollama.patch.yml`。
- **验证通过**：headless 跑本地 `deepseek-r1:7b` 返回真实回复，全程零云端 KAPI 费用。

## 避坑（Windows 路径）
- Git Bash 里 `/d/.workbuddy` 会被 MSYS 转成 `D:\workbuddy`（丢点号）或 `D:\d\.workbuddy`，Node 解析错。
- 解决：设 `MSYS_NO_PATHCONV=1` 用 `/d/.workbuddy` 原生路径，或直接在 PowerShell 用反斜杠 Windows 路径（`D:\.workbuddy\...`）。
- Bash 工具内调 `cmd.exe` 被安全策略禁止；用 PowerShell 跑 node 命令最稳。
- npm 依赖不上全局 PATH，正确做法是封装 `.bat` 进 `D:\便携式工具箱\bin\`（已在用户 PATH）。

## 复用价值
- 以后任何"把云端 LLM 工具改成连本地模型"的需求，照此复制适配器+patch 模式即可。
- 本地模型零费用，适合大佬"不想花云端钱"的偏好。
