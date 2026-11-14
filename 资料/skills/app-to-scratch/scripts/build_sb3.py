# -*- coding: utf-8 -*-
"""build_sb3.py - AppModel(中间表示) -> 合法 .sb3

AppModel 结构（dict）：
{
  "title": "应用名",
  "page_w": 800, "page_h": 600,   # 页面逻辑尺寸，用于坐标映射(舞台480x360)
  "variables": [{"name":"count","init":0}, ...],
  "broadcasts": ["消息1", ...],    # 用到的广播名(可选，parse 阶段也会自动收集)
  "elements": [
     {"kind":"button|label|input|image|canvas|container",
      "id":"btn1", "text":"确定",
      "x":100,"y":80,"w":120,"h":40,
      "events":[{"trigger":"click",
                 "actions":[{"type":"set_var","var":"count","value":1},
                            {"type":"say","text":"已点击"},
                            {"type":"broadcast","name":"消息1"},
                            {"type":"show"} ]}]},
     ...
  ],
  "unsupported": ["网络请求","文件读写",...]  # 无法还原的功能 -> 生成标注角色
}

用法: python build_sb3.py appmodel.json out.sb3
"""
import json
import os
import sys
import io
import zipfile
import hashlib
import random
import html as htmlmod
from datetime import datetime, timezone


def esc(s):
    return htmlmod.escape(str(s), quote=True)


def aid():
    return hashlib.md5(str(random.random()).encode()).hexdigest()[:32]


_ctr = [0]


def bid():
    _ctr[0] += 1
    return f"b{_ctr[0]}"


def lit_num(n):
    return [1, [4, str(n)]]


def lit_str(s):
    return [1, [10, str(s)]]


def lit_value(v):
    if isinstance(v, (int, float)):
        return lit_num(v)
    return lit_str(v)


def wrap_svg(w, h, inner):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}"><g>{inner}</g></svg>'
    )


def svg_for_element(el):
    kind = el.get("kind", "label")
    w = max(2, int(el.get("w", 60)))
    h = max(2, int(el.get("h", 30)))
    text = el.get("text", "")
    cx, cy = w / 2, h / 2
    if kind == "button":
        body = (
            f'<rect x="1" y="1" width="{w-2}" height="{h-2}" rx="8" ry="8" '
            f'fill="#4c97ff" stroke="#1a6fd6" stroke-width="2"/>'
        )
        if text:
            body += (
                f'<text x="{cx}" y="{cy+5}" font-family="sans-serif" '
                f'font-size="{min(18, h/2)}" fill="#fff" text-anchor="middle" '
                f'font-weight="bold">{esc(text)}</text>'
            )
        return wrap_svg(w, h, body)
    if kind == "input":
        body = (
            f'<rect x="1" y="1" width="{w-2}" height="{h-2}" rx="4" ry="4" '
            f'fill="#fff" stroke="#999" stroke-width="2"/>'
        )
        if text:
            body += (
                f'<text x="8" y="{cy+5}" font-family="sans-serif" '
                f'font-size="{min(16, h/2)}" fill="#333" text-anchor="start">{esc(text)}</text>'
            )
        return wrap_svg(w, h, body)
    if kind == "image":
        body = (
            f'<rect x="1" y="1" width="{w-2}" height="{h-2}" rx="4" ry="4" '
            f'fill="#ddd" stroke="#999" stroke-width="2"/>'
            f'<text x="{cx}" y="{cy+5}" font-family="sans-serif" font-size="14" '
            f'fill="#666" text-anchor="middle">IMG</text>'
        )
        return wrap_svg(w, h, body)
    if kind == "canvas":
        body = (
            f'<rect x="1" y="1" width="{w-2}" height="{h-2}" rx="4" ry="4" '
            f'fill="#222" stroke="#000" stroke-width="2"/>'
        )
        return wrap_svg(w, h, body)
    body = ""
    if text:
        body = (
            f'<text x="{cx}" y="{cy+6}" font-family="sans-serif" '
            f'font-size="{min(22, h)}" fill="#222" text-anchor="middle">{esc(text)}</text>'
        )
    return wrap_svg(w, h, body)


def backdrop_svg(title):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="480" height="360" '
        'viewBox="0 0 480 360">'
        '<rect width="480" height="360" fill="#ffffff"/>'
        f'<text x="240" y="40" font-family="sans-serif" font-size="22" fill="#333" '
        f'text-anchor="middle" font-weight="bold">{esc(title)}</text></svg>'
    )


def action_to_block(act, var_ids, bcast_ids):
    t = act.get("type")
    if t == "set_var":
        vid = var_ids.get(act.get("var", ""))
        if not vid:
            return None
        return {
            "opcode": "data_setvariableto",
            "inputs": {"VALUE": lit_value(act.get("value", 0))},
            "fields": {"VARIABLE": [act["var"], vid]},
            "shadow": False,
        }
    if t == "change_var":
        vid = var_ids.get(act.get("var", ""))
        if not vid:
            return None
        return {
            "opcode": "data_changevariableby",
            "inputs": {"VALUE": lit_num(act.get("value", 1))},
            "fields": {"VARIABLE": [act["var"], vid]},
            "shadow": False,
        }
    if t == "say":
        return {
            "opcode": "looks_say",
            "inputs": {"MESSAGE": lit_str(act.get("text", ""))},
            "fields": {},
            "shadow": False,
        }
    if t == "broadcast":
        bn = act.get("name", "消息1")
        bid_ = bcast_ids.get(bn)
        if not bid_:
            return None
        # 发送块正确格式：广播名放 inputs.BROADCAST_INPUT=[1,[11,名,id]]，fields 留空。
        # （接收块 event_whenbroadcastreceived 才用 fields.BROADCAST_OPTION。已用官方作品核对。）
        return {
            "opcode": "event_broadcast",
            "inputs": {"BROADCAST_INPUT": [1, [11, bn, bid_]]},
            "fields": {},
            "shadow": False,
        }
    if t == "show":
        return {"opcode": "looks_show", "inputs": {}, "fields": {}, "shadow": False}
    if t == "hide":
        return {"opcode": "looks_hide", "inputs": {}, "fields": {}, "shadow": False}
    return None


def build(app, out_path):
    _ctr[0] = 0
    svg_conts = {}
    stage_cid = aid()
    stage = {
        "isStage": True,
        "name": "Stage",
        "variables": {},
        "lists": {},
        "broadcasts": {},
        "blocks": {},
        "comments": {},
        "currentCostume": 0,
        "costumes": [
            {
                "name": "backdrop1",
                "assetId": stage_cid,
                "md5ext": stage_cid + ".svg",
                "dataFormat": "svg",
                "rotationCenterX": 240,
            "rotationCenterY": 180,
            "bitmapResolution": 1,
        }
        ],
        "sounds": [],
        "layerOrder": 0,
        "tempo": 60,
        "volume": 100,
        "videoState": "on",
        "videoTransparency": 50,
        "textToSpeechLanguage": None,
    }
    svg_conts[stage_cid] = backdrop_svg(app.get("title", "Converted App"))

    var_ids = {}
    for v in app.get("variables", []):
        vid = aid()
        var_ids[v["name"]] = vid
        stage["variables"][vid] = [v["name"], v.get("init", 0)]

    bcast_ids = {}
    for b in app.get("broadcasts", []):
        b2 = aid()
        bcast_ids[b] = b2
        stage["broadcasts"][b2] = b
    # 预扫 broadcast（来自元素事件）
    for el in app.get("elements", []):
        for ev in el.get("events", []):
            for act in ev.get("actions", []):
                if act.get("type") == "broadcast":
                    bn = act.get("name", "消息1")
                    if bn not in bcast_ids:
                        b2 = aid()
                        bcast_ids[bn] = b2
                        stage["broadcasts"][b2] = bn

    page_w = app.get("page_w", 800)
    page_h = app.get("page_h", 600)

    def map_pos(x, y, w, h):
        cx = x + w / 2
        cy = y + h / 2
        return max(-240, min(240, int(cx - page_w / 2))), max(
            -180, min(180, int(page_h / 2 - cy))
        )

    sprites = []
    for el in app.get("elements", []):
        w = int(el.get("w", 60))
        h = int(el.get("h", 30))
        sx, sy = map_pos(el.get("x", 0), el.get("y", 0), w, h)
        cid = aid()
        sprite = {
            "isStage": False,
            "name": el.get("id", f"el{len(sprites)}"),
            "variables": {},
            "lists": {},
            "broadcasts": {},
            "blocks": {},
            "comments": {},
            "currentCostume": 0,
            "costumes": [
                {
                    "name": "c1",
                    "assetId": cid,
                    "md5ext": cid + ".svg",
                    "dataFormat": "svg",
                    "rotationCenterX": w / 2,
                    "rotationCenterY": h / 2,
                    "bitmapResolution": 1,
                }
            ],
            "sounds": [],
            "x": sx,
            "y": sy,
            "size": 100,
            "direction": 90,
            "draggable": True,
            "rotationStyle": "all around",
            "visible": True,
            "layerOrder": len(sprites) + 1,
        }
        svg_conts[cid] = svg_for_element(el)
        blocks = sprite["blocks"]
        kind = el.get("kind")
        if kind in ("label", "button"):
            hid = bid()
            blocks[hid] = {
                "opcode": "event_whenflagclicked",
                "next": None,
                "parent": None,
                "inputs": {},
                "fields": {},
                "shadow": False,
                "topLevel": True,
                "x": int(el.get("x", 0)),
                "y": int(el.get("y", 0)),
            }
            if kind == "label" and el.get("text"):
                n = bid()
                blocks[hid]["next"] = n
                blocks[n] = {
                    "opcode": "looks_say",
                    "next": None,
                    "parent": hid,
                    "inputs": {"MESSAGE": lit_str(el["text"])},
                    "fields": {},
                    "shadow": False,
                    "topLevel": False,
                }
        for ev in el.get("events", []):
            if ev.get("trigger") == "click":
                hid = bid()
                blocks[hid] = {
                    "opcode": "event_whenthisspriteclicked",
                    "next": None,
                    "parent": None,
                    "inputs": {},
                    "fields": {},
                    "shadow": False,
                    "topLevel": True,
                    "x": int(el.get("x", 50)),
                    "y": int(el.get("y", 50)) + 200,
                }
                cur = hid
                for act in ev.get("actions", []):
                    blk = action_to_block(act, var_ids, bcast_ids)
                    if blk is None:
                        continue
                    n = bid()
                    blk["parent"] = cur
                    blk["topLevel"] = False
                    blocks[cur]["next"] = n
                    blocks[n] = blk
                    cur = n
        sprites.append(sprite)

    unsupported = app.get("unsupported", [])
    if unsupported:
        cid = aid()
        sprite = {
            "isStage": False,
            "name": "⚠️未支持功能",
            "variables": {},
            "lists": {},
            "broadcasts": {},
            "blocks": {},
            "comments": {},
            "currentCostume": 0,
            "costumes": [
                {
                    "name": "c1",
                    "assetId": cid,
                    "md5ext": cid + ".svg",
                    "dataFormat": "svg",
                    "rotationCenterX": 120,
                    "rotationCenterY": 40,
                }
            ],
            "sounds": [],
            "x": 0,
            "y": 150,
            "size": 100,
            "direction": 90,
            "draggable": True,
            "rotationStyle": "all around",
            "visible": True,
            "layerOrder": len(sprites) + 1,
        }
        svg_conts[cid] = wrap_svg(
            240,
            80,
            '<rect width="240" height="80" fill="#fff3cd" stroke="#ffc107" stroke-width="3"/>'
            '<text x="120" y="26" font-family="sans-serif" font-size="14" fill="#856404" '
            'text-anchor="middle" font-weight="bold">⚠️ 以下功能无法还原</text>'
            f'<text x="120" y="52" font-family="sans-serif" font-size="11" fill="#856404" '
            f'text-anchor="middle">{esc("；".join(unsupported[:6]))}</text>',
        )
        hid = bid()
        sprite["blocks"][hid] = {
            "opcode": "event_whenflagclicked",
            "next": None,
            "parent": None,
            "inputs": {},
            "fields": {},
            "shadow": False,
            "topLevel": True,
            "x": 20,
            "y": 20,
        }
        sprites.append(sprite)

    # 舞台初始化：设置变量初值
    if stage["variables"]:
        hid = bid()
        stage["blocks"][hid] = {
            "opcode": "event_whenflagclicked",
            "next": None,
            "parent": None,
            "inputs": {},
            "fields": {},
            "shadow": False,
            "topLevel": True,
            "x": 20,
            "y": 20,
        }
        cur = hid
        for vn, vid in var_ids.items():
            n = bid()
            stage["blocks"][cur]["next"] = n
            stage["blocks"][n] = {
                "opcode": "data_setvariableto",
                "next": None,
                "parent": cur,
                "inputs": {"VALUE": lit_value(stage["variables"][vid][1])},
                "fields": {"VARIABLE": [vn, vid]},
                "shadow": False,
                "topLevel": False,
            }
            cur = n

    # 回填所有目标中嵌套块的 parent/topLevel（Scratch 加载器硬要求）
    def fix_target_parents(blocks):
        ids = set(blocks.keys())

        def walk(bid, parent):
            b = blocks.get(bid)
            if not b:
                return
            b["parent"] = parent
            b["topLevel"] = (parent is None)
            for iname, val in (b.get("inputs") or {}).items():
                if isinstance(val, list) and len(val) == 2 and val[0] in (2, 3):
                    child = val[1]
                    if isinstance(child, str) and child in ids:
                        walk(child, bid)
            if b.get("next"):
                walk(b["next"], bid)

        for bid, b in blocks.items():
            if b.get("topLevel"):
                walk(bid, None)

    for sp in [stage] + sprites:
        fix_target_parents(sp["blocks"])

    project = {
        "targets": [stage] + sprites,
        "monitors": [],
        "extensions": [],
        "meta": {
            "agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Scratch/3.32.0 Chrome/148.0.7778.97 Electron/42.0.1 Safari/537.36",
            "semver": "3.0.0",
            "vm": "13.7.4-svg",
            "origin": "https://scratch.mit.edu",
            "savedOn": datetime.now(timezone.utc).isoformat(),
            "mode": "editor",
        },
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("project.json", json.dumps(project, ensure_ascii=False))
        for a, svg in svg_conts.items():
            z.writestr(f"{a}.svg", svg)
    with open(out_path, "wb") as f:
        f.write(buf.getvalue())
    return out_path


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: build_sb3.py appmodel.json out.sb3")
        sys.exit(1)
    with open(sys.argv[1], encoding="utf-8") as f:
        app = json.load(f)
    out = build(app, sys.argv[2])
    print("written", out, os.path.getsize(out), "bytes")
