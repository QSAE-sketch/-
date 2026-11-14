# -*- coding: utf-8 -*-
"""auto_fix_sb3.py - 离线自动修复 .sb3 通用结构性 bug（bug-fixer 的内化自动引擎）

这是 app-to-scratch 联动 @skill:bug-fixer 的核心：转换生成 .sb3 之后自动跑一遍，
把常见的「打开后看不到积木 / 状态机失灵」类 bug 直接修掉，再把干净的工程交给 verify 卡关。

调用方式 1（单独跑）:
    python auto_fix_sb3.py <file.sb3>

调用方式 2（被 convert.py 导入）:
    import auto_fix_sb3
    changed, report_lines = auto_fix_sb3.fix(path)

返回: (changed: bool, report: list[str])
    changed=True 表示确实改了文件；report 给出每一项修复说明。

修复项（均为 bug-fixer 全量扫描已证实的「打开即崩 / 看不到积木 / 广播失灵」根因）:
1. 共享积木非法结构: 同一积木被多个 input/next 槽引用（入度>1）→ 深克隆去重，保证每块只有 1 个 parent
2. parent 回填: 所有非顶层块的 parent 指向「包着它的那个块」（parent=null 是「积木显示不出来」头号根因）
3. 广播发送块格式: event_broadcast / event_broadcastandwait 必须用 inputs.BROADCAST_INPUT=[1,[11,名,id]]，
   不能用 fields.BROADCAST_OPTION（用错则广播可能根本发不出去，状态机失灵）
4. 广播注册: 发送块引用的广播名若不在工程 broadcasts 池，自动注册进去（否则「有发送无接收」）
5. 数字字面量: operator 数字 [4, 0] -> [4, "0"]（某些加载器拒绝非字符串）
6. Stage 剥离 sprite 专属字段: x/y/size/direction/draggable/rotationStyle/visible 会导致加载异常
7. 造型补 rotationCenterX/Y + bitmapResolution（缺则加载器无法定位/渲染失败）
"""
import os
import sys
import json
import copy
import zipfile
import uuid


def _nid():
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# 1+2. 共享积木去重 + parent 回填
# ---------------------------------------------------------------------------
def fix_block_parents(blocks):
    """回填所有非顶层块的 parent，沿 next 链 + 递归 inputs 遍历。"""
    def visit(bid, parent):
        b = blocks.get(bid)
        if not isinstance(b, dict):
            return
        b["parent"] = parent
        for iname, val in (b.get("inputs") or {}).items():
            if isinstance(val, list) and len(val) == 2 and val[0] in (2, 3) and isinstance(val[1], str):
                visit(val[1], bid)
        nxt = b.get("next")
        if isinstance(nxt, str):
            visit(nxt, bid)
    for bid, b in list(blocks.items()):
        if isinstance(b, dict) and b.get("topLevel"):
            visit(bid, None)


def dedup_shared(blocks):
    """去除「同一积木被多个 input/next 槽共享引用」的非法结构（入度>1）。

    Scratch 规定每个积木只能有 1 个父块；被多槽共享引用会导致 parent 不匹配、
    某些卡槽渲染为空。深克隆让每个槽拿到独立子树。
    """
    def deep_clone(bid):
        src = blocks[bid]
        nid = _nid()
        nb = copy.deepcopy(src)
        blocks[nid] = nb
        for iname, val in list((nb.get("inputs") or {}).items()):
            if isinstance(val, list) and len(val) == 2 and val[0] in (2, 3) \
               and isinstance(val[1], str) and val[1] in blocks:
                nb["inputs"][iname] = [val[0], deep_clone(val[1])]
        if nb.get("next") and nb["next"] in blocks:
            nb["next"] = deep_clone(nb["next"])
        return nid

    seen = set()

    def mark(bid):
        if bid not in blocks or bid in seen:
            return
        seen.add(bid)
        b = blocks[bid]
        for iname, val in (b.get("inputs") or {}).items():
            if isinstance(val, list) and len(val) == 2 and val[0] in (2, 3) and isinstance(val[1], str):
                mark(val[1])
        if b.get("next"):
            mark(b["next"])

    def visit(bid):
        if bid not in blocks:
            return bid
        if bid in seen:
            nid = deep_clone(bid)
            mark(nid)
            return nid
        seen.add(bid)
        b = blocks[bid]
        for iname, val in list((b.get("inputs") or {}).items()):
            if isinstance(val, list) and len(val) == 2 and val[0] in (2, 3) and isinstance(val[1], str):
                b["inputs"][iname] = [val[0], visit(val[1])]
        if b.get("next"):
            b["next"] = visit(b["next"])
        return bid

    for tb in [bid for bid, b in list(blocks.items())
               if isinstance(b, dict) and b.get("topLevel")]:
        visit(tb)


# ---------------------------------------------------------------------------
# 3. 广播发送块格式修正
# ---------------------------------------------------------------------------
def fix_broadcast_format(blocks, report):
    for bid, b in blocks.items():
        if not isinstance(b, dict):
            continue
        if b.get("opcode") in ("event_broadcast", "event_broadcastandwait"):
            fopt = (b.get("fields") or {}).get("BROADCAST_OPTION")
            if fopt and (b.get("inputs") or {}).get("BROADCAST_INPUT") is None:
                name = fopt[0] if isinstance(fopt, list) else fopt
                bid_ = fopt[1] if isinstance(fopt, list) and len(fopt) > 1 else _nid()
                b.setdefault("inputs", {})["BROADCAST_INPUT"] = [1, [11, name, bid_]]
                b.get("fields", {}).pop("BROADCAST_OPTION", None)
                report.append(f"广播发送块 {bid[:8]} 格式修正为 inputs.BROADCAST_INPUT（{name}）")


# ---------------------------------------------------------------------------
# 4. 广播注册
# ---------------------------------------------------------------------------
def register_broadcasts(targets, report):
    stage = next((t for t in targets if t.get("isStage")), None)
    if not stage:
        return
    pool = stage.setdefault("broadcasts", {})
    for t in targets:
        for b in (t.get("blocks") or {}).values():
            if isinstance(b, dict) and b.get("opcode") in ("event_broadcast", "event_broadcastandwait"):
                inp = (b.get("inputs") or {}).get("BROADCAST_INPUT")
                if isinstance(inp, list) and len(inp) == 2 and isinstance(inp[1], list) and len(inp[1]) == 3:
                    name, bid_ = inp[1][1], inp[1][2]
                    if bid_ not in pool:
                        pool[bid_] = name
                        report.append(f"广播注册进工程池: {name}")


# ---------------------------------------------------------------------------
# 5. 数字字面量字符串化
# ---------------------------------------------------------------------------
def fix_number_literals(blocks, report):
    for bid, b in blocks.items():
        if not isinstance(b, dict):
            continue
        for iname, val in (b.get("inputs") or {}).items():
            if isinstance(val, list) and len(val) == 2 and val[0] == 1:
                inner = val[1]
                if isinstance(inner, list) and len(inner) == 2 and inner[0] == 4 and not isinstance(inner[1], str):
                    inner[1] = str(inner[1])
                    report.append(f"数字字面量非字符串修正: block {bid[:8]} input {iname}")


# ---------------------------------------------------------------------------
# 6. Stage 剥离 sprite 专属字段
# ---------------------------------------------------------------------------
def fix_stage_fields(stage, report):
    bad = {"x", "y", "size", "direction", "draggable", "rotationStyle", "visible"}
    for f in list(stage.keys()):
        if f in bad:
            stage.pop(f)
            report.append(f"Stage 剥离 sprite 专属字段: {f}")


# ---------------------------------------------------------------------------
# 7. 造型补字段
# ---------------------------------------------------------------------------
def fix_costumes(t, report):
    for c in t.get("costumes", []):
        w = c.get("width")
        h = c.get("height")
        if "rotationCenterX" not in c:
            c["rotationCenterX"] = w // 2 if isinstance(w, int) else 240
            report.append(f"造型 {c.get('name')} 补 rotationCenterX")
        if "rotationCenterY" not in c:
            c["rotationCenterY"] = h // 2 if isinstance(h, int) else 180
            report.append(f"造型 {c.get('name')} 补 rotationCenterY")
        if "bitmapResolution" not in c:
            c["bitmapResolution"] = 1
            report.append(f"造型 {c.get('name')} 补 bitmapResolution")


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
def fix(path):
    """对 .sb3 做离线自动修复。返回 (changed, report_lines)。"""
    if not os.path.exists(path):
        return False, [f"文件不存在: {path}"]
    if not zipfile.is_zipfile(path):
        return False, ["不是合法 ZIP（.sb3 必须是 ZIP）"]

    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "project.json" not in names:
            return False, ["缺少 project.json"]
        data = {n: z.read(n) for n in names}

    proj = json.loads(data["project.json"])
    report = []
    targets = proj.get("targets", [])

    for t in targets:
        blocks = t.get("blocks", {})
        if not blocks:
            continue
        if t.get("isStage"):
            fix_stage_fields(t, report)
        fix_costumes(t, report)
        # 顺序: 先去重共享积木，再回填 parent（覆盖克隆出的新块），最后修广播/数字
        dedup_shared(blocks)
        fix_block_parents(blocks)
        fix_broadcast_format(blocks, report)
        fix_number_literals(blocks, report)

    register_broadcasts(targets, report)

    changed = len(report) > 0
    if changed:
        data["project.json"] = json.dumps(proj, ensure_ascii=False).encode("utf-8")
        tmp = path + ".tmp"
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for n, d in data.items():
                z.writestr(n, d)
        os.replace(tmp, path)
    return changed, report


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: auto_fix_sb3.py <file.sb3>")
        sys.exit(1)
    changed, rep = fix(sys.argv[1])
    print("自动修复(bug-fixer 联动):", "已修复" if changed else "无需修复（已是干净工程）")
    for r in rep:
        print("  *", r)
