# -*- coding: utf-8 -*-
"""全量皮肤审计：对比度 / 饱和度 / 过亮主色 / 满色块卡片头。

用法：python tools/audit-skins.py
输出：每套皮肤浅色+深色两档的体检表，末尾给出问题清单。
"""
import os
import re
import json
import glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKINS = os.path.join(ROOT, 'public', 'skins')

# ---- 颜色工具 -------------------------------------------------------------
def hx(c):
    c = c.strip().lstrip('#')
    if len(c) == 3:
        c = ''.join(ch * 2 for ch in c)
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def hstr(rgb):
    return '#%02x%02x%02x' % rgb


def rel(c):
    def lin(v):
        v /= 255.0
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = [lin(v) for v in c]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = rel(a), rel(b)
    if la < lb:
        la, lb = lb, la
    return (la + 0.05) / (lb + 0.05)


def sat_lum_of(c):
    r, g, b = [v / 255.0 for v in c]
    mx, mn = max(r, g, b), min(r, g, b)
    l = (mx + mn) / 2
    if mx == mn:
        return 0.0, l
    d = mx - mn
    s = d / (2 - mx - mn) if l > 0.5 else d / (mx + mn)
    return s * 100, l * 100


# ---- 解析 -----------------------------------------------------------------
VAR_RE = re.compile(r'(--[a-z0-9-]+)\s*:\s*([^;]+);')


def read_vars(css):
    """取出 :root 块（浅色）与 :root[data-theme=dark] 块（深色）的变量字典。"""
    light, dark = {}, {}
    for m in re.finditer(r':root\s*\{(.*?)\}', css, re.S):
        for k, v in VAR_RE.findall(m.group(1)):
            light.setdefault(k, v.strip())
    for m in re.finditer(r':root\[data-theme="dark"\]\s*\{(.*?)\}', css, re.S):
        for k, v in VAR_RE.findall(m.group(1)):
            dark.setdefault(k, v.strip())
    # 皮肤作用域覆盖（html[data-skin=xxx]）里的变量同样计入
    for m in re.finditer(r'html\[data-skin="[^"]+"\]\s*\{(.*?)\}', css, re.S):
        for k, v in VAR_RE.findall(m.group(1)):
            light.setdefault(k, v.strip())
    for m in re.finditer(r'html\[data-skin="[^"]+"\]\[data-theme="dark"\]\s*\{(.*?)\}', css, re.S):
        for k, v in VAR_RE.findall(m.group(1)):
            dark.setdefault(k, v.strip())
    return light, dark


def resolve(v, vars):
    v = v.strip()
    if v.startswith('#'):
        return hx(v) if len(v.strip('#')) in (3, 6) else None
    m = re.match(r'var\((--[a-z0-9-]+)\)', v)
    if m:
        raw = vars.get(m.group(1))
        if raw and raw.startswith('#'):
            return hx(raw)
    return None


# ---- 检查项 ---------------------------------------------------------------
# 当文字用的变量：必须 >= 4.5
TEXT_VARS = [
    ('--fg', '--surface-1'),
    ('--fg-2', '--surface-1'),
    ('--link', '--surface-1'),
    ('--badge-fg', '--badge'),
    ('--up-fg', '--surface-1'),
    ('--role-2-fg', '--surface-1'),
    ('--card-h-fg', '--card-h-bg'),
    ('--on-accent', '--accent'),
]
# 弱化层级：>= 3.0 / 2.4
WEAK_VARS = [
    ('--fg-3', '--surface-1', 3.0),
    ('--fg-4', '--surface-1', 2.4),
]


def audit(sid, light, dark):
    issues = []
    for label, vars in (('浅色', light), ('深色', dark)):
        accent = resolve(vars.get('--accent', ''), vars)
        surface1 = resolve(vars.get('--surface-1', ''), vars) or (255, 255, 255)
        if accent is None:
            issues.append((sid, label, '--accent 无法解析'))
            continue
        s, l = sat_lum_of(accent)
        # 过亮主色（暗色档不该刺眼）
        if label == '深色' and (s > 62 or l > 72):
            issues.append((sid, label, '主色过亮/过艳 %s S=%.0f L=%.0f' % (hstr(accent), s, l)))
        if label == '浅色' and (s > 70 or l > 52):
            issues.append((sid, label, '浅色档主色偏亮偏艳 %s S=%.0f L=%.0f' % (hstr(accent), s, l)))
        # 对比度
        for fg_key, bg_key in TEXT_VARS:
            fg = resolve(vars.get(fg_key, ''), vars)
            bg = resolve(vars.get(bg_key, ''), vars)
            if not fg or not bg:
                continue
            c = contrast(fg, bg)
            if c < 4.5 - 0.05:
                issues.append((sid, label, '%s 对比 %.2f < 4.5 (%s on %s)'
                               % (fg_key, c, hstr(fg), hstr(bg))))
        for fg_key, bg_key, need in WEAK_VARS:
            fg = resolve(vars.get(fg_key, ''), vars)
            bg = resolve(vars.get(bg_key, ''), vars)
            if not fg or not bg:
                continue
            c = contrast(fg, bg)
            if c < need - 0.05:
                issues.append((sid, label, '%s 对比 %.2f < %.1f (%s on %s)'
                               % (fg_key, c, need, hstr(fg), hstr(bg))))
    return issues


def has_solid_card_h(css):
    """检测是否存在「实色刷法」的卡片标题栏。"""
    bad = []
    for m in re.finditer(r'\.card-h\s*\{(.*?)\}', css, re.S):
        body = m.group(1)
        if re.search(r'background:\s*var\(--accent\)', body):
            bad.append(body.strip()[:60])
    return bad


def main():
    rows = []
    issues = []
    solid = []
    dirs = sorted([d for d in os.listdir(SKINS)
                   if os.path.isdir(os.path.join(SKINS, d))])
    for sid in dirs:
        css_path = os.path.join(SKINS, sid, 'skin.css')
        if not os.path.exists(css_path):
            continue
        css = open(css_path, encoding='utf-8').read()
        light, dark = read_vars(css)
        la = resolve(light.get('--accent', ''), light)
        da = resolve(dark.get('--accent', ''), dark)
        issues.extend(audit(sid, light, dark))
        b = has_solid_card_h(css)
        if b:
            solid.append((sid, b))
        rows.append((sid, la, da))

    print('共 %d 套皮肤\n' % len(rows))
    print('%-16s %-10s %-10s' % ('皮肤', '浅色主色', '深色主色'))
    print('-' * 40)
    for sid, la, da in rows:
        print('%-16s %-10s %-10s' % (
            sid,
            hstr(la) if la else '-',
            hstr(da) if da else '-'))

    print('\n' + '=' * 50)
    if issues:
        print('发现 %d 处问题：' % len(issues))
        for sid, label, msg in issues:
            print('  [%s/%s] %s' % (sid, label, msg))
    else:
        print('对比度与饱和度：全部达标 ✅')

    if solid:
        print('\n仍有实色卡片头 %d 套：' % len(solid))
        for sid, b in solid:
            print('  %s -> %s' % (sid, b))
    else:
        print('实色卡片头：已全部清除 ✅')


if __name__ == '__main__':
    main()
