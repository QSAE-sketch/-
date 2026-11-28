# -*- coding: utf-8 -*-
"""通栏大色块审计：顶栏 / 卡片头 / 选中底色。

用户的原话：
  - 「同一个页面重复的颜色不要太多」
  - 「一眼看到的那三条横横的绿色的那个线」
  - 「不要出现特别特别鲜艳的」

通栏元素（顶栏、实色卡片头）如果用的是高饱和主色，
在大屏上就是一条荧光带。本脚本按「大面积色块」口径检查。
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKINS = os.path.join(ROOT, 'public', 'skins')

VAR_RE = re.compile(r'(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;')


def hx(c):
    c = c.strip().lstrip('#')
    if len(c) == 3:
        c = ''.join(ch * 2 for ch in c)
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def hsl(c):
    r, g, b = [v / 255.0 for v in c]
    mx, mn = max(r, g, b), min(r, g, b)
    l = (mx + mn) / 2
    if mx == mn:
        return 0.0, l * 100
    d = mx - mn
    s = d / (2 - mx - mn) if l > 0.5 else d / (mx + mn)
    return s * 100, l * 100


def blocks(css):
    light, dark = {}, {}
    for m in re.finditer(r':root\s*\{(.*?)\}', css, re.S):
        for k, v in VAR_RE.findall(m.group(1)):
            light.setdefault(k, v)
    for m in re.finditer(r':root\[data-theme="dark"\]\s*\{(.*?)\}', css, re.S):
        for k, v in VAR_RE.findall(m.group(1)):
            dark.setdefault(k, v)
    for m in re.finditer(r'html\[data-skin="[^"]+"\]\s*\{(.*?)\}', css, re.S):
        for k, v in VAR_RE.findall(m.group(1)):
            light.setdefault(k, v)
    for m in re.finditer(r'html\[data-skin="[^"]+"\]\[data-theme="dark"\]\s*\{(.*?)\}', css, re.S):
        for k, v in VAR_RE.findall(m.group(1)):
            dark.setdefault(k, v)
    return light, dark


def solid_card_h(css):
    """返回实色刷法的卡片头列表（数量即页面里重复出现的大色块数）"""
    out = []
    for m in re.finditer(r'\.card-h\s*\{(.*?)\}', css, re.S):
        if re.search(r'background:\s*var\(--accent\)', m.group(1)):
            out.append(m.group(1).strip()[:50])
    return out


def main():
    rows = []
    for sid in sorted(os.listdir(SKINS)):
        p = os.path.join(SKINS, sid, 'skin.css')
        if not os.path.exists(p):
            continue
        css = open(p, encoding='utf-8').read()
        light, dark = blocks(css)
        for label, v in (('浅', light), ('深', dark)):
            tb = v.get('--topbar-bg')
            if not tb:
                continue
            s, l = hsl(hx(tb))
            rows.append((sid, label, tb, s, l))
        ch = solid_card_h(css)
        if ch:
            rows.append((sid, '实色卡头', '#%d 个' % len(ch), 0, 0))

    print('%-16s %-8s %-10s %6s %6s' % ('皮肤', '档', '顶栏底色', 'S', 'L'))
    print('-' * 52)
    flagged = []
    for sid, label, tb, s, l in rows:
        mark = ''
        if tb.startswith('#') and len(tb) == 7:
            if s > 70 or (l > 78 and s > 40):
                mark = '  <-- 荧光'
                flagged.append((sid, label, tb, s, l))
        print('%-16s %-8s %-10s %6.0f %6.0f%s' % (sid, label, tb, s, l, mark))

    print('\n' + '=' * 52)
    print('顶栏荧光的 %d 处：' % len(flagged))
    for sid, label, tb, s, l in flagged:
        print('  %-14s %s  %s  S=%.0f L=%.0f' % (sid, label, tb, s, l))


if __name__ == '__main__':
    main()
