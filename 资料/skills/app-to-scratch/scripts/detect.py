# -*- coding: utf-8 -*-
"""detect.py - 形态识别
判断拖入路径是 html/js 应用 / python GUI / exe / 未知。
只做识别，不做深度解析。返回 dict: {"type":..., "path":..., ...}

用法: python detect.py <path>
"""
import os
import sys


def detect(path):
    if not os.path.exists(path):
        return {"type": "missing", "path": path}
    if os.path.isfile(path):
        ext = path.rsplit(".", 1)[-1].lower() if "." in os.path.basename(path) else ""
        if ext == "exe":
            return {"type": "exe", "path": path}
        if ext in ("html", "htm"):
            return {"type": "html", "path": path}
        if ext == "py":
            return {"type": "python", "path": path}
        return {"type": "file", "path": path, "ext": ext}
    # 目录
    files = []
    for _, _, fs in os.walk(path):
        files.extend(f.lower() for f in fs)
    has_html = any(f.endswith((".html", ".htm")) for f in files)
    has_js = any(f.endswith(".js") for f in files)
    has_py = any(f.endswith(".py") for f in files)
    has_exe = any(f.endswith(".exe") for f in files)
    if has_html or has_js:
        return {"type": "html", "path": path, "has_js": has_js}
    if has_py:
        return {"type": "python", "path": path}
    if has_exe:
        return {"type": "exe", "path": path}
    return {"type": "unknown_dir", "path": path}


if __name__ == "__main__":
    print(detect(sys.argv[1] if len(sys.argv) > 1 else "."))
