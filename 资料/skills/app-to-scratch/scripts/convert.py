# -*- coding: utf-8 -*-
"""convert.py - 统一入口: 桌面应用 -> .sb3

流程: detect(识别形态) -> 对应解析器(-> AppModel) -> build_sb3(-> .sb3) -> verify(校验) -> 报告

用法: python convert.py <应用路径 html/py/exe/目录> [out.sb3]
"""
import os
import sys
import json
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def load(modname):
    spec = importlib.util.spec_from_file_location(modname, os.path.join(HERE, modname + ".py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


detect = load("detect")
parse_html = load("parse_html")
parse_python = load("parse_python")
parse_exe = load("parse_exe")
build = load("build_sb3")
auto_fix = load("auto_fix_sb3")
verify = load("verify_sb3")


def main():
    if len(sys.argv) < 2:
        print("用法: convert.py <应用路径 html/py/exe/目录> [out.sb3]")
        sys.exit(1)
    app_path = sys.argv[1]
    out_sb3 = sys.argv[2] if len(sys.argv) > 2 else "converted.sb3"

    info = detect.detect(app_path)
    t = info["type"]
    print("检测到形态:", t, "|", app_path)
    if t == "html":
        if os.path.isdir(app_path):
            idx = os.path.join(app_path, "index.html")
            if not os.path.exists(idx):
                hs = [f for f in os.listdir(app_path) if f.lower().endswith((".html", ".htm"))]
                idx = os.path.join(app_path, hs[0])
            app_path = idx
        with open(app_path, encoding="utf-8", errors="ignore") as f:
            txt = f.read()
        app = parse_html.build_appmodel(txt, title=os.path.splitext(os.path.basename(app_path))[0])
    elif t == "python":
        if os.path.isdir(app_path):
            pys = [f for f in os.listdir(app_path) if f.endswith(".py")]
            app_path = os.path.join(app_path, pys[0])
        with open(app_path, encoding="utf-8", errors="ignore") as f:
            src = f.read()
        app = parse_python.parse_python(src, title=os.path.splitext(os.path.basename(app_path))[0])
    elif t == "exe":
        app = parse_exe.parse_exe(app_path)
    else:
        print("无法识别的形态:", t, "（仅支持 html/js、python、exe）")
        sys.exit(1)

    am_path = out_sb3[:-4] + ".appmodel.json" if out_sb3.endswith(".sb3") else "appmodel.json"
    with open(am_path, "w", encoding="utf-8") as f:
        json.dump(app, f, ensure_ascii=False, indent=2)
    build.build(app, out_sb3)
    # 联动 bug-fixer: 生成后自动检查并修复通用结构性 bug（看不到积木/广播失灵等）
    changed, fix_report = auto_fix.fix(out_sb3)
    if changed:
        print("自动修复(bug-fixer 联动):")
        for r in fix_report:
            print("  *", r)
    ok, msgs = verify.verify(out_sb3)
    print("生成:", out_sb3, os.path.getsize(out_sb3), "bytes")
    print("校验:", "OK" if ok else "FAIL")
    for m in msgs:
        print("  -", m)
    if not ok:
        print("\n⚠️ 自动修复后仍有问题，请 @skill:bug-fixer 人工介入排查。")
    nel = len(app["elements"])
    nev = sum(len(e["events"]) for e in app["elements"])
    print("\n=== 转换报告 ===")
    print(f"元素(角色): {nel} | 变量: {len(app['variables'])} | 绑定交互: {nev}")
    print(f"无法还原(已标注): {app['unsupported']}")
    print(f"中间产物: {am_path}")
    print(f"提示: 用 Scratch 打开 {out_sb3} 查看效果")


if __name__ == "__main__":
    main()
