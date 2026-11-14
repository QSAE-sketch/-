# 2026-07-13 bug-fixer Skill 开发

## 触发
大佬要求开发一个修 BUG 的 Skill，实现：自动检测 BUG → 修复 → 验证修复成功 → 扫残余 → 最终验证。

## 过程

1. **加载 skill-creator**：按照 WorkBuddy 官方 skill 开发流程操作
2. **初始化 skill 目录**：使用 `init_skill.py` 生成 `bug-fixer` 骨架
3. **编写 SKILL.md**：设计 5 阶段工作流，每阶段的步骤、产出、注意事项全写进去
4. **编写主脚本 bug_fixer.py**：
   - 自动检测项目类型（Python/Node.js/Go/Rust）
   - 调用对应工具链做检测（pylint, eslint, go vet, cargo check 等）
   - bug_report.json 全程跟踪 BUG 状态
   - verify/validate/pipeline 子命令
5. **编写辅助脚本 common_bug_patterns.py**：
   - 收录 10 种常见 BUG 模式的检测逻辑和修复模板
   - 覆盖 Python（bare except、可变默认参数、资源泄漏）、JS（console.log、== 替代 ===、var）、Go（未处理 error）、Java（printStackTrace）
6. **验证打包**：通过 quick_validate 检验，成功打包为 bug-fixer.zip

## 遇到的坑
- YAML frontmatter 的 `description: >` 折叠语法中 `>` 符号被验证器的正则误判为 angle bracket，改为纯字符串后通过
- SKILL.md 正文中的 `<file>` `<id>` 等也被验证器拦截，全部替换为 `[file]` `[id]`

## 结果
- Skill 开发完成并部署到 `~/.workbuddy/skills/bug-fixer/`
- 打包文件 `~/.workbuddy/skills/bug-fixer.zip`
- 触发词：修BUG、自动修bug、检测并修复bug、修复错误
