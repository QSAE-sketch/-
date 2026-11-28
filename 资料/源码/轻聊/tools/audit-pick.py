# -*- coding: utf-8 -*-
"""检查多选模式 ✓ 勾号的可见性。

CSS 规则（public/style.css）：
  .msg .pick { color: var(--on-accent); background: var(--pick-bg); }
  .msg.picked .pick { background: var(--pick-on); border-color: var(--pick-on); }
  .msg.picked .pick::after { content: '✓'; }

即：勾号颜色 = --on-accent，落在 --pick-on 底色上。
对比度不足 3.0 视为「勾号看不清」。
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


def blocks(css):
    """返回 (浅色变量, 深色变量)"""
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


def main():
    bad = []
    total = 0
    for sid in sorted(os.listdir(SKINS)):
        p = os.path.join(SKINS, sid, 'skin.css')
        if not os.path.exists(p):
            continue
        css = open(p, encoding='utf-8').read()
        light, dark = blocks(css)
        for label, v in (('浅色', light), ('深色', dark)):
            fg = v.get('--on-accent')
            bg = v.get('--pick-on')
            if not fg or not bg:
                continue
            total += 1
            c = contrast(hx(fg), hx(bg))
            if c < 3.0:
                bad.append((sid, label, fg, bg, c))
    print('检查 %d 套（皮肤 × 明暗）' % total)
    if bad:
        print('\n勾号看不清的 %d 处：' % len(bad))
        for sid, label, fg, bg, c in bad:
            print('  %-14s %s  ✓色 %s  底色 %s  对比 %.2f' % (sid, label, fg, bg, c))
    else:
        print('全部清晰 ✅')


if __name__ == '__main__':
    main()
