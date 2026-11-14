#!/usr/bin/env python3
"""
common_bug_patterns.py — 常见 BUG 模式的检测逻辑和修复模板

该脚本提供了常见 BUG 模式的识别规则和对应的修复模板，
供 AI 助手在 Phase 2（修复）阶段参考使用。
"""

COMMON_BUG_PATTERNS = {
    # ── Python ──
    "bare_except": {
        "language": "python",
        "description": "过于宽泛的 bare except，会捕获所有异常包括 KeyboardInterrupt",
        "detect": r"^except:",
        "fix_template": """将 bare `except:` 替换为具体的异常类型：

  # ❌ 错误
  try:
      process(data)
  except:
      log_error()

  # ✅ 正确
  try:
      process(data)
  except ValueError as e:
      log_error(f"数据错误: {e}")
  except Exception as e:
      log_error(f"未知错误: {e}")
""",
        "severity": "major",
    },

    "unused_variable": {
        "language": "python",
        "description": "定义了但未使用的变量",
        "detect": r"^\s+\w+\s*=\s*.+$（且后续未引用该变量名）",
        "fix_template": """删除未使用的变量，或用 `_` 占位：

  # ❌ 错误
  result = compute()
  return True

  # ✅ 正确（如果确实不需要）
  _ = compute()
  return True

  # ✅ 或直接删除该行
  return True
""",
        "severity": "minor",
    },

    "mutable_default_arg": {
        "language": "python",
        "description": "在函数参数中使用可变默认值，会导致多个调用共享同一对象",
        "detect": r"def \w+\(.*=\s*\[\s*\]|def \w+\(.*=\s*\{\s*\}",
        "fix_template": """将可变默认值改为 None，函数内初始化：

  # ❌ 错误
  def add_item(item, items=[]):
      items.append(item)
      return items

  # ✅ 正确
  def add_item(item, items=None):
      if items is None:
          items = []
      items.append(item)
      return items
""",
        "severity": "major",
    },

    "no_finally_close": {
        "language": "python",
        "description": "文件/资源打开后没有用 context manager 或 finally 关闭",
        "detect": r"open\(.*\)\s*$（不在 with 块中）",
        "fix_template": """使用 with 语句自动管理资源：

  # ❌ 错误
  f = open("data.txt")
  data = f.read()
  # 忘了 f.close()

  # ✅ 正确
  with open("data.txt") as f:
      data = f.read()
""",
        "severity": "major",
    },

    # ── JavaScript / TypeScript ──
    "console_log_left": {
        "language": "javascript",
        "description": "调试用的 console.log 遗留在了代码里",
        "detect": r"console\.log\(",
        "fix_template": """删除或注释掉调试用的 console.log：

  // ❌ 错误
  console.log('debug:', data);
  return data;

  // ✅ 正确
  return data;
""",
        "severity": "minor",
    },

    "==_instead_of_===": {
        "language": "javascript",
        "description": "使用 == 而非 ===，会导致隐式类型转换",
        "detect": r"==\s",
        "fix_template": """使用严格相等运算符 ===：

  // ❌ 错误
  if (val == 42) { ... }

  // ✅ 正确
  if (val === 42) { ... }
""",
        "severity": "major",
    },

    "var_instead_of_let_const": {
        "language": "javascript",
        "description": "使用 var 声明变量（函数作用域，容易出问题）",
        "detect": r"\bvar\s+\w+",
        "fix_template": """使用 let 或 const 替代 var：

  // ❌ 错误
  var count = 0;

  // ✅ 正确
  let count = 0;
  const MAX = 100;
""",
        "severity": "minor",
    },

    # ── Go ──
    "unhandled_error_go": {
        "language": "go",
        "description": "未处理函数返回的 error",
        "detect": r"\w+\s*:?=\s*\w+\(.*\)\n(?!\s+if\s+.+err)",
        "fix_template": """始终处理返回的 error：

  // ❌ 错误
  f, _ := os.Open("file.txt")

  // ✅ 正确
  f, err := os.Open("file.txt")
  if err != nil {
      log.Fatal(err)
  }
""",
        "severity": "critical",
    },

    # ── Java ──
    "print_stack_trace": {
        "language": "java",
        "description": "在生产代码中使用 printStackTrace()",
        "detect": r"printStackTrace\(\)",
        "fix_template": """使用日志框架替代：

  // ❌ 错误
  e.printStackTrace();

  // ✅ 正确
  logger.error("操作失败", e);
""",
        "severity": "minor",
    },
}

# ── 辅助函数 ──

def get_patterns_for_language(language: str) -> dict:
    """获取指定语言的常见 BUG 模式。"""
    return {
        name: pattern
        for name, pattern in COMMON_BUG_PATTERNS.items()
        if pattern["language"] == language
    }


def get_pattern_by_name(name: str) -> dict | None:
    """通过模式名称获取修复模板。"""
    return COMMON_BUG_PATTERNS.get(name)


def list_all_patterns() -> str:
    """列出所有支持的 BUG 模式。"""
    lines = ["支持的常见 BUG 模式:", ""]
    for lang in sorted({p["language"] for p in COMMON_BUG_PATTERNS.values()}):
        lines.append(f"  [{lang}]")
        for name, pattern in COMMON_BUG_PATTERNS.items():
            if pattern["language"] == lang:
                severity_icon = {"critical": "🔴", "major": "🟠", "minor": "🟡"}
                icon = severity_icon.get(pattern["severity"], "⚪")
                lines.append(f"    {icon} {name}: {pattern['description']}")
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    print(list_all_patterns())
