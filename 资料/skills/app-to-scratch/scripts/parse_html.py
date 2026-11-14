# -*- coding: utf-8 -*-
"""parse_html.py - HTML/JS 应用 -> AppModel 中间表示

解析 HTML DOM 元素(位置/文本/类型) + 启发式提取 JS 交互，
输出 build_sb3.py 能消费的 AppModel(dict)。
无法还原的 JS 能力收集到 unsupported 列表（生成时做成标注角色）。

用法: python parse_html.py <index.html 或 目录> [out_appmodel.json]
"""
import os
import sys
import re
import json
from html.parser import HTMLParser

VISUAL_TAGS = {
    "button", "input", "img", "canvas", "label", "span", "a", "p",
    "h1", "h2", "h3", "h4", "h5", "h6", "div", "textarea", "select", "li",
}


def parse_style(style):
    d = {}
    for m in re.finditer(r"([\w-]+)\s*:\s*([^;]+)", style or ""):
        d[m.group(1).strip().lower()] = m.group(2).strip()
    return d


def px(v, default):
    if v is None:
        return default
    m = re.search(r"-?\d+(?:\.\d+)?", v)
    return int(float(m.group(1))) if m else default


class El:
    def __init__(self, tag, attrs):
        self.tag = tag
        self.attrs = dict(attrs)
        self.text = ""
        self.id = self.attrs.get("id", "")
        self.style = self.attrs.get("style", "")
        self.onclick = self.attrs.get("onclick", "")
        self.type = self.attrs.get("type", "")

    def is_button(self):
        if self.tag == "button":
            return True
        if self.tag == "input" and self.type in ("button", "submit"):
            return True
        return False

    def is_input(self):
        return self.tag in ("input", "textarea", "select")

    def kind(self):
        if self.is_button():
            return "button"
        if self.is_input():
            return "input"
        if self.tag == "img":
            return "image"
        if self.tag == "canvas":
            return "canvas"
        return "label"


class Collector(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.elements = []
        self.scripts = []
        self._in_script = False
        self._buf = ""

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self._in_script = True
            self._buf = ""
            return
        if tag in VISUAL_TAGS:
            self.stack.append(El(tag, attrs))

    def handle_endtag(self, tag):
        if tag == "script":
            self._in_script = False
            self.scripts.append(self._buf)
            return
        if self.stack and self.stack[-1].tag == tag:
            el = self.stack.pop()
            el.text = el.text.strip()
            if el.tag in ("img", "input", "canvas", "br", "hr"):
                el.text = ""
            if (
                el.text
                or el.is_button()
                or el.is_input()
                or el.tag in ("img", "canvas", "select", "textarea")
            ):
                self.elements.append(el)

    def handle_data(self, data):
        if self._in_script:
            self._buf += data
            return
        if self.stack:
            self.stack[-1].text += data


def analyze_handler(body, alias, variables, elements_by_id, unsupported):
    actions = []
    # 变量自增 x += n
    for m in re.finditer(r"(\w+)\s*\+\=\s*(\d+(?:\.\d+)?)", body):
        if m.group(1) in variables:
            actions.append({"type": "change_var", "var": m.group(1), "value": float(m.group(2))})
    # x = x + n
    for m in re.finditer(r"(\w+)\s*=\s*(\w+)\s*\+\s*(\d+(?:\.\d+)?)", body):
        if m.group(1) in variables:
            actions.append({"type": "change_var", "var": m.group(1), "value": float(m.group(3))})
    # x = 数字/"字符串"
    for m in re.finditer(r"(\w+)\s*=\s*(\d+(?:\.\d+)?|\"[^\"]*\"|'[^']*')", body):
        v = m.group(1)
        if v in variables:
            val = m.group(2)
            if val.startswith('"'):
                val = val[1:-1]
            elif val.startswith("'"):
                val = val[1:-1]
            else:
                val = float(val)
            actions.append({"type": "set_var", "var": v, "value": val})
    # 元素显隐
    for m in re.finditer(r"(\w+)\.style\.display\s*=\s*['\"]([^'\"]+)['\"]", body):
        ref = m.group(1)
        disp = m.group(2).lower()
        eid = alias.get(ref)
        if eid and eid in elements_by_id:
            actions.append({"type": "hide" if disp == "none" else "show", "target": eid})
    # 文本更新
    for m in re.finditer(r"(\w+)\.(?:textContent|innerText)\s*=\s*['\"]([^'\"]*)['\"]", body):
        ref = m.group(1)
        eid = alias.get(ref)
        actions.append({"type": "say", "text": m.group(2), "target": eid})
    # alert
    for m in re.finditer(r"alert\(\s*['\"]([^'\"]*)['\"]\s*\)", body):
        actions.append({"type": "say", "text": m.group(1)})
    # 无法还原的能力 -> unsupported
    pats = {
        "网络请求(fetch/XHR)": r"fetch\(|XMLHttpRequest|axios|websocket",
        "本地存储": r"localStorage|sessionStorage|indexedDB",
        "Canvas绘图": r"getContext\(|canvas\.getContext",
        "定时器/动画循环": r"setInterval|setTimeout|requestAnimationFrame",
        "音频播放": r"new\s+Audio|\.play\(\)|AudioContext",
        "打开新窗口": r"window\.open|postMessage",
    }
    for label, pat in pats.items():
        if re.search(pat, body, re.I) and label not in unsupported:
            unsupported.append(label)
    return actions


def parse_js(scripts, elements_by_id, variables, unsupported):
    js = "\n".join(scripts)
    alias = {}
    # 浏览器中带 id 的元素会自动挂成全局变量，可直接用 id 引用
    for eid in elements_by_id:
        alias.setdefault(eid, eid)
    for m in re.finditer(
        r"(?:var|let|const)\s+(\w+)\s*=\s*(?:document\.)?getElementById\(\s*['\"]([\w-]+)['\"]\s*\)",
        js,
    ):
        alias[m.group(1)] = m.group(2)
    for m in re.finditer(
        r"(\w+)\s*=\s*document\.querySelector\(\s*['\"]#([\w-]+)['\"]\s*\)", js
    ):
        alias[m.group(1)] = m.group(2)
    events = []
    for m in re.finditer(
        r"(?:var|let|const)\s+(\w+)\s*=\s*(\d+(?:\.\d+)?|\"[^\"]*\"|'[^']*')", js
    ):
        name = m.group(1)
        val = m.group(2)
        if val.startswith('"'):
            val = val[1:-1]
        elif val.startswith("'"):
            val = val[1:-1]
        else:
            val = float(val)
        if name not in variables:
            variables[name] = val
    for m in re.finditer(
        r"(\w+)\.onclick\s*=\s*function\s*\([^)]*\)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}", js
    ):
        eid = alias.get(m.group(1))
        if eid and eid in elements_by_id:
            events.append((eid, analyze_handler(m.group(2), alias, variables, elements_by_id, unsupported)))
    for m in re.finditer(
        r"(\w+)\.addEventListener\(\s*['\"]click['\"]\s*,\s*function[^)]*\)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}",
        js,
    ):
        eid = alias.get(m.group(1))
        if eid and eid in elements_by_id:
            events.append((eid, analyze_handler(m.group(2), alias, variables, elements_by_id, unsupported)))
    # 顶层能力扫描（不在任何 handler 内的 fetch/定时器等也要标注）
    top_pats = {
        "网络请求(fetch/XHR)": r"fetch\(|XMLHttpRequest|axios|websocket",
        "本地存储": r"localStorage|sessionStorage|indexedDB",
        "Canvas绘图": r"getContext\(|canvas\.getContext",
        "定时器/动画循环": r"setInterval|setTimeout|requestAnimationFrame",
        "音频播放": r"new\s+Audio|\.play\(\)|AudioContext",
        "打开新窗口": r"window\.open|postMessage",
    }
    for label, pat in top_pats.items():
        if re.search(pat, js, re.I) and label not in unsupported:
            unsupported.append(label)
    return events


def default_w(e):
    return {"button": 100, "input": 160, "img": 80, "canvas": 200}.get(e.kind(), 120)


def default_h(e):
    return {"button": 36, "input": 30, "img": 80, "canvas": 150, "label": 28}.get(e.kind(), 28)


def build_appmodel(html_text, title="Converted App", page_w=800, page_h=600):
    c = Collector()
    c.feed(html_text)
    elements = c.elements
    scripts = c.scripts
    elements_by_id = {e.id: e for e in elements if e.id}
    variables = {}
    unsupported = []

    events = []
    for e in elements:
        if e.onclick:
            actions = analyze_handler(e.onclick, {}, variables, elements_by_id, unsupported)
            if e.id:
                events.append((e.id, actions))
    events += parse_js(scripts, elements_by_id, variables, unsupported)

    y = 20
    model_elements = []
    for e in elements:
        st = parse_style(e.style)
        abs_pos = st.get("position") in ("absolute", "fixed")
        w = px(st.get("width"), default_w(e))
        h = px(st.get("height"), default_h(e))
        if abs_pos and "left" in st and "top" in st:
            x = px(st.get("left"), 20)
            yy = px(st.get("top"), y)
        else:
            if e.tag in ("div", "p", "h1", "h2", "h3", "h4", "h5", "h6",
                         "button", "textarea", "select", "img", "canvas", "li"):
                x = 20
                yy = y + h + 20
            else:
                x = 20
                yy = y
        if e.text and e.kind() == "label":
            w = max(w, len(e.text) * 10 + 20)
        model_elements.append({
            "kind": e.kind(),
            "id": (e.id or f"el{len(model_elements)}"),
            "text": e.text,
            "x": x,
            "y": yy,
            "w": w,
            "h": h,
            "events": [],
        })
        y = max(y, yy) + 10

    evmap = {}
    for eid, acts in events:
        evmap.setdefault(eid, []).extend(acts)
    for me in model_elements:
        if me["id"] in evmap:
            me["events"] = [{"trigger": "click", "actions": evmap[me["id"]]}]

    return {
        "title": title,
        "page_w": page_w,
        "page_h": page_h,
        "variables": [{"name": k, "init": v} for k, v in variables.items()],
        "broadcasts": [],
        "elements": model_elements,
        "unsupported": unsupported,
    }


def main():
    if len(sys.argv) < 2:
        print("usage: parse_html.py <index.html|dir> [out.json]")
        sys.exit(1)
    p = sys.argv[1]
    if os.path.isdir(p):
        idx = os.path.join(p, "index.html")
        if not os.path.exists(idx):
            hs = [f for f in os.listdir(p) if f.lower().endswith((".html", ".htm"))]
            idx = os.path.join(p, hs[0]) if hs else None
        p = idx
    if not p or not os.path.exists(p):
        print("找不到 HTML 文件")
        sys.exit(1)
    with open(p, encoding="utf-8", errors="ignore") as f:
        html_text = f.read()
    title = os.path.splitext(os.path.basename(p))[0]
    app = build_appmodel(html_text, title=title)
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
