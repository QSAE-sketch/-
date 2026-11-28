# -*- coding: utf-8 -*-
"""
扩展皮肤「逐套手调」工具

背景（用户反馈）：
  1) 大多数皮肤在暗色/亮色下颜色太晃眼 —— 深绿尤其刺眼，像"吃了一吨荧光剂"；
  2) 同一个页面上同一种颜色重复太多 —— 一眼看到三条通栏绿线，大屏上尤其难受；
  3) 但像「竹青」这类观感好的应当保留，不必全推翻重做。

所以这一版**不做统一公式生成**，而是：
  A. 主色**逐套手工指定**（NEW_ACCENT 表），每套按自己的性格单独挑，
     深色档压暗压灰、浅色档压成"墨色级"，不再有霓虹感；
  B. 卡片标题栏（.card-h）不再整条刷实色主色 —— 按该套自己的设计语言
     （swiss 网格 / brutal 粗野 / 其他）分别改成"淡底 + 主色细线"，
     页面上重复的主色从"三条色带"降到"几条细线"；
  C. 深色档顶栏不再用主色铺满，改成暗底浅字（与原版设计一致）；
  D. 每个前景/背景组合过 WCAG 对比度校验（>= 4.5）。

绝对不动的：最早的 14 套（washi / openwire / cloud / deepsea / grey /
inkscroll / mint / nightgold / oldpaper / parchment / pine / plain / sky /
vermilion）—— 按用户要求原样保留。

运行： python tools/retune-skins.py
"""
import os, json, colorsys, re

BASE = os.path.join(os.path.dirname(__file__), '..', 'public', 'skins')

# 最早的 14 套：绝对不修改
KEEP = {
    'washi', 'openwire', 'cloud', 'deepsea', 'grey', 'inkscroll', 'mint',
    'nightgold', 'oldpaper', 'parchment', 'pine', 'plain', 'sky', 'vermilion',
}

# ---------------------------------------------------------------- 逐套手工选色
# id: (浅色主色, 深色主色, 手改说明)
# 选色原则（逐套按自己的性格挑，不套公式）：
#   浅色 —— 压成「墨色级」：S 45~62 / L 30~40。作文字/线条仍醒目，但不再刺眼。
#   深色 —— 收成「柔和亮色」：S 38~55 / L 55~66。深底上读得清，却不发光。
NEW_ACCENT = {
    'rouge':      ('#8f3a48', '#c07a86', '胭脂：枣红压成暗酒红，浅色不再扎眼'),
    'indigo':     ('#2f4a8c', '#8791c9', '靛青：深靛收敛，浅色偏墨蓝'),
    'amber':      ('#8a6626', '#c9a05a', '琥珀：蜜蜡暖黄压暗，不做荧光橙'),
    'crow':       ('#2e5f7c', '#6e9fb8', '鸦青：青黑压到墨青，命令行冷调'),
    'maple':      ('#9c4030', '#c9806d', '枫叶：朱红压成砖红'),
    'denim':      ('#33538f', '#7f9bc4', '丹宁：靛蓝压成靛青'),
    'pine-soot':  ('#2d6f6c', '#6faba8', '松烟：墨青压暗，荧光字变沉青'),
    'bamboo-moon':('#4a8a63', '#8dc4a0', '竹月：青白收成淡竹青'),
    'dai-blue':   ('#2c3c85', '#7686cc', '黛蓝：远山蓝压深'),
    'autumn':     ('#8f8a2c', '#c4bd6a', '秋香：黄绿压成陈黄绿'),
    'fei':        ('#a8303a', '#cd7078', '妃色：正红压成绛红'),
    'azurite':    ('#1f6f8c', '#63a8c4', '石青：矿物蓝压成石板青'),
    'tea':        ('#86592b', '#c09a6c', '茶褐：浓茶褐压深'),
    'scallion':   ('#4e7a2b', '#93b268', '葱绿：鲜绿收成葱叶绿，去荧光'),
    'pine-flower':('#99852c', '#c6b56e', '松花：松花粉压成陈金'),
    'crimson':    ('#7e3a6c', '#c07ab8', '绛紫：深绛紫压暗'),
    'ginger':     ('#96681c', '#c8a45e', '姜黄：明黄压成姜褐'),
    'forest':     ('#2b7159', '#6fb598', '墨绿：草绿荧光收成松墨绿'),
    'sky-cyan':   ('#33808a', '#7cb2b8', '天青：雨过天青压成灰青'),
    'chestnut':   ('#7f4a28', '#c09068', '栗棕：糖炒栗棕压深'),
    'rosewood':   ('#7f2c5c', '#c07cae', '紫檀：深紫压成檀紫'),
    'scallion-2': ('#3e7a35', '#8ab877', '葱茏：草木绿压成沉稳叶绿'),
    'navy':       ('#2c3d7d', '#7585c4', '藏青：海军蓝压深'),
    'honey':      ('#96601f', '#c89a63', '蜜橙：蜂蜜橙压成琥珀橙'),
    'madder':     ('#9a4232', '#c88980', '茜色：茜草暗红压深'),
    'spring':     ('#3c7c44', '#86c294', '青阳：新绿收成春日老绿'),
    'plum':       ('#78306f', '#b87eb0', '梅子：紫红压成酒紫'),
    'jasper':     ('#2e7a63', '#7fbfa7', '碧玉：青绿压成玉青'),
}

# 颜色保持原样（本来饱和度就低、观感好；「竹青」是用户点名喜欢的）
UNTOUCHED_COLOR = {
    'bamboo', 'lotus', 'lilac', 'pale-blue', 'peach', 'coral',
    'moon-white', 'frost', 'celadon', 'smoke', 'silk',
    'sandal', 'guihua', 'clay', 'wisteria',
}

# ---------------------------------------------------------------- 颜色工具
def hx(c):
    c = c.strip().lstrip('#')
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def hstr(rgb):
    return '#%02x%02x%02x' % tuple(max(0, min(255, int(round(v)))) for v in rgb)


def mix(a, b, t):
    ca, cb = hx(a), hx(b)
    return hstr(ca[i] * (1 - t) + cb[i] * t for i in range(3))


def rgba(c, a):
    return 'rgba(%d, %d, %d, %s)' % (hx(c) + (a,))


def rel(c):
    def lin(v):
        v /= 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = [lin(x) for x in hx(c)]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    x, y = sorted((rel(a), rel(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


def on_accent(ac):
    return '#ffffff' if contrast(ac, '#ffffff') >= contrast(ac, '#151515') else '#151515'


def hsl2(h, s, l):
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360.0, l / 100.0, s / 100.0)
    return hstr((r * 255, g * 255, b * 255))


def hue_of(c):
    r, g, b = [x / 255 for x in hx(c)]
    return round(colorsys.rgb_to_hls(r, g, b)[0] * 360)


def sat_lum_of(c):
    r, g, b = [x / 255 for x in hx(c)]
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return round(s * 100), round(l * 100)


def ensure(fg, bg, min_ratio=4.5):
    """把前景往远离底色的方向推，只调明度、不改色相。"""
    if contrast(fg, bg) >= min_ratio:
        return fg
    toward = '#000000' if rel(bg) > 0.32 else '#ffffff'
    best = fg
    for t in (0.06, 0.12, 0.18, 0.24, 0.30, 0.38, 0.46, 0.55, 0.65, 0.78):
        m = mix(fg, toward, t)
        if contrast(m, bg) >= min_ratio:
            return m
        best = m
    return best


# ---------------------------------------------------------------- 可读性加固
# 主色本身可能偏浅（尤其浅色档），直接当链接/徽章文字用会看不清。
# 这里不改主色本身（保住每套的性格），只把「当文字用」的派生色
# 往更深的方向推，直到达标 —— 色相不变，只是更沉稳。
READABILITY = [
    ('--link', '--surface', 4.5),
    ('--badge-fg', '--badge-bg', 4.5),
    ('--up-fg', '--up-bg', 4.5),
    ('--role-2-fg', '--role-2-bg', 4.5),
    ('--card-h-fg', '--card-h-bg', 4.5),
    # 弱化层级（次要说明、meta、占位）：3.0 即可，但不能糊到看不清
    ('--fg-3', '--surface', 3.0),
    ('--fg-4', '--surface', 2.4),
]


def enforce_readability(v, dark):
    """把当文字用的派生色推到可读（只调明度，色相不变）。"""
    for key, bgkey, need in READABILITY:
        if key not in v or bgkey not in v:
            continue
        v[key] = ensure(v[key], v[bgkey], need)
    return v


# ---------------------------------------------------------------- 解析皮肤
VAR_RE = re.compile(r'(--[a-z0-9-]+):\s*([^;]+);')


def read_skin(sid):
    path = os.path.join(BASE, sid, 'skin.css')
    css = open(path, encoding='utf-8').read()
    idx = css.find(':root[data-theme="dark"]')
    if idx < 0:
        return None
    head, tail = css[:idx], css[idx:]
    l_open = head.find('{')
    l_close = head.find('}', l_open)
    d_open = tail.find('{')
    d_close = tail.find('}', d_open)
    raw_light = head[l_open + 1:l_close]
    raw_dark = tail[d_open + 1:d_close]
    struct = tail[d_close + 1:]

    def parse(part):
        return {k: v.strip() for k, v in VAR_RE.findall(part)}

    return {
        'header': head[:l_open],
        'raw_light': raw_light,
        'raw_dark': raw_dark,
        'light': parse(raw_light),
        'dark': parse(raw_dark),
        'struct': struct,
    }


def rebuild_block(raw, vals):
    """重写变量块：逐行替换变量值，非变量行（color-scheme 等）原样保留。"""
    out = []
    for line in raw.split('\n'):
        m = re.match(r'\s*(--[a-z0-9-]+):', line)
        if m and m.group(1) in vals:
            out.append('  %s: %s;' % (m.group(1), vals[m.group(1)]))
        else:
            out.append(line)
    return '\n'.join(out)


def write_css(sid, skin, lv, dv, struct):
    css = (skin['header'] + '{' + rebuild_block(skin['raw_light'], lv) + '}\n\n'
           + ':root[data-theme="dark"] {' + rebuild_block(skin['raw_dark'], dv) + '}\n\n'
           + struct.lstrip('\n'))
    open(os.path.join(BASE, sid, 'skin.css'), 'w', encoding='utf-8', newline='').write(css)


# ---------------------------------------------------------------- 主色重算
def rebuild_vars(v, accent, dark):
    """基于（手工选定的）新主色重算派生变量 —— 这里只是机械推导。"""
    bg, surface, fg = v['--bg'], v['--surface'], v['--fg']
    border = v['--border']
    h = hue_of(accent)
    s, l = sat_lum_of(accent)

    if not dark:
        # 浅色：主色要能当文字用（链接/徽章），压不到可读就往黑推
        accent = ensure(accent, surface, 4.5)
    else:
        # 深色：主色在深底上要够亮，但不许过曝
        if rel(accent) > 0.60:
            accent = mix(accent, bg, 0.32)
        accent = ensure(accent, surface, 4.5)

    on = on_accent(accent)
    v['--accent'] = accent
    v['--accent-2'] = mix(accent, '#000000' if not dark else '#ffffff', .16)
    v['--accent-soft'] = hsl2(h, min(s, 40), 94 if not dark else 17)
    v['--accent-soft-border'] = hsl2(h, min(s, 46), 86 if not dark else 27)
    v['--accent-ring'] = rgba(accent, .32)
    v['--on-accent'] = on
    v['--av-fg'] = on

    # 顶栏：浅色用主色（已压成墨色级）；深色用暗底浅字，不再铺主色
    if dark:
        bar_bg = mix(accent, bg, .80)
        bar_fg = ensure(mix(accent, '#ffffff', .46), bar_bg, 4.5)
    else:
        bar_bg, bar_fg = accent, on
    v['--topbar-bg'] = bar_bg
    v['--topbar-fg'] = bar_fg

    v['--tabbar-bg'] = surface
    v['--bubble'] = surface
    v['--bubble-mine'] = hsl2(h, min(s, 32), 90 if not dark else 26)
    v['--bubble-fg'] = fg
    v['--bubble-who'] = v.get('--fg-3', fg)
    v['--bubble-meta'] = v.get('--fg-4', fg)
    v['--pick-bg'] = surface
    v['--pick-border'] = v['--border-3']
    v['--pick-on'] = accent
    v['--up-bg'] = v['--accent-soft']
    v['--up-fg'] = ensure(accent, v['--accent-soft'], 4.5)
    v['--up-track'] = border
    v['--up-fill'] = accent
    v['--badge-bg'] = v['--accent-soft']
    v['--badge-fg'] = ensure(accent, v['--accent-soft'], 4.5)
    v['--role-2-bg'] = v['--accent-soft']
    v['--role-2-fg'] = v['--badge-fg']
    v['--link'] = ensure(accent, surface, 4.5)
    v['--link-hover'] = v['--accent-2']
    v['--card-h-bg'] = v['--accent-soft']
    v['--card-h-fg'] = v['--accent']
    return v


# ---------------------------------------------------------------- 卡片标题栏
def fix_card_h(sid, style, struct):
    """把「整条刷实色主色」的卡片头改成各设计语言自己的克制做法。

    只针对真正有问题的那一种：background 直接用主色 → 通栏高饱和色带。
    原本就正常的（editorial/vintage 的细下划线、terminal 的左细边、
    notebook 的淡底虚线）一律不动 —— 那是每套自己的设计语言。

    swiss   —— 网格：干净底面 + 2px 主色下划线（横线是网格语言的一部分）
    brutal  —— 粗野：淡色底 + 3px 主色下划线（重量靠线，不靠大面积填色）
    """
    pat = r'html\[data-skin="%s"\]\s*\.card-h\s*\{([^}]*)\}\s*' % re.escape(sid)
    m = re.search(pat, struct)
    if not m:
        return struct, False
    body = m.group(1)
    # 只有「背景刷主色」才算问题；其它写法一律保留
    if not re.search(r'background:\s*var\(--accent\)', body):
        return struct, False
    struct = re.sub(pat, '', struct)
    sel = 'html[data-skin="%s"] .card-h' % sid
    if style == 'brutal':
        rule = ('%s { background: var(--accent-soft); color: var(--accent);\n'
                '  border-bottom: 3px solid var(--accent); border-radius: 0; }\n' % sel)
    elif style == 'swiss':
        rule = ('%s { background: var(--surface-2); color: var(--accent);\n'
                '  border-bottom: 2px solid var(--accent); border-radius: 0; }\n' % sel)
    else:
        rule = ('%s { background: var(--surface-2); color: var(--accent);\n'
                '  border-bottom: 2px solid var(--accent); border-radius: 0; }\n' % sel)
    return rule + struct, True


# ---------------------------------------------------------------- 预览图
def preview_svg(name, lv, dv, radius):
    def bar(v):
        bg, fg = v['--topbar-bg'], v['--topbar-fg']
        if contrast(bg, fg) < 4.5:
            return v['--surface'], v['--fg']
        return bg, fg
    lb, lfg = bar(lv)
    db, dfg = bar(dv)
    return '''<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
<rect width="320" height="200" fill="{lbg}"/>
<rect x="10" y="10" width="146" height="180" rx="{r}" fill="{ls}" stroke="{lbd}" stroke-width="1"/>
<rect x="10" y="10" width="146" height="30" rx="{r}" fill="{lbar}"/>
<text x="20" y="31" font-family="Arial,sans-serif" font-size="15" font-weight="bold" fill="{lfg}">{nm}</text>
<rect x="20" y="50" width="104" height="16" rx="3" fill="{lbd}" opacity=".5"/>
<rect x="20" y="74" width="112" height="22" rx="{r}" fill="{ls}" stroke="{lbd}"/>
<rect x="34" y="112" width="98" height="22" rx="{r}" fill="{lbub}"/>
<rect x="166" y="10" width="144" height="180" rx="{r}" fill="{ds}" stroke="{dbd}" stroke-width="1"/>
<rect x="166" y="10" width="144" height="30" rx="{r}" fill="{dbar}"/>
<text x="176" y="31" font-family="Arial,sans-serif" font-size="15" font-weight="bold" fill="{dfg}">{nm}</text>
<rect x="176" y="50" width="102" height="16" rx="3" fill="{dbd}" opacity=".5"/>
<rect x="176" y="74" width="118" height="22" rx="{r}" fill="{ds}" stroke="{dbd}"/>
<rect x="190" y="112" width="106" height="22" rx="{r}" fill="{dbub}"/>
</svg>
'''.format(lbg=lv['--bg'], ls=lv['--surface'], lbd=lv['--border-3'], lbar=lb, lfg=lfg,
           lbub=lv['--bubble-mine'], ds=dv['--surface'], dbd=dv['--border-3'],
           dbar=db, dfg=dfg, dbub=dv['--bubble-mine'], nm=name, r=radius)


def radius_of(struct):
    m = re.search(r'textarea \{ border-radius: (\d+)px; \}', struct)
    return int(m.group(1)) if m else 4


# ---------------------------------------------------------------- 主流程
def main():
    problems = []
    recolored, restyled = [], []
    for sid in sorted(os.listdir(BASE)):
        if sid in KEEP or not os.path.exists(os.path.join(BASE, sid, 'skin.css')):
            continue
        skin = read_skin(sid)
        if not skin:
            continue
        mf_path = os.path.join(BASE, sid, 'manifest.json')
        mf = json.load(open(mf_path, encoding='utf-8'))
        style = mf.get('style', 'other')

        struct, did_card = fix_card_h(sid, style, skin['struct'])
        lv, dv = dict(skin['light']), dict(skin['dark'])
        recolored_now = False
        if sid in NEW_ACCENT:
            al, ad, note = NEW_ACCENT[sid]
            lv = rebuild_vars(lv, al, False)
            dv = rebuild_vars(dv, ad, True)
            mf['description'] = note
            recolored_now = True
            recolored.append((sid, al, ad, note))
        # 无论改没改主色，都做一次可读性加固（浅色档次要文字/徽章太灰的问题）
        lv = enforce_readability(lv, False)
        dv = enforce_readability(dv, True)
        if did_card:
            restyled.append((sid, style))

        if not (did_card or recolored_now):
            continue

        write_css(sid, skin, lv, dv, struct)
        if recolored_now:
            name = mf.get('name', sid).split()[0]
            open(os.path.join(BASE, sid, 'preview.svg'), 'w', encoding='utf-8', newline='').write(
                preview_svg(name, lv, dv, radius_of(struct)))
            json.dump(mf, open(mf_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
            open(mf_path, 'a', encoding='utf-8').write('\n')

        for label, v in (('浅', lv), ('深', dv)):
            checks = [
                ('顶栏', v['--topbar-bg'], v['--topbar-fg'], 4.5),
                ('正文', v['--fg'], v['--bg'], 4.5),
                ('次要文字', v['--fg-2'], v['--surface'], 4.5),
                # fg-3/fg-4 是设计上的弱化层级（占位、meta），原版主题也是 3.0 级别
                ('弱文字', v['--fg-3'], v['--surface'], 3.0),
                ('链接', v['--link'], v['--surface'], 4.5),
                ('徽章', v['--badge-fg'], v['--badge-bg'], 4.5),
                ('自己气泡', v['--bubble-fg'], v['--bubble-mine'], 4.5),
                ('卡头', v['--card-h-fg'], v['--card-h-bg'], 4.5),
                ('上传提示', v['--up-fg'], v['--up-bg'], 4.5),
                ('角色2', v['--role-2-fg'], v['--role-2-bg'], 4.5),
            ]
            for pn, a, b, need in checks:
                c = contrast(a, b)
                if c < need:
                    problems.append('%s %s %s 对比 %.2f < %.1f' % (sid, label, pn, c, need))

    print('主色逐套手调 %d 套：' % len(recolored))
    for sid, al, ad, note in recolored:
        print('  %-13s %s / %s   %s' % (sid, al, ad, note))
    print('\n卡片标题栏去掉实色刷法 %d 套：' % len(restyled))
    for sid, style in restyled:
        print('  %-13s (%s)' % (sid, style))
    print('\n颜色保持原样（含用户点名喜欢的「竹青」）：%s'
          % ' '.join(sorted(UNTOUCHED_COLOR)))
    if problems:
        print('\n!! 对比度未达标 %d 处：' % len(problems))
        for p in problems:
            print('   ' + p)
    else:
        print('\n全部前景/背景组合对比度 ≥ 4.5')


if __name__ == '__main__':
    main()
