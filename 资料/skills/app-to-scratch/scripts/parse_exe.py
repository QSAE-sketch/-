# -*- coding: utf-8 -*-
"""parse_exe.py - Windows .exe 降级解析

二进制无法深入解析。提取可读字符串作为线索，猜测 GUI 框架，
生成极简 AppModel + 明确标注（提示用户提供源码以获得高保真转换）。

用法: python parse_exe.py <app.exe> [out.json]
"""
import os
import sys
import re
import json


def extract_strings(data, minlen=5):
    out = []
    for m in re.finditer(rb"[\x20-\x7e]{%d,}" % minlen, data):
        out.append(m.group(0).decode("latin-1", "ignore"))
    try:
        u16 = data.decode("utf-16-le", "ignore")
        for m in re.finditer(r"[\u4e00-\u9fff][\u4e00-\u9fff\w\s]{2,}", u16):
            out.append(m.group(0))
    except Exception:
        pass
    return out


def parse_exe(path):
    with open(path, "rb") as f:
        data = f.read()
    strs = extract_strings(data)
    hints = []
    for kw, label in [
        ("tkinter", "检测到 Tkinter GUI"),
        ("PyQt", "检测到 PyQt GUI"),
        ("webview", "检测到 WebView/HTML 应用(可能由 html-to-windows-exe 打包)"),
        ("electron", "检测到 Electron"),
        (".net", "可能是 .NET 程序"),
        ("java", "可能是 Java 程序"),
    ]:
        if kw.lower() in data.decode("latin-1", "ignore").lower():
            hints.append(label)
    title = os.path.splitext(os.path.basename(path))[0]
    unsupported = [
        "二进制可执行文件，未提供源码，无法深入还原",
        "请拖入源码目录(HTML/JS 或 Python)以获得高保真转换",
    ] + hints
    return {
        "title": title,
        "page_w": 400,
        "page_h": 300,
        "variables": [],
        "broadcasts": [],
        "elements": [
            {"kind": "label", "id": "info", "text": f"二进制程序: {title}",
             "x": 20, "y": 20, "w": 320, "h": 28, "events": []}
        ],
        "unsupported": unsupported,
        "_strings": strs[:30],
    }


def main():
    if len(sys.argv) < 2:
        print("usage: parse_exe.py <app.exe> [out.json]")
        sys.exit(1)
    app = parse_exe(sys.argv[1])
    out = sys.argv[2] if len(sys.argv) > 2 else "appmodel.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(app, f, ensure_ascii=False, indent=2)
    print("exe 字符串样本:", app.get("_strings", [])[:8])
    print("unsupported:", app["unsupported"])


if __name__ == "__main__":
    main()
