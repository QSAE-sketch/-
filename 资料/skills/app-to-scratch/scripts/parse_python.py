# -*- coding: utf-8 -*-
"""parse_python.py - Python GUI 应用(tkinter 为主) -> AppModel 中间表示

启发式解析控件(Button/Label/Entry/Canvas)与回调，输出 AppModel。
无法还原的逻辑收集到 unsupported。
PyQt 仅做基础识别，深度还原有限（多数进 unsupported）。

用法: python parse_python.py <app.py 或 目录> [out.json]
"""
import os
import sys
import re
import json


def parse_python(src_text, title="Python App"):
    variables = {}
    unsupported = []
    elements = []
    events = []
    func_bodies = {}
    for m in re.finditer(r"def\s+(\w+)\s*\([^)]*\)\s*:(.*?)(?=\n[^\s]|\Z)", src_text, re.S):
        func_bodies[m.group(1)] = m.group(2)
    # 变量：IntVar/StringVar 等 与 普通 = 数字
    for m in re.finditer(r"(\w+)\s*=\s*(?:IntVar|StringVar|DoubleVar|BooleanVar)\(\s*\)", src_text):
        variables[m.group(1)] = 0
    for m in re.finditer(r"(?:self\.)?(\w+)\s*=\s*(\d+)", src_text):
        if m.group(1) not in variables:
            variables[m.group(1)] = int(m.group(2))

    def add_widget(kind, text, cid, x, y, w, h, command):
        elements.append({"kind": kind, "id": cid, "text": text,
                          "x": x, "y": y, "w": w, "h": h, "events": []})
        if command and command in func_bodies:
            events.append((cid, analyze_py(func_bodies[command], variables, unsupported)))

    y = 20
    for m in re.finditer(
        r"(\w+)\s*=\s*(?:tk\.)?Button\([^)]*?text\s*=\s*['\"]([^'\"]*)['\"][^)]*\)",
        src_text,
    ):
        cid, txt = m.group(1), m.group(2)
        cm = re.search(r"command\s*=\s*(\w+)", m.group(0))
        add_widget("button", txt, cid, 20, y, 100, 36, cm.group(1) if cm else None)
        y += 60
    for m in re.finditer(
        r"(\w+)\s*=\s*(?:tk\.)?Label\([^)]*?text\s*=\s*['\"]([^'\"]*)['\"]",
        src_text,
    ):
        add_widget("label", m.group(2), m.group(1), 20, y, 140, 28, None)
        y += 40
    for m in re.finditer(r"(\w+)\s*=\s*(?:tk\.)?Entry\(", src_text):
        add_widget("input", "", m.group(1), 20, y, 160, 30, None)
        y += 40
    for m in re.finditer(r"(\w+)\s*=\s*(?:tk\.)?Canvas\(", src_text):
        add_widget("canvas", "", m.group(1), 20, y, 200, 150, None)
        y += 170
        if "create_" in src_text or "draw" in src_text:
            unsupported.append("Canvas绘图")
    # bind 事件
    for m in re.finditer(r"(\w+)\.bind\(\s*['\"]<Button-1>['\"]\s*,\s*(\w+)", src_text):
        if m.group(2) in func_bodies:
            events.append((m.group(1), analyze_py(func_bodies[m.group(2)], variables, unsupported)))

    evmap = {}
    for cid, acts in events:
        evmap.setdefault(cid, []).extend(acts)
    for e in elements:
        if e["id"] in evmap:
            e["events"] = [{"trigger": "click", "actions": evmap[e["id"]]}]

    if "PyQt" in src_text or "QtWidgets" in src_text:
        unsupported.append("PyQt 深度还原有限(已尽量识别控件)")
    return {
        "title": title,
        "page_w": 400,
        "page_h": max(y, 300),
        "variables": [{"name": k, "init": v} for k, v in variables.items()],
        "broadcasts": [],
        "elements": elements,
        "unsupported": unsupported,
    }


def analyze_py(body, variables, unsupported):
    acts = []
    for m in re.finditer(r"(\w+)\s*=\s*(\d+)", body):
        if m.group(1) in variables:
            acts.append({"type": "set_var", "var": m.group(1), "value": float(m.group(2))})
    for m in re.finditer(r"(\w+)\s*\+\=\s*(\d+)", body):
        if m.group(1) in variables:
            acts.append({"type": "change_var", "var": m.group(1), "value": float(m.group(2))})
    for m in re.finditer(r"(\w+)\.set\(\s*['\"]([^'\"]*)['\"]\s*\)", body):
        acts.append({"type": "say", "text": m.group(2)})
    for m in re.finditer(r"(\w+)\.config\(\s*text\s*=\s*['\"]([^'\"]*)['\"]", body):
        acts.append({"type": "say", "text": m.group(2)})
    for m in re.finditer(r"(\w+)\.pack_forget\(\)", body):
        acts.append({"type": "hide", "target": m.group(1)})
    for m in re.finditer(r"(\w+)\.destroy\(\)", body):
        acts.append({"type": "hide", "target": m.group(1)})
    for m in re.finditer(r"(\w+)\.pack\(\)", body):
        acts.append({"type": "show", "target": m.group(1)})
    for label, pat in {
        "网络请求": r"requests\.|urllib|socket\.|http",
        "文件读写": r"\bopen\(|read\(\)|write\(",
        "数据库": r"sqlite|sqlalchemy|pymysql",
    }.items():
        if re.search(pat, body, re.I) and label not in unsupported:
            unsupported.append(label)
    return acts


def main():
    if len(sys.argv) < 2:
        print("usage: parse_python.py <app.py|dir> [out.json]")
        sys.exit(1)
    p = sys.argv[1]
    if os.path.isdir(p):
        pys = [f for f in os.listdir(p) if f.endswith(".py")]
        p = os.path.join(p, pys[0]) if pys else None
    if not p or not os.path.exists(p):
        print("找不到 .py 源文件（exe 二进制请直接用 convert.py 走降级）")
        sys.exit(1)
    with open(p, encoding="utf-8", errors="ignore") as f:
        src = f.read()
    app = parse_python(src, title=os.path.splitext(os.path.basename(p))[0])
    out = sys.argv[2] if len(sys.argv) > 2 else "appmodel.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(app, f, ensure_ascii=False, indent=2)
    print(
        "elements:", len(app["elements"]),
        "variables:", len(app["variables"]),
        "events:", sum(len(e["events"]) for e in app["elements"]),
        "unsupported:", app["unsupported"],
    )


if __name__ == "__main__":
    main()
