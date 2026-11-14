# bug-fixer Skill — 5 阶段自动 BUG 修复流水线

## 发现时间
2026-07-13

## 定位
WorkBuddy 用户级 Skill，用于自动检测并修复项目中的 BUG。

## 触发词
修BUG、自动修bug、检测并修复bug、修复错误、bug fix、fix bugs、debug and fix

## 核心架构

### 5 阶段流水线

```
Phase 1 [检测] ──> Phase 2 [修复] ──> Phase 3 [验证] ──> Phase 4 [残余扫描] ──> Phase 5 [最终验证]
```

- **Phase 1 (检测)**: 自动识别项目类型 → 运行 linter/type-check/tests/模式扫描 → 生成 `bug_report.json`
- **Phase 2 (修复)**: 按 critical→major→minor 逐个修复，改一个立即语法检查确认
- **Phase 3 (验证)**: 针对每个已修复 BUG 重跑当初检出它的命令，确认真修好
- **Phase 4 (残余扫描)**: 全面重新扫描，找漏网之鱼和复发
- **Phase 5 (最终验证)**: 编译检查 + 测试套件 + 构建验证，出最终报告

### 支持的项目类型

| 项目类型 | 检测标准 | 工具链 |
|---------|---------|--------|
| Python | setup.py, pyproject.toml, requirements.txt | pylint, mypy, pytest, py_compile |
| Node.js | package.json, tsconfig.json | eslint, tsc, jest |
| Go | go.mod | go vet, go test |
| Rust | Cargo.toml | cargo check, cargo test |

通用基础扫描涵盖：bare except、硬编码密钥、被注释的调试代码、TODO/FIXME 遗留等。

### 文件结构

```
~/.workbuddy/skills/bug-fixer/
├── SKILL.md                      # 技能说明书（AI 助手操作手册）
└── scripts/
    ├── bug_fixer.py              # 主引擎（detect/check/verify/validate/pipeline 命令）
    └── common_bug_patterns.py    # 常见 BUG 修复模板（Python/JS/Go/Java）
```

### 关键特性

- **一站式命令**: `python3 scripts/bug_fixer.py pipeline` 一键跑完所有阶段
- **bug_report.json** 全程跟踪每个 BUG 状态：detected → fixed → verified → done
- 同一 BUG 连续 3 次修复失败会停止并报告
- 误报可标记为 false_positive

## 安装位置
`~/.workbuddy/skills/bug-fixer/`（用户级 Skill）
