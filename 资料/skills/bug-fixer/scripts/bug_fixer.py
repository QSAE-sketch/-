#!/usr/bin/env python3
"""
bug_fixer.py — 5-Phase Automated Bug Detection & Fix Pipeline

Phases:
  1. detect   — Scan project for bugs (lint, type-check, test failures, pattern scan)
  2. fix      — Apply fixes for detected bugs (guided, requires assistant interaction)
  3. verify   — Re-check specific fixes (targeted re-run of detection for each bug)
  4. residual — Full re-scan for remaining / newly introduced bugs
  5. validate — Final validation (compile, tests, build, runtime check)

Usage:
  python3 bug_fixer.py detect              Phase 1: detect bugs
  python3 bug_fixer.py report              Show bug report
  python3 bug_fixer.py check [file]        Quick syntax check on a single file
  python3 bug_fixer.py verify --bug-id [id] Phase 3: verify a specific fix
  python3 bug_fixer.py validate --all       Phase 5: full validation
  python3 bug_fixer.py pipeline            Run entire pipeline (Phase 1→5)
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

# ──────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────
BUG_REPORT_FILE = "bug_report.json"
SUPPORTED_PROJECT_TYPES = {
    "python": {"markers": ["setup.py", "pyproject.toml", "requirements.txt", "setup.cfg"]},
    "node":   {"markers": ["package.json", "package-lock.json"]},
    "go":     {"markers": ["go.mod"]},
    "rust":   {"markers": ["Cargo.toml"]},
}

# ──────────────────────────────────────────────
# Utilities
# ──────────────────────────────────────────────

def find_project_root() -> Path:
    """Walk up from cwd to find the project root (where VCS or key config lives)."""
    cwd = Path.cwd().resolve()
    for parent in [cwd] + list(cwd.parents):
        markers = [parent / ".git", parent / ".hg", parent / "go.mod",
                   parent / "Cargo.toml", parent / "setup.py",
                   parent / "pyproject.toml", parent / "package.json"]
        if any(m.exists() for m in markers):
            return parent
    return cwd


def detect_project_type(project_root: Path) -> Optional[str]:
    """Detect project type by looking for characteristic config files."""
    for ptype, info in SUPPORTED_PROJECT_TYPES.items():
        for marker in info["markers"]:
            if (project_root / marker).exists():
                return ptype
    return None


def run_cmd(cmd: list[str], cwd: Optional[Path] = None, timeout: int = 120,
            capture: bool = True) -> tuple[int, str, str]:
    """Run a shell command, return (returncode, stdout, stderr)."""
    try:
        r = subprocess.run(
            cmd,
            cwd=str(cwd or Path.cwd()),
            capture_output=capture,
            text=True,
            timeout=timeout,
        )
        return r.returncode, r.stdout or "", r.stderr or ""
    except subprocess.TimeoutExpired:
        return -1, "", f"Command timed out after {timeout}s: {' '.join(cmd)}"
    except FileNotFoundError:
        return -2, "", f"Command not found: {cmd[0]}. Is it installed?"
    except Exception as e:
        return -3, "", str(e)


def color(s: str, code: str) -> str:
    """Simple terminal coloring."""
    codes = {"red": "31", "green": "32", "yellow": "33", "cyan": "36", "bold": "1"}
    c = codes.get(code, "0")
    return f"\033[{c}m{s}\033[0m"


def eprint(*args, **kwargs) -> None:
    print(*args, file=sys.stderr, **kwargs)


# ──────────────────────────────────────────────
# Bug Report Management
# ──────────────────────────────────────────────

def load_bug_report(path: str = BUG_REPORT_FILE) -> list[dict]:
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return []


def save_bug_report(report: list[dict], path: str = BUG_REPORT_FILE) -> None:
    with open(path, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)


def print_report_summary(report: list[dict]) -> None:
    if not report:
        print(color("  ✨ 没有检测到 BUG！", "green"))
        return

    by_status: dict[str, list[dict]] = {}
    for b in report:
        by_status.setdefault(b.get("status", "detected"), []).append(b)

    print(f"\n{'='*60}")
    print(f"  BUG 报告摘要 — 共 {len(report)} 个")
    print(f"{'='*60}")
    for status, bugs in sorted(by_status.items()):
        label = {
            "detected": f"🆕 待修复 ({len(bugs)})",
            "fixed":    f"🔧 已修复 ({len(bugs)})",
            "verified": f"✅ 已验证 ({len(bugs)})",
            "fix_failed": f"❌ 修复失败 ({len(bugs)})",
            "false_positive": f"👻 误报 ({len(bugs)})",
        }.get(status, f"❓ {status} ({len(bugs)})")
        print(f"\n  {label}:")
        for b in bugs:
            sev = {"critical": "🔴", "major": "🟠", "minor": "🟡"}.get(
                b.get("severity", "major"), "⚪"
            )
            print(f"    {sev} [{b.get('id','?')}] {b.get('file','?')}:{b.get('line','?')}")
            print(f"       {b.get('description','')}")


# ──────────────────────────────────────────────
# Phase 1: Detection
# ──────────────────────────────────────────────

def detect_bugs(project_root: Path, residual: bool = False) -> list[dict]:
    """Run all available detection tools and return a list of bug dicts."""
    print(color(f"\n{'='*60}", "cyan"))
    print(color(f"  Phase 1: {'残余 BUG 扫描' if residual else 'BUG 检测'}", "cyan"))
    print(color(f"{'='*60}", "cyan"))

    ptype = detect_project_type(project_root)
    if ptype:
        print(f"  检测到项目类型: {ptype}")
    else:
        print(f"  未识别项目类型，回退到基础扫描")

    all_bugs: list[dict] = []

    # ── Python ──
    if ptype == "python":
        print(color("\n  → 运行 python -m py_compile ...", "yellow"))
        bugs = scan_python_syntax(project_root)
        all_bugs.extend(bugs)
        print(f"    语法错误: {len([b for b in bugs if b.get('tool')=='syntax'])} 个")

        if _tool_available("pylint"):
            print(color("  → 运行 pylint ...", "yellow"))
            bugs = scan_pylint(project_root)
            all_bugs.extend(bugs)
            print(f"    pylint 问题: {len(bugs)} 个")
        else:
            print(color("  → pylint 未安装，跳过", "yellow"))

        if _tool_available("mypy"):
            print(color("  → 运行 mypy ...", "yellow"))
            bugs = scan_mypy(project_root)
            all_bugs.extend(bugs)
            print(f"    mypy 问题: {len(bugs)} 个")
        else:
            print(color("  → mypy 未安装，跳过", "yellow"))

    # ── Node.js ──
    elif ptype == "node":
        has_ts = (project_root / "tsconfig.json").exists()

        if has_ts and _tool_available("npx"):
            print(color("  → 运行 tsc --noEmit ...", "yellow"))
            bugs = scan_tsc(project_root)
            all_bugs.extend(bugs)
            print(f"    TypeScript 错误: {len(bugs)} 个")

        if _tool_available("npx"):
            print(color("  → 运行 eslint ...", "yellow"))
            bugs = scan_eslint(project_root)
            all_bugs.extend(bugs)
            print(f"    ESLint 问题: {len(bugs)} 个")

    # ── Go ──
    elif ptype == "go":
        if _tool_available("go"):
            print(color("  → 运行 go vet ...", "yellow"))
            code, out, err = run_cmd(["go", "vet", "./..."], cwd=project_root)
            all_bugs.extend(_parse_go_vet_output(out + err))
            print(f"    go vet 问题: {len(all_bugs)} 个")

    # ── Rust ──
    elif ptype == "rust":
        if _tool_available("cargo"):
            print(color("  → 运行 cargo check ...", "yellow"))
            code, out, err = run_cmd(["cargo", "check", "--message-format=json"],
                                     cwd=project_root, timeout=300)
            all_bugs.extend(_parse_cargo_output(err))
            print(f"    cargo check 错误: {len(all_bugs)} 个")

    # ── 通用基础扫描（所有项目类型都跑） ──
    print(color("\n  → 运行基础文件扫描 ...", "yellow"))
    basics = scan_basic_issues(project_root)
    all_bugs.extend(basics)
    print(f"    基础扫描发现: {len(basics)} 个")

    # ── 测试扫描 ──
    print(color("  → 运行测试 ...", "yellow"))
    test_bugs = scan_tests(project_root, ptype)
    all_bugs.extend(test_bugs)
    print(f"    测试失败: {len(test_bugs)} 个")

    # ── Deduplicate and assign IDs ──
    seen = set()
    deduped = []
    for i, b in enumerate(all_bugs):
        key = (b.get("file", ""), b.get("line", ""), b.get("description", "")[:80])
        if key not in seen:
            seen.add(key)
            b["id"] = f"BUG-{i+1:04d}"
            b.setdefault("status", "detected")
            b.setdefault("severity", "major")
            deduped.append(b)

    return deduped


def _tool_available(name: str) -> bool:
    """Check if a CLI tool is available on PATH."""
    try:
        subprocess.run([name, "--version"], capture_output=True, timeout=10)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


# ── Python scanners ──

def scan_python_syntax(root: Path) -> list[dict]:
    bugs = []
    py_files = list(root.rglob("*.py"))
    # Exclude hidden dirs
    py_files = [f for f in py_files if not any(p.startswith(".") for p in f.relative_to(root).parts)]

    for f in py_files:
        code, out, err = run_cmd(
            [sys.executable, "-m", "py_compile", str(f)], cwd=root
        )
        if code != 0:
            for line in (out + err).splitlines():
                if "Error" in line or "SyntaxError" in line:
                    bugs.append({
                        "tool": "syntax",
                        "file": str(f.relative_to(root)),
                        "line": _extract_line_num(line),
                        "description": line.strip(),
                        "severity": "critical",
                    })
    return bugs


def scan_pylint(root: Path) -> list[dict]:
    bugs = []
    code, out, err = run_cmd(
        [sys.executable, "-m", "pylint", "--output-format=text", "--fail-under=0", "."],
        cwd=root, timeout=120
    )
    for line in (out + err).splitlines():
        # pylint format: file:line:col: C0114: message
        if ":" in line and line.strip() and not line.startswith("*"):
            parts = line.split(":", 4)
            if len(parts) >= 5:
                sev_map = {"C": "minor", "R": "minor", "W": "major", "E": "major", "F": "critical"}
                code_letter = parts[3].strip()[0] if parts[3].strip() else "C"
                bugs.append({
                    "tool": "pylint",
                    "file": parts[0],
                    "line": parts[1],
                    "description": parts[4].strip(),
                    "severity": sev_map.get(code_letter, "major"),
                    "extra": f"pylint code: {parts[3].strip()}",
                })
    return bugs


def scan_mypy(root: Path) -> list[dict]:
    bugs = []
    code, out, err = run_cmd(
        [sys.executable, "-m", "mypy", "--show-error-codes", "."],
        cwd=root, timeout=120
    )
    for line in (out + err).splitlines():
        if ":" in line and "error:" in line.lower():
            parts = line.split(":", 3)
            if len(parts) >= 4:
                bugs.append({
                    "tool": "mypy",
                    "file": parts[0].strip(),
                    "line": parts[1].strip(),
                    "description": parts[3].strip(),
                    "severity": "major",
                })
    return bugs


# ── Node.js scanners ──

def scan_tsc(root: Path) -> list[dict]:
    bugs = []
    code, out, err = run_cmd(
        ["npx", "--yes", "typescript", "--noEmit"], cwd=root, timeout=180
    )
    for line in (out + err).splitlines():
        if "error TS" in line or "error:" in line.lower():
            parts = line.split("(", 1)
            if len(parts) >= 2:
                file_part = parts[0].strip()
                rest = parts[1] if len(parts) > 1 else ""
                line_num = rest.split(")")[0] if ")" in rest else "?"
                desc = line.strip()
                bugs.append({
                    "tool": "tsc",
                    "file": file_part,
                    "line": line_num,
                    "description": desc,
                    "severity": "critical",
                })
    return bugs


def scan_eslint(root: Path) -> list[dict]:
    bugs = []
    config_exists = any(
        (root / f".eslintrc.{ext}").exists() or (root / f).exists()
        for ext in ["js", "json", "yaml", "yml"] for f in [".eslintrc", "eslint.config.js"]
    )
    if not config_exists:
        return bugs

    code, out, err = run_cmd(
        ["npx", "eslint", ".", "--format=json"], cwd=root, timeout=120
    )
    try:
        results = json.loads(out)
    except json.JSONDecodeError:
        return bugs

    for file_result in results:
        fpath = file_result.get("filePath", "")
        for msg in file_result.get("messages", []):
            severity = "major" if msg.get("severity", 1) >= 2 else "minor"
            bugs.append({
                "tool": "eslint",
                "file": str(Path(fpath).relative_to(root)) if fpath else "?",
                "line": str(msg.get("line", "?")),
                "description": msg.get("message", ""),
                "severity": severity,
                "extra": f"rule: {msg.get('ruleId', '?')}",
            })
    return bugs


# ── Go scanners ──

def _parse_go_vet_output(output: str) -> list[dict]:
    bugs = []
    for line in output.splitlines():
        if ":" in line and (".go:" in line):
            parts = line.split(":", 3)
            if len(parts) >= 4:
                bugs.append({
                    "tool": "go vet",
                    "file": parts[0].strip(),
                    "line": parts[1].strip(),
                    "description": parts[3].strip(),
                    "severity": "major",
                })
    return bugs


# ── Rust scanners ──

def _parse_cargo_output(output: str) -> list[dict]:
    bugs = []
    for line in output.splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("reason") == "compiler-message":
            msg = obj.get("message", {})
            spans = msg.get("spans", [])
            desc = msg.get("rendered", msg.get("message", ""))
            for span in spans:
                bugs.append({
                    "tool": "cargo check",
                    "file": span.get("file_name", "?"),
                    "line": str(span.get("line_start", "?")),
                    "description": desc.strip(),
                    "severity": "critical" if msg.get("level") == "error" else "major",
                })
    return bugs


# ── Basic file scan (universal) ──

def scan_basic_issues(root: Path) -> list[dict]:
    """Scan source files for common bug patterns."""
    bugs = []
    # Look for common red flags
    source_extensions = {".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs", ".java", ".cpp", ".c", ".h"}
    source_files = []
    for ext in source_extensions:
        source_files.extend(root.rglob(f"*{ext}"))
    # Exclude hidden dirs and node_modules, target, venv
    source_files = [f for f in source_files
                    if not any(
                        p.startswith(".") or p in ("node_modules", "target", "venv", "__pycache__", "dist", "build")
                        for p in f.relative_to(root).parts)]

    patterns = {
        "print_stack_trace": (r"printStackTrace\(\)", "minor", "可能泄露调试信息的 printStackTrace()"),
        "todo_fixme": (r"(TODO|FIXME|HACK|XXX)", "minor", "未完成的待办事项（TODO/FIXME）"),
        "hardcoded_secret": (r"(password|secret|api_key|apikey)\s*[:=]\s*['\"](?!\s*['\"])", "critical", "可能硬编码的密钥/密码"),
        "commented_code": (r"//\s*(console\.log|print|fmt\.Print)", "minor", "被注释掉的调试代码"),
    }

    for f in source_files:
        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
            lines = content.splitlines()
        except Exception:
            continue

        rel = str(f.relative_to(root))

        # Too-broad exception handling
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if "except:" in stripped and stripped.strip() == "except:":
                bugs.append({
                    "tool": "pattern",
                    "file": rel,
                    "line": str(i),
                    "description": "过于宽泛的异常捕获（bare except）",
                    "severity": "major",
                })
            if "except Exception" in stripped and "as" not in stripped:
                bugs.append({
                    "tool": "pattern",
                    "file": rel,
                    "line": str(i),
                    "description": "过于宽泛的捕获 Exception 不保存异常信息",
                    "severity": "major",
                })

    return bugs


# ── Test scanner ──

def scan_tests(root: Path, ptype: Optional[str]) -> list[dict]:
    bugs = []
    if ptype == "python":
        if (root / "pytest.ini").exists() or (root / "pyproject.toml").exists() or (root / "setup.cfg").exists():
            code, out, err = run_cmd(
                [sys.executable, "-m", "pytest", "--tb=short", "--no-header", "-q"],
                cwd=root, timeout=180
            )
            for line in (out + err).splitlines():
                if "FAILED" in line:
                    parts = line.split("::", 1)
                    if len(parts) >= 1:
                        bugs.append({
                            "tool": "pytest",
                            "file": parts[0].strip(),
                            "line": "?",
                            "description": f"测试失败: {line.strip()}",
                            "severity": "critical",
                        })
    elif ptype == "node":
        if _tool_available("npx"):
            # Try jest
            if (root / "jest.config.js").exists() or "jest" in (root / "package.json").read_text():
                code, out, err = run_cmd(
                    ["npx", "jest", "--no-coverage"], cwd=root, timeout=180
                )
                for line in (out + err).splitlines():
                    if "FAIL" in line:
                        bugs.append({
                            "tool": "jest",
                            "file": line.strip().split()[1] if len(line.strip().split()) > 1 else "?",
                            "line": "?",
                            "description": f"测试失败: {line.strip()}",
                            "severity": "critical",
                        })
    elif ptype == "go":
        code, out, err = run_cmd(["go", "test", "./...", "-count=1"], cwd=root, timeout=300)
        for line in (out + err).splitlines():
            if "FAIL" in line and "\t" in line:
                bugs.append({
                    "tool": "go test",
                    "file": "?",
                    "line": "?",
                    "description": f"测试失败: {line.strip()}",
                    "severity": "critical",
                })

    return bugs


# ── Helpers ──

def _extract_line_num(text: str) -> str:
    import re
    m = re.search(r"line\s+(\d+)", text)
    return m.group(1) if m else "?"


# ──────────────────────────────────────────────
# Phase 2: Fix (guided — this script only provides tooling)
# ──────────────────────────────────────────────

def check_file_syntax(file_path: str) -> tuple[bool, str]:
    """Quick syntax check on a single file. Returns (ok, details)."""
    p = Path(file_path)
    if not p.exists():
        return False, f"文件不存在: {file_path}"

    if p.suffix == ".py":
        code, out, err = run_cmd([sys.executable, "-m", "py_compile", str(p)])
        if code == 0:
            return True, "语法检查通过"
        return False, (out + err).strip()
    elif p.suffix in (".ts", ".tsx") and _tool_available("npx"):
        code, out, err = run_cmd(["npx", "tsc", "--noEmit", str(p)], timeout=60)
        if code == 0:
            return True, "语法检查通过"
        return False, (out + err).strip()
    else:
        return True, f"跳过语法检查（不支持的文件类型: {p.suffix}）"


# ──────────────────────────────────────────────
# Phase 3: Verify
# ──────────────────────────────────────────────

def verify_bug(bug_id: str, bug_report: list[dict], project_root: Path) -> dict:
    """Re-check a specific bug to see if it's fixed."""
    bug = next((b for b in bug_report if b.get("id") == bug_id), None)
    if not bug:
        return {"id": bug_id, "status": "not_found", "message": f"未找到 BUG #{bug_id}"}

    file_path = bug.get("file", "")
    tool = bug.get("tool", "")

    print(f"\n  验证 BUG #{bug_id} ({file_path}:{bug.get('line','?')})")

    # Re-run the tool that found it
    if tool == "syntax":
        ok, msg = check_file_syntax(str(project_root / file_path))
        if ok:
            return {"id": bug_id, "status": "verified", "message": "语法检查通过"}
        else:
            return {"id": bug_id, "status": "failed", "message": msg}
    elif tool in ("pylint", "mypy"):
        args_map = {"pylint": [sys.executable, "-m", "pylint", file_path],
                    "mypy": [sys.executable, "-m", "mypy", file_path]}
        cmd = args_map.get(tool)
        if cmd:
            code, out, err = run_cmd(cmd, cwd=project_root, timeout=60)
            combined = out + err
            if bug.get("description", "")[:60] in combined:
                return {"id": bug_id, "status": "failed", "message": "相同错误仍然存在"}
            return {"id": bug_id, "status": "verified", "message": "错误已消失"}
    elif tool in ("tsc", "eslint"):
        cmd_map = {"tsc": ["npx", "tsc", "--noEmit"],
                   "eslint": ["npx", "eslint", file_path]}
        cmd = cmd_map.get(tool)
        if cmd:
            code, out, err = run_cmd(cmd, cwd=project_root, timeout=60)
            if bug.get("description", "")[:60] in (out + err):
                return {"id": bug_id, "status": "failed", "message": "相同错误仍然存在"}
            return {"id": bug_id, "status": "verified", "message": "错误已消失"}
    elif tool in ("go vet", "go test"):
        cmd = ["go", "vet", f"./{Path(file_path).parent}"] if tool == "go vet" else \
              ["go", "test", f"./{Path(file_path).parent}"]
        code, out, err = run_cmd(cmd, cwd=project_root, timeout=120)
        if bug.get("description", "")[:60] in (out + err):
            return {"id": bug_id, "status": "failed", "message": "相同错误仍然存在"}
        return {"id": bug_id, "status": "verified", "message": "错误已消失"}
    elif tool in ("cargo check",):
        code, out, err = run_cmd(["cargo", "check"], cwd=project_root, timeout=300)
        if bug.get("description", "")[:60] in (out + err):
            return {"id": bug_id, "status": "failed", "message": "相同错误仍然存在"}
        return {"id": bug_id, "status": "verified", "message": "错误已消失"}
    elif tool in ("pytest", "jest"):
        return {"id": bug_id, "status": "needs_recheck", "message": "测试验证需在最终验证阶段统一执行"}

    return {"id": bug_id, "status": "unknown", "message": f"无法验证（未知工具: {tool}）"}


# ──────────────────────────────────────────────
# Phase 5: Validation
# ──────────────────────────────────────────────

def validate_project(project_root: Path, ptype: Optional[str]) -> dict[str, Any]:
    """Run final validation checks."""
    results: dict[str, Any] = {}

    print(color(f"\n{'='*60}", "cyan"))
    print(color("  Phase 5: 最终验证", "cyan"))
    print(color(f"{'='*60}", "cyan"))

    # ── 1. Compile check ──
    print(color("\n  📦 编译/语法检查 ...", "yellow"))
    compile_ok = True

    if ptype == "python":
        py_files = [f for f in project_root.rglob("*.py")
                    if not any(p.startswith(".") or p == "__pycache__" for p in f.relative_to(project_root).parts)]
        syntax_errors = 0
        for f in py_files:
            code, _, _ = run_cmd([sys.executable, "-m", "py_compile", str(f)])
            if code != 0:
                syntax_errors += 1
        compile_ok = syntax_errors == 0
        results["compile"] = {
            "status": "passed" if compile_ok else "failed",
            "detail": f"检查了 {len(py_files)} 个文件，{syntax_errors} 个语法错误" if not compile_ok else f"检查了 {len(py_files)} 个文件，全部通过",
        }
    elif ptype == "node":
        has_ts = (project_root / "tsconfig.json").exists()
        if has_ts:
            code, out, err = run_cmd(["npx", "tsc", "--noEmit"], cwd=project_root, timeout=120)
            compile_ok = code == 0
            results["compile"] = {
                "status": "passed" if compile_ok else "failed",
                "detail": "TypeScript 编译检查通过" if compile_ok else f"TypeScript 错误:\n{(out+err).strip()}",
            }
        else:
            results["compile"] = {"status": "skipped", "detail": "未检测到 TypeScript 配置"}
    else:
        results["compile"] = {"status": "skipped", "detail": "当前项目类型不支持自动编译检查"}

    print(f"    {'✅ 通过' if results['compile']['status'] == 'passed' else '❌ 失败'} — {results['compile']['detail']}")

    # ── 2. Tests ──
    print(color("\n  🧪 运行测试 ...", "yellow"))
    if ptype == "python":
        code, out, err = run_cmd([sys.executable, "-m", "pytest", "--tb=short", "-q"],
                                 cwd=project_root, timeout=180)
        if code == 0:
            test_ok = True
            test_detail = out.strip().splitlines()[-1] if out.strip() else "所有测试通过"
        else:
            test_ok = False
            fails = [l.strip() for l in (out + err).splitlines() if "FAILED" in l or "failed" in l.lower()]
            test_detail = "; ".join(fails) if fails else (out + err).strip()
        results["tests"] = {
            "status": "passed" if test_ok else "failed",
            "detail": test_detail,
        }
    elif ptype == "node":
        code, out, err = run_cmd(["npx", "jest", "--no-coverage", "--forceExit"],
                                 cwd=project_root, timeout=180)
        test_ok = code == 0
        results["tests"] = {
            "status": "passed" if test_ok else "failed",
            "detail": (out + err).strip()[-500:],
        }
    elif ptype == "go":
        code, out, err = run_cmd(["go", "test", "./...", "-count=1"],
                                 cwd=project_root, timeout=300)
        test_ok = code == 0
        results["tests"] = {
            "status": "passed" if test_ok else "failed",
            "detail": (out + err).strip()[-500:],
        }
    else:
        test_ok = True
        results["tests"] = {"status": "skipped", "detail": "未检测到测试框架"}

    print(f"    {'✅ 通过' if test_ok else '❌ 失败'} — {results['tests']['detail'][:200]}")

    # ── 3. Build ──
    print(color("\n  🔨 构建检查 ...", "yellow"))
    if ptype == "node":
        code, out, err = run_cmd(["npm", "run", "build"], cwd=project_root, timeout=180)
        build_ok = code == 0
        results["build"] = {
            "status": "passed" if build_ok else "failed",
            "detail": "构建成功" if build_ok else (out + err).strip()[-300:],
        }
    elif ptype == "rust":
        code, out, err = run_cmd(["cargo", "build"], cwd=project_root, timeout=300)
        build_ok = code == 0
        results["build"] = {
            "status": "passed" if build_ok else "failed",
            "detail": "构建成功" if build_ok else (out + err).strip()[-300:],
        }
    elif ptype == "go":
        code, out, err = run_cmd(["go", "build", "./..."], cwd=project_root, timeout=180)
        build_ok = code == 0
        results["build"] = {
            "status": "passed" if build_ok else "failed",
            "detail": "构建成功" if build_ok else (out + err).strip()[-300:],
        }
    else:
        build_ok = True
        results["build"] = {"status": "skipped", "detail": "当前项目类型不支持自动构建检查"}

    print(f"    {'✅ 通过' if build_ok else '❌ 失败'} — {results['build']['detail'][:200]}")

    results["overall"] = all(
        r.get("status") == "passed" or r.get("status") == "skipped"
        for r in results.values()
    )
    return results


# ──────────────────────────────────────────────
# Pipeline (Phase 1→5)
# ──────────────────────────────────────────────

def run_pipeline(project_root: Path) -> None:
    """Execute the full 5-phase pipeline."""
    start = datetime.now()

    print(color("╔══════════════════════════════════════════╗", "cyan"))
    print(color("║      🔧 BUG 修复流水线启动 🚀           ║", "cyan"))
    print(color("╚══════════════════════════════════════════╝", "cyan"))

    # Phase 1
    print(color("\n━━━ Phase 1/5: BUG 检测 ━━━", "bold"))
    bugs = detect_bugs(project_root)
    save_bug_report(bugs)

    if not bugs:
        print(color("\n  没有发现 BUG，直接进入最终验证。", "green"))
    else:
        print_report_summary(bugs)
        print(color("\n  ⏸️  Phase 2（修复）由 AI 助手引导执行，请按 SKILL.md 流程逐 BUG 修复。", "yellow"))
        print("  修复完成后运行: python3 bug_fixer.py verify-all")

    # Note: Phase 2-4 are executed interactively by the AI assistant following SKILL.md
    print(color(f"\n━━━ 已生成 bug_report.json，共 {len(bugs)} 个 BUG ━━━", "cyan"))

    # Phase 5
    ptype = detect_project_type(project_root)
    results = validate_project(project_root, ptype)

    elapsed = (datetime.now() - start).total_seconds()

    # Final report
    print(color(f"\n{'='*60}", "cyan"))
    print(color("  📋 BUG 修复最终报告", "cyan"))
    print(color(f"{'='*60}", "cyan"))
    print(f"  总检测 BUG 数: {len(bugs)}")
    print(f"  编译检查:       {'✅' if results.get('compile',{}).get('status')=='passed' else '❌'} {results.get('compile',{}).get('detail','')}")
    print(f"  测试套件:       {'✅' if results.get('tests',{}).get('status')=='passed' else '❌'} {results.get('tests',{}).get('detail','')}")
    print(f"  构建检查:       {'✅' if results.get('build',{}).get('status')=='passed' else '❌'} {results.get('build',{}).get('detail','')}")
    print(f"  总耗时:         {elapsed:.1f}s")
    print(color(f"{'='*60}", "cyan"))


# ──────────────────────────────────────────────
# CLI Entry Point
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Bug Fixer — 5-Phase Automated Bug Detection & Fix Pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 bug_fixer.py detect           # Phase 1: detect bugs
  python3 bug_fixer.py report           # Show current bug report
  python3 bug_fixer.py check main.py    # Quick syntax check on a file
  python3 bug_fixer.py verify --bug-id BUG-0001  # Verify a specific fix
  python3 bug_fixer.py verify-all       # Verify all fixed bugs
  python3 bug_fixer.py validate --all   # Phase 5: full validation
  python3 bug_fixer.py pipeline         # Run full pipeline
        """
    )

    subparsers = parser.add_subparsers(dest="command")

    # detect
    p_detect = subparsers.add_parser("detect", help="Phase 1: detect bugs")
    p_detect.add_argument("--residual", action="store_true", help="残余扫描模式")

    # report
    subparsers.add_parser("report", help="Show bug report")

    # check
    p_check = subparsers.add_parser("check", help="Quick syntax check on a file")
    p_check.add_argument("file", help="File path to check")

    # verify
    p_verify = subparsers.add_parser("verify", help="Phase 3: verify a specific fix")
    p_verify.add_argument("--bug-id", required=True, help="BUG ID to verify")

    # verify-all
    subparsers.add_parser("verify-all", help="Verify all fixed bugs")

    # validate
    p_val = subparsers.add_parser("validate", help="Phase 5: final validation")
    p_val.add_argument("--all", action="store_true", help="Run all validation checks")

    # pipeline
    subparsers.add_parser("pipeline", help="Run full pipeline (Phase 1→5)")

    args = parser.parse_args()
    project_root = find_project_root()

    if args.command == "detect":
        bugs = detect_bugs(project_root, residual=args.residual)
        save_bug_report(bugs)
        print_report_summary(bugs)

    elif args.command == "report":
        report = load_bug_report()
        print_report_summary(report)

    elif args.command == "check":
        ok, msg = check_file_syntax(args.file)
        print(f"\n  {'✅' if ok else '❌'} {msg}")

    elif args.command == "verify":
        report = load_bug_report()
        result = verify_bug(args.bug_id, report, project_root)
        for b in report:
            if b.get("id") == args.bug_id:
                if result["status"] == "verified":
                    b["status"] = "verified"
                elif result["status"] == "failed":
                    b["status"] = "fix_failed"
                break
        save_bug_report(report)
        status_icon = {"verified": "✅", "failed": "❌", "not_found": "❓", "needs_recheck": "🔄", "unknown": "❓"}
        icon = status_icon.get(result["status"], "❓")
        print(f"\n  {icon} BUG #{args.bug_id} 验证结果: {result['message']}")

    elif args.command == "verify-all":
        report = load_bug_report()
        fixed_bugs = [b for b in report if b.get("status") in ("fixed", "fix_failed")]
        if not fixed_bugs:
            print(color("\n  没有待验证的已修复 BUG。", "yellow"))
            return

        all_ok = True
        for b in fixed_bugs:
            result = verify_bug(b["id"], report, project_root)
            if result["status"] == "verified":
                b["status"] = "verified"
            elif result["status"] == "failed":
                b["status"] = "fix_failed"
                all_ok = False

        save_bug_report(report)
        print(color(f"\n  {'✅ 全部验证通过' if all_ok else '❌ 部分修复失败，请检查'} — 共 {len(fixed_bugs)} 个", "cyan"))

    elif args.command == "validate":
        ptype = detect_project_type(project_root)
        results = validate_project(project_root, ptype)
        overall = results.pop("overall", False)
        for key, val in results.items():
            icon = {"passed": "✅", "failed": "❌", "skipped": "⏭️"}.get(val.get("status", ""), "❓")
            print(f"  {icon} {key}: {val.get('detail','')}")
        overall_icon = "✅" if overall else "❌"
        print(f"\n  {overall_icon} 整体验证 {'通过' if overall else '失败'}")

    elif args.command == "pipeline":
        run_pipeline(project_root)

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
