# -*- coding: utf-8 -*-
"""verify_sb3.py - 校验生成的 .sb3 是否合法、Scratch 能否打开、且是一个「真正的 Scratch 工程」

校验项:
- 是否为合法 ZIP
- project.json 可解析、targets 非空
- 每个 block 的 next/parent 引用存在（否则积木会被加载器丢弃 → 脚本区空白）
- 输入引用(block-ref)存在；shadow 字面量格式正确
- event_broadcast / event_broadcastandwait「发送」块的广播名在 inputs.BROADCAST_INPUT=[1,[11,名,id]]；
  只有「接收」块 event_whenbroadcastreceived 才用 fields.BROADCAST_OPTION（已用官方导出作品核对）
- 变量/列表/广播引用已在工程内注册（全局池，含舞台全局与 sprite 局部）
- 造型资源文件存在于压缩包内
- 【硬性工程要求】至少 1 个非舞台角色；每个非舞台角色至少有 1 条 topLevel 积木（编码区能显示拼好的积木）
  且有至少 1 个可见造型（创建出来的「角色」确实出现）

用法: python verify_sb3.py <file.sb3>
"""
import os
import sys
import zipfile
import json

KNOWN_OPCODE_PREFIXES = (
    "event_", "control_", "motion_", "looks_", "sound_",
    "sensing_", "operator_", "data_", "procedures_", "argument_", "pen_",
)

# 带下拉菜单的积木： opcode -> {input名: (菜单块 opcode, 菜单块 field 名)}
# 菜单**必须**是一个真实的 shadow 菜单块，input 写成 [1, "菜单块id"]。
# 写成 [1,[12,"名字"]] 是「变量引用原语」，运行时取到 0 → 功能全废（v1 生成器的头号坑）。
MENU_SLOTS = {
    "motion_goto":             {"TO": ("motion_goto_menu", "TO")},
    "motion_glideto":          {"TO": ("motion_glideto_menu", "TO")},
    "motion_pointtowards":     {"TOWARDS": ("motion_pointtowards_menu", "TOWARDS")},
    "control_create_clone_of": {"CLONE_OPTION": ("control_create_clone_of_menu", "CLONE_OPTION")},
    "sensing_touchingobject":  {"TOUCHINGOBJECTMENU": ("sensing_touchingobjectmenu", "TOUCHINGOBJECTMENU")},
    "sensing_keypressed":      {"KEY_OPTION": ("sensing_keyoptions", "KEY_OPTION")},
    "sensing_distanceto":      {"DISTANCETOMENU": ("sensing_distancetomenu", "DISTANCETOMENU")},
    "looks_switchcostumeto":   {"COSTUME": ("looks_costume", "COSTUME")},
    "looks_switchbackdropto":  {"BACKDROP": ("looks_backdrops", "BACKDROP")},
    "sound_play":              {"SOUND_MENU": ("sound_sounds_menu", "SOUND_MENU")},
    "sound_playuntildone":     {"SOUND_MENU": ("sound_sounds_menu", "SOUND_MENU")},
}

# C 型积木（有 body 槽）：body 空 = 脚本看着拼好了但啥也不干
C_BLOCK_SLOTS = {
    "control_forever": "SUBSTACK",
    "control_repeat": "SUBSTACK",
    "control_repeat_until": "SUBSTACK",
    "control_while": "SUBSTACK",
    "control_if": "SUBSTACK",
    "control_if_else": "SUBSTACK",
}


def verify(path):
    if not os.path.exists(path):
        return False, ["文件不存在"]
    if not zipfile.is_zipfile(path):
        return False, ["不是合法 ZIP（.sb3 必须是 ZIP）"]
    errors = []
    warns = []
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "project.json" not in names:
            return False, ["缺少 project.json"]
        try:
            proj = json.loads(z.read("project.json"))
        except Exception as e:
            return False, [f"project.json 解析失败: {e}"]
        assets = set(n for n in names if n != "project.json")
        targets = proj.get("targets", [])
        if not targets:
            errors.append("targets 为空")

        # Stage 字段检查：不能带 sprite 专属字段
        stage = next((t for t in targets if t.get("isStage")), None)
        if stage:
            bad_stage_fields = {"x", "y", "size", "direction", "draggable", "rotationStyle", "visible"}
            found = bad_stage_fields & set(stage.keys())
            if found:
                errors.append(f"Stage 含有 sprite 专属字段（会导致加载失败/异常）: {sorted(found)}")

        # 全局池：变量/列表/广播（含舞台全局 + 各 sprite 局部）
        gv, gl, gb = set(), set(), set()
        for t in targets:
            gv |= set(t.get("variables", {}).keys())
            gl |= set(t.get("lists", {}).keys())
            gb |= set(t.get("broadcasts", {}).keys())

        for t in targets:
            name = t.get("name", "?")
            blocks = t.get("blocks", {})
            ids = set(blocks.keys())
            for bid, b in blocks.items():
                op = b.get("opcode", "")
                if not op.startswith(KNOWN_OPCODE_PREFIXES):
                    errors.append(f"[{name}] 未知 opcode: {op}")
                # ---- 非法的顶层 substack 键（致命：循环/条件体会变空）----
                for badkey in ("substack", "substack2"):
                    if badkey in b:
                        errors.append(
                            f"[{name}] block {bid} {op} 存在非法顶层键 '{badkey}'——"
                            f"C 型积木的 body 必须写进 inputs.SUBSTACK=[2, 积木id]。"
                            f"写成顶层键时 Scratch 加载后循环/条件体是空的，脚本能显示但完全不执行（致命）")

                # inputs 格式与引用
                # 合法形态（真实 sb3 规范）：
                #   [1, [4,"10"]]        shadow 字面量
                #   [1, "menuBlockId"]   shadow 块引用（下拉菜单块都是这种）
                #   [2, "blockId"]       非 shadow 块（SUBSTACK 也用这个）
                #   [3, "blockId", [10,""]]  块遮挡 shadow（长度 3）
                #   [3, [12,"变量名","id"], [10,""]]  变量原语遮挡 shadow
                for iname, val in (b.get("inputs") or {}).items():
                    if not (isinstance(val, list) and len(val) in (2, 3)):
                        errors.append(f"[{name}] block {bid} 的 input {iname} 格式错误（长度须为 2 或 3）: {val!r}")
                        continue
                    if val[0] not in (1, 2, 3):
                        errors.append(f"[{name}] block {bid} input {iname} 类型非法: {val[0]!r}")
                        continue
                    for slot in val[1:]:
                        if isinstance(slot, str):
                            if slot not in ids:
                                errors.append(f"[{name}] block {bid} input {iname} 指向不存在的积木 {slot}")
                        elif isinstance(slot, list):
                            if len(slot) < 2:
                                errors.append(f"[{name}] block {bid} input {iname} 原语格式错误: {slot!r}")
                            elif slot[0] == 4 and not isinstance(slot[1], str):
                                errors.append(f"[{name}] block {bid} input {iname} 数字字面量必须是字符串形式，例如 [4, \"0\"]（当前: {slot!r}）")
                        elif slot is not None:
                            errors.append(f"[{name}] block {bid} input {iname} 槽位类型异常: {slot!r}")
                    if iname in ("SUBSTACK", "SUBSTACK2") and not (val[0] == 2 and isinstance(val[1], str)):
                        errors.append(f"[{name}] block {bid} 的 {iname} 必须是 [2, 积木id]，当前 {val!r}")

                # ---- 下拉菜单必须挂真实 shadow 菜单块 ----
                if op in MENU_SLOTS:
                    for iname, (menu_op, menu_field) in MENU_SLOTS[op].items():
                        val = (b.get("inputs") or {}).get(iname)
                        if val is None:
                            errors.append(f"[{name}] block {bid} {op} 缺少菜单输入 {iname}")
                            continue
                        ref = val[1] if len(val) > 1 else None
                        if isinstance(ref, list):
                            if ref and ref[0] == 12:
                                errors.append(
                                    f"[{name}] block {bid} {op} 的 {iname} 写成了变量引用原语 [12,...]——"
                                    f"这在 sb3 里是「变量」不是「菜单」，运行时取到 0，该积木功能完全失效（致命）。"
                                    f"应挂 shadow 菜单块 {menu_op}（fields.{menu_field}）")
                            else:
                                errors.append(f"[{name}] block {bid} {op} 的 {iname} 应为 shadow 菜单块 {menu_op}，当前是原语 {ref!r}")
                            continue
                        if not isinstance(ref, str) or ref not in ids:
                            errors.append(f"[{name}] block {bid} {op} 的 {iname} 菜单块引用无效: {ref!r}")
                            continue
                        mb = blocks[ref]
                        if mb.get("opcode") != menu_op:
                            errors.append(f"[{name}] block {bid} {op} 的 {iname} 菜单块 opcode 应为 {menu_op}，实际 {mb.get('opcode')!r}")
                        if not mb.get("shadow"):
                            errors.append(f"[{name}] 菜单块 {ref}({menu_op}) 必须 shadow=true")
                        mf = (mb.get("fields") or {}).get(menu_field)
                        if not (isinstance(mf, list) and mf and isinstance(mf[0], str) and mf[0] != ""):
                            errors.append(f"[{name}] 菜单块 {ref} 的 fields.{menu_field} 非法: {mf!r}")

                # ---- control_stop：STOP_OPTION 是 field 且需要 mutation.hasnext ----
                if op == "control_stop":
                    if "STOP_OPTION" in (b.get("inputs") or {}):
                        errors.append(f"[{name}] block {bid} control_stop 的 STOP_OPTION 必须是 field，不能放 inputs")
                    so = (b.get("fields") or {}).get("STOP_OPTION")
                    if not (isinstance(so, list) and so and so[0] in
                            ("all", "this script", "other scripts in sprite")):
                        errors.append(f"[{name}] block {bid} control_stop 的 fields.STOP_OPTION 非法: {so!r}")
                    else:
                        mut = b.get("mutation")
                        want = "true" if so[0] == "other scripts in sprite" else "false"
                        if not (isinstance(mut, dict) and str(mut.get("hasnext")).lower() == want):
                            errors.append(f"[{name}] block {bid} control_stop 缺少/错误的 mutation.hasnext（应为 \"{want}\"）")
                        if want == "false" and b.get("next"):
                            errors.append(f"[{name}] block {bid} control_stop({so[0]}) 是终止块，后面不能再接积木")
                # 广播「发送」块（event_broadcast / event_broadcastandwait）：
                # 正确格式是 inputs.BROADCAST_INPUT = [1, [11, 名, id]]，fields 为空。
                # （已用用户在 Scratch 官方编辑器导出的真实作品核对确认。
                #   只有「接收」块 event_whenbroadcastreceived 才用 fields.BROADCAST_OPTION。）
                if op in ("event_broadcast", "event_broadcastandwait"):
                    binp = (b.get("inputs") or {}).get("BROADCAST_INPUT")
                    ok = (isinstance(binp, list) and len(binp) == 2 and binp[0] == 1
                          and isinstance(binp[1], list) and len(binp[1]) == 3
                          and binp[1][0] == 11)
                    if not ok:
                        errors.append(f"[{name}] block {bid} {op} 的 BROADCAST_INPUT 格式应为 [1, [11, 名, id]]，当前: {binp!r}")
                    elif binp[1][2] not in gb:
                        errors.append(f"[{name}] block {bid} {op} 的广播 id 未注册: {binp[1][2]}")
                    if (b.get("fields") or {}).get("BROADCAST_OPTION") is not None:
                        errors.append(f"[{name}] block {bid} {op} 发送块不应把广播名放进 fields.BROADCAST_OPTION（那是接收块的格式）")
                # 变量/列表字段引用
                for fname, fval in (b.get("fields") or {}).items():
                    if isinstance(fval, list) and len(fval) == 2 and fval[1] is not None:
                        fid = fval[1]
                        if fname == "VARIABLE" and fid not in gv:
                            errors.append(f"[{name}] block {bid} {op} 引用了未注册的变量 {fid}")
                        if fname == "LIST" and fid not in gl:
                            errors.append(f"[{name}] block {bid} {op} 引用了未注册的列表 {fid}")
                # next / parent 闭合
                nxt = b.get("next")
                if nxt not in (None, "") and nxt not in ids:
                    errors.append(f"[{name}] block {bid} 的 next 指向不存在的 {nxt}")
                par = b.get("parent")
                if par not in (None, "") and par not in ids:
                    errors.append(f"[{name}] block {bid} 的 parent 指向不存在的 {par}")
                # C 型积木 body 为空 → 脚本看着拼好了却啥也不干
                if op in C_BLOCK_SLOTS and C_BLOCK_SLOTS[op] not in (b.get("inputs") or {}):
                    warns.append(f"[{name}] block {bid} {op} 的 body 为空（漏写 inputs.SUBSTACK？）")
                # 条件块缺 CONDITION → 条件恒为假
                if op in ("control_if", "control_if_else", "control_repeat_until",
                          "control_while", "control_wait_until") \
                        and "CONDITION" not in (b.get("inputs") or {}):
                    warns.append(f"[{name}] block {bid} {op} 缺少 CONDITION（条件恒为假）")
                # shadow 块不应挂在 next 链上
                if b.get("shadow") and b.get("next"):
                    errors.append(f"[{name}] block {bid} 是 shadow 块，不应有 next")
                # topLevel 必须有 x/y，否则编码区不显示（shadow 块除外）
                if b.get("topLevel") and not b.get("shadow") and (
                        not isinstance(b.get("x"), (int, float)) or not isinstance(b.get("y"), (int, float))):
                    errors.append(f"[{name}] block {bid} 是 topLevel 但缺少 x/y 坐标")

        # 造型资源存在性 + 字段
        for t in targets:
            for c in t.get("costumes", []):
                aid = c.get("assetId")
                if aid and f"{aid}.svg" not in assets and f"{aid}.png" not in assets:
                    errors.append(f"{t.get('name')} 造型 {c.get('name')} 资源缺失: {aid}")
                if "rotationCenterX" not in c or "rotationCenterY" not in c:
                    errors.append(f"{t.get('name')} 造型 {c.get('name')} 缺少 rotationCenterX/Y")
                if "bitmapResolution" not in c:
                    errors.append(f"{t.get('name')} 造型 {c.get('name')} 缺少 bitmapResolution")

        # ===== 硬性工程要求：嵌套块必须有 parent（最核心的「积木能显示」保证）=====
        # parent=null 的非顶层块会被加载器当成孤块、拼不回父块 → 脚本区渲染失败/空白
        for t in targets:
            name = t.get("name", "?")
            for bid, b in t.get("blocks", {}).items():
                if not b.get("topLevel") and b.get("parent") in (None, ""):
                    errors.append(f"角色「{name}」积木 {bid} 是非顶层块但 parent 为 null——加载器无法拼回父块，积木会显示不出来（致命）")

        # ===== 硬性工程要求：必须是「真正的 Scratch 工程」 =====
        sprites = [t for t in targets if not t.get("isStage")]
        if len(sprites) == 0:
            errors.append("工程里没有任何「角色(sprite)」——转换必须把应用组件变成真实角色")
        for t in sprites:
            name = t.get("name", "?")
            blocks = t.get("blocks", {})
            tops = [b for b in blocks.values() if b.get("topLevel")]
            if len(tops) == 0:
                errors.append(f"角色「{name}」没有任何 topLevel 积木——编码区打开是空白，等于没拼积木")
            if len(t.get("costumes", [])) == 0:
                errors.append(f"角色「{name}」没有任何造型——创建的角色不会在舞台上出现")

    ok = len(errors) == 0
    report = [f"角色数: {len(sprites)}", f"错误: {len(errors)}", f"警告: {len(warns)}"]
    return ok, report + errors + warns


if __name__ == "__main__":
    ok, msgs = verify(sys.argv[1] if len(sys.argv) > 1 else "")
    print("OK" if ok else "FAIL")
    for m in msgs:
        print(" -", m)
    sys.exit(0 if ok else 1)
