# 2026-08-07 事件 · WorkBuddy skill 迁移（转 openclaw 版 + 记忆库副本）

## 背景
用户要求：① 把本次对话成果「保存到记忆库」；② 把 WorkBuddy 的**所有** skill 存一份到记忆库专门放 skill 的地方；③ 机器2（本机）的备份/重复文件不用搞；④ 把每个 skill 都写一份 **openclaw 版本**，已有同名的就不重复写。

中途本机 C 盘爆满（清理危机，单独存档 `2026-08-07_事件_C盘爆满清理危机.md`），危机解除后继续完成迁移。

## 过程与判定
1. **openclaw 聊天记录清理**（先备后删）
   - openclaw **无清聊天记录命令**（`openclaw chat/tui` 仅有 `--history-limit`，`backup` 只能备不能删）。
   - 先 `openclaw backup create` 兜底（生成 `C:\Users\baoka\2026-08-03T...openclaw-backup.tar.gz`，约 7.9MB）。
   - 手动删 `~/.openclaw/agents/main/sessions/` 下全部 `*.jsonl` / `*.trajectory.jsonl` / `sessions.json` / `*.jsonl.reset.*` / `*.trajectory-path.json`，以及 `~/.openclaw/tui/last-session.json`。
   - 结果：sessions 目录从 9.9MB 降到 68K（仅剩 `skills-prompts/`）。

2. **两边 skill 清单对比（重复不写）**
   - WorkBuddy 侧 17 个 / openclaw 侧 15 个。
   - openclaw 已有、跳过不写的 7 个（重复）：`code-generator`、`code-to-website`、`desktop-to-remote-web`、`html-to-windows-exe`、`openclaw-game-gen`、`to-apk`、`图片生成器`。
   - 需转写 openclaw 版的 10 个（WorkBuddy 独有）：`android-native-dev`、`app-to-scratch`、`bug-fixer`、`flutter-dev`、`frontend-dev`、`fullstack-dev`、`intranet-tunnel`、`ios-application-dev`、`neuroevolution-game-ai`、`react-native-dev`。

3. **转写 10 个 openclaw 版 skill**（写到 `~/.openclaw/skills/`）
   - 遵循 openclaw `make-skill` 规范：小写连字符 `name` + 引号 `description` + `metadata.openclaw`（emoji，脚本类加 `requires: python3`）+ **agent 自执行正文**（去除 WorkBuddy 专属工具调用与手册式措辞）。
   - 整目录复制（保留 `references/`/`scripts/`/`examples/`/`templates/`/`canvas-fonts/`），排除 WorkBuddy 平台专属文件（`_icon.svg`/`_skillhub_meta.json`/`__MACOSX`/`__pycache__`）。
   - 定点修补：intranet-tunnel 正文含 banned 词「请用户/请引导」已改；neuroevolution 的本机特定路径（`C:\Users\baoka\.workbuddy\binaries\...`、`D:\AI\...`）泛化成「本机已有 venv / 先搜常用工作区」；intranet-tunnel 脚本与文档里写死的 `~/.workbuddy/intranet-tunnel` 状态路径改为 `~/.openclaw/intranet-tunnel`。
   - 校验：10 个 frontmatter 合法 + 反手册式 banned 词扫描通过（问题数 0）。

4. **U 盘记忆库 skill 副本**
   - 记忆库规则（存储映射表）原无专门 skill 目录，新建 `H:\资料\skills\` 作 WorkBuddy 全集副本仓库。
   - 复制 WorkBuddy 17 个真正 skill 目录（含 SKILL.md 的）全集进去，排除 WB 专属文件。
   - `H:\资料\游戏成果\机器2本地备份\skills\` 的 7 个老备份 + `bug-fixer.zip` 按「机器2备份重复的不用搞」原样未动。

5. **U 盘盘符双机差异**（已记入长期记忆 `~/.workbuddy/MEMORY.md`）
   - 两台机器分区数不同（一台 C/D、一台 C/D/E），U 盘排到的字母随之变化（本次在 H:，之前在 G:）。
   - 结论：盘符变是**正常现象**，不等于 U 盘没插；定位统一靠卷标「记忆库」查 `Win32_Volume`，不再写死 G:。

## 成果
- 10 个 openclaw 版 skill 已落到 `~/.openclaw/skills/`，格式合规、校验通过（重启 OpenClaw 即加载）。
- 17 个 WorkBuddy skill 全集副本已入 U 盘 `H:\资料\skills/`。
- openclaw 聊天记录已清空（有 7.9MB 备份兜底）。

## 遗留 / 注意
- 本机 git-bash 下 `openclaw` CLI 因 PATH 解析异常（找不到 OpenClaw 自身运行时模块）无法直接 `skills list` 验证；skill 文件本身已就位，OpenClaw 实际加载不受影响。
- `H:\资料\skills\` 与 `机器2本地备份\skills\` 有 7 个同名重叠（前者最新全集、后者老备份），属预期，不冲突。
