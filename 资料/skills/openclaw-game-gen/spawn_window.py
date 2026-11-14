#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
openclaw-game-gen 的弹窗外壳。
优先用系统 WebView2 (pywebview) 弹出独立原生窗口；
若 pywebview / WebView2 不可用，自动回退用系统默认浏览器打开。
用法:
  python spawn_window.py "<html绝对路径>" [窗口标题]
"""
import sys
import os
import subprocess
import webbrowser
import traceback

# ---- 1. 多路径探测已安装的 pywebview（它在系统 python 里，managed 解释器可能 import 不到）----
def _find_webview_module():
    candidates = []
    # 系统 python site-packages
    try:
        import sysconfig
        sp = sysconfig.get_paths().get("purelib")
        if sp:
            candidates.append(sp)
    except Exception:
        pass
    # 常见 managed / 系统 python 位置
    base_dirs = [
        r"C:/Users/baoka/.workbuddy/binaries/python/versions/3.13.12",
        r"C:/Users/baoka/AppData/Local/Microsoft/WindowsApps",
        r"C:/Users/baoka/.workbuddy/binaries/python/versions/3.14.6",
    ]
    for b in base_dirs:
        for sub in ("Lib/site-packages", "lib/site-packages"):
            p = os.path.join(b, sub)
            if os.path.isdir(p):
                candidates.append(p)
    # 全局 site-packages（pip 默认装的位置）
    try:
        out = subprocess.run(
            [sys.executable, "-c", "import site,glob,os;print(os.path.join(site.getusersitepackages()))"],
            capture_output=True, text=True, timeout=15)
        if out.returncode == 0 and out.stdout.strip():
            candidates.append(out.stdout.strip())
        out2 = subprocess.run(
            [sys.executable, "-c", "import sys;print('\\n'.join(sys.path))"],
            capture_output=True, text=True, timeout=15)
        for line in out2.stdout.splitlines():
            if "site-packages" in line and os.path.isdir(line):
                candidates.append(line)
    except Exception:
        pass
    seen = set()
    for c in candidates:
        c = os.path.abspath(c)
        if c in seen:
            continue
        seen.add(c)
        if os.path.isdir(os.path.join(c, "webview")):
            yield c

def _try_import_webview():
    # 先试直接 import
    try:
        import webview  # noqa
        return webview
    except Exception:
        pass
    for p in _find_webview_module():
        if p not in sys.path:
            sys.path.insert(0, p)
        try:
            import webview  # noqa
            return webview
        except Exception:
            continue
    return None

# ---- 2. 主流程 ----
def main():
    if len(sys.argv) < 2:
        print("用法: spawn_window.py <html路径> [标题]")
        sys.exit(2)
    html_path = os.path.abspath(sys.argv[1])
    title = sys.argv[2] if len(sys.argv) > 2 else "OpenClaw 游戏"
    if not os.path.isfile(html_path):
        print(f"[错误] 找不到游戏文件: {html_path}")
        sys.exit(3)

    webview = _try_import_webview()
    if webview is not None:
        try:
            webview.create_window(title, html_path, width=900, height=680)
            webview.start()
            return
        except Exception as e:
            print(f"[警告] WebView2 弹窗失败，回退浏览器: {e}")
            traceback.print_exc()
    else:
        print("[提示] 未找到 pywebview，回退浏览器打开。")

    # 回退：系统默认浏览器
    try:
        webbrowser.open(f"file:///{html_path.replace(chr(92),'/')}")
        print(f"[已用浏览器打开] {html_path}")
    except Exception as e:
        print(f"[错误] 浏览器也打不开: {e}")
        sys.exit(4)

if __name__ == "__main__":
    main()
