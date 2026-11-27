# -*- coding: utf-8 -*-
"""
轻聊 · 扩展皮肤生成器（42 套）

设计方法（避免"AI 味"）：
  每套皮肤在 4 个维度上区分，且互不重复：
    1) 色相 H        —— 手工指定，覆盖红橙黄绿青蓝紫粉
    2) 调性 tone     —— airy(清新) / vivid(鲜明) / deep(深沉) / soft(柔和)
    3) 中性底 neutral —— tonal(带主色) / warm(暖灰) / cool(冷灰) / paper(米纸) / ink(墨蓝)
    4) 结构 arche    —— editorial / swiss / notebook / terminal / soft / brutal / minimal / vintage

  配色用 HSL 同色系(tonal)派生：中性色带一点主色调，而非纯灰；
  主色饱和度克制；浅深两套是"同一设计语言的两种明度"，不是调亮度。
  所有前景/背景组合经过 WCAG 对比度校验（>= 4.5）。

运行： python tools/gen-skins-more.py
"""
import os, json, colorsys, sys

BASE = os.path.join(os.path.dirname(__file__), '..', 'public', 'skins')

# id, 中文名, 英文名, 色相H, 调性, 中性底, 结构, 灵感说明
STYLES = [
    ('rouge',      '胭脂',   'Rouge',       350, 'vivid', 'warm',   'editorial', '老式胭脂盒的枣红，衬线标题配细分割线'),
    ('indigo',     '靛青',   'Indigo',      225, 'deep',  'tonal',  'minimal',   '蓝染布料的深靛，克制留白'),
    ('amber',      '琥珀',   'Amber',        38, 'vivid', 'paper',  'vintage',   '蜜蜡琥珀的暖黄，旧纸底配深褐字'),
    ('bamboo',     '竹青',   'Bamboo',      150, 'soft',  'tonal',  'editorial', '新鲜竹叶的青，纸面细纹'),
    ('lotus',      '藕粉',   'Lotus',       330, 'airy',  'warm',   'soft',      '藕荷色的淡粉，圆润柔和'),
    ('crow',       '鸦青',   'Crow',        198, 'deep',  'ink',    'swiss',     '鸦羽的青黑，瑞士网格排版'),
    ('maple',      '枫叶',   'Maple',        12, 'vivid', 'warm',   'editorial', '霜降枫叶的朱红，杂志标题感'),
    ('silk',       '缃色',   'Silk',         46, 'soft',  'paper',  'vintage',   '浅黄丝绸的柔光，旧书页气质'),
    ('denim',      '丹宁',   'Denim',       214, 'mid',   'cool',   'brutal',    '丹宁布的靛蓝，硬朗粗边'),
    ('pine-soot',  '松烟',   'PineSoot',    178, 'deep',  'tonal',  'terminal',  '松烟墨的青灰，等宽终端感'),
    ('sandal',     '檀香',   'Sandal',       26, 'soft',  'warm',   'notebook',  '檀香木的褐，笔记纸的暖意'),
    ('lilac',      '丁香',   'Lilac',       278, 'airy',  'cool',   'soft',      '丁香花的淡紫，轻盈圆润'),
    ('bamboo-moon','竹月',   'BambooMoon',  142, 'airy',  'tonal',  'minimal',   '竹间月色的青白，极简留白'),
    ('dai-blue',   '黛蓝',   'DaiBlue',     232, 'deep',  'ink',    'editorial', '远山黛蓝，衬线 + 细线分隔'),
    ('autumn',     '秋香',   'Autumn',       56, 'mid',   'paper',  'vintage',   '秋香色的黄绿，旧纸暖调'),
    ('fei',        '妃色',   'Fei',         356, 'vivid', 'warm',   'brutal',    '妃色的正红，粗边硬朗'),
    ('azurite',    '石青',   'Azurite',     194, 'vivid', 'cool',   'swiss',     '矿物颜料的石青，纯色块'),
    ('tea',        '茶褐',   'Tea',          32, 'deep',  'warm',   'notebook',  '浓茶的褐，牛皮纸笔记'),
    ('scallion',   '葱绿',   'Scallion',    102, 'vivid', 'tonal',  'swiss',     '小葱的鲜绿，干净色块'),
    ('moon-white', '月白',   'MoonWhite',   208, 'airy',  'cool',   'minimal',   '月白瓷的青白，极简通透'),
    ('coral',      '珊瑚',   'Coral',         9, 'airy',  'warm',   'soft',      '珊瑚的暖橘粉，柔和亲切'),
    ('wisteria',   '藤紫',   'Wisteria',    272, 'soft',  'cool',   'editorial', '紫藤花的柔紫，衬线优雅'),
    ('pine-flower','松花',   'PineFlower',   50, 'mid',   'paper',  'vintage',   '松花粉的金黄，复古印刷'),
    ('celadon',    '青瓷',   'Celadon',     165, 'soft',  'tonal',  'minimal',   '龙泉青瓷的粉青，温润留白'),
    ('crimson',    '绛紫',   'Crimson',     312, 'deep',  'tonal',  'editorial', '绛紫绸缎的深，衬线复古'),
    ('pale-blue',  '缥色',   'PaleBlue',    188, 'airy',  'cool',   'soft',      '缥缈的淡青，轻盈圆润'),
    ('ginger',     '姜黄',   'Ginger',       42, 'vivid', 'paper',  'brutal',    '姜黄的明艳，粗边框'),
    ('forest',     '墨绿',   'Forest',      155, 'deep',  'tonal',  'terminal',  '深林墨绿，等宽终端'),
    ('peach',      '桃夭',   'Peach',       344, 'airy',  'warm',   'notebook',  '桃花的浅粉，便签笔记'),
    ('sky-cyan',   '天青',   'SkyCyan',     184, 'mid',   'cool',   'swiss',     '雨过天青，瑞士色块'),
    ('chestnut',   '栗棕',   'Chestnut',     22, 'deep',  'warm',   'vintage',   '糖炒栗子的棕，旧纸质感'),
    ('rosewood',   '紫檀',   'Rosewood',    320, 'deep',  'ink',    'editorial', '紫檀木的深紫，衬线沉稳'),
    ('scallion-2', '葱茏',   'Verdant',     118, 'mid',   'tonal',  'brutal',    '草木葱茏的绿，硬朗边框'),
    ('navy',       '藏青',   'Navy',        228, 'deep',  'cool',   'swiss',     '海军藏青，规整网格'),
    ('honey',      '蜜橙',   'Honey',        30, 'vivid', 'warm',   'soft',      '蜂蜜的暖橙，圆润柔和'),
    ('smoke',      '烟灰',   'Smoke',       250, 'soft',  'cool',   'minimal',   '淡烟的灰紫，极简低饱和'),
    ('madder',     '茜色',   'Madder',        6, 'mid',   'paper',  'editorial', '茜草染的暗红，印刷感'),
    ('spring',     '青阳',   'SpringGreen', 132, 'mid',   'tonal',  'notebook',  '春日新绿的明亮，笔记纸'),
    ('guihua',     '桂花',   'Osmanthus',    48, 'soft',  'paper',  'soft',      '桂花的奶黄，柔和圆润'),
    ('frost',      '霜色',   'Frost',       202, 'airy',  'cool',   'minimal',   '晨霜的冷白蓝，极简'),
    ('plum',       '梅子',   'Plum',        298, 'deep',  'tonal',  'vintage',   '梅子酒的紫红，复古暖调'),
    ('jasper',     '碧玉',   'Jasper',      158, 'mid',   'tonal',  'swiss',     '碧玉的青绿，干净色块'),
    ('clay',       '陶土',   'Clay',         18, 'soft',  'warm',   'brutal',    '陶土的暖棕，粗边手工感'),
]

# 调性 → (浅色主色 s,l ; 深色主色 s,l)
TONE = {
    'airy':  ((52, 50), (62, 74)),
    'vivid': ((74, 44), (80, 66)),
    'mid':   ((64, 46), (72, 70)),
    'deep':  ((58, 38), (70, 68)),
    'soft':  ((36, 54), (44, 78)),
}

# 中性底 → (中性色相, 中性饱和度)
NEUTRAL = {
    'tonal': None,        # 用主色相
    'warm':  (32, 10),
    'cool':  (212, 10),
    'paper': (44, 20),
    'ink':   (220, 12),
}

# 结构风格 → 圆角/字体/边框/阴影/标题样式
ARCH = {
    'editorial': dict(radius=0,  font='Georgia,"Songti SC",serif',        bw=1, shadow='none',  head='line',   note='衬线标题 + 细分割线'),
    'swiss':     dict(radius=2,  font='Arial,"PingFang SC",sans-serif',   bw=0, shadow='none',  head='block',  note='无衬线 + 纯色块'),
    'notebook':  dict(radius=6,  font='"Kaiti SC","STKaiti",cursive',     bw=1, shadow='soft',  head='tape',   note='手写体 + 纸张便签'),
    'terminal':  dict(radius=0,  font='"Courier New",Consolas,monospace', bw=1, shadow='none',  head='bar',    note='等宽字 + 终端高亮'),
    'soft':      dict(radius=16, font='-apple-system,"PingFang SC",sans-serif', bw=0, shadow='soft', head='plain', note='大圆角 + 柔和阴影'),
    'brutal':    dict(radius=2,  font='Arial,"PingFang SC",sans-serif',   bw=2, shadow='hard',  head='block',  note='粗边框 + 硬阴影'),
    'minimal':   dict(radius=4,  font='-apple-system,"PingFang SC",sans-serif', bw=1, shadow='none', head='plain', note='大量留白 + 极细描边'),
    'vintage':   dict(radius=3,  font='Georgia,"Songti SC",serif',        bw=1, shadow='soft',  head='line',   note='衬线 + 旧纸暖调'),
}


def hsl(h, s, l):
    r, g, b = colorsys.hls_to_rgb((h % 360) / 360.0, l / 100.0, s / 100.0)
    return '#%02x%02x%02x' % (int(round(r * 255)), int(round(g * 255)), int(round(b * 255)))


def hx(c):
    c = c.strip().lstrip('#')
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    ca, cb = hx(a), hx(b)
    return '#%02x%02x%02x' % tuple(max(0, min(255, int(round(ca[i] * (1 - t) + cb[i] * t)))) for i in range(3))


def rgba(c, a):
    return 'rgba(%d, %d, %d, %s)' % (hx(c) + (a,))


def rel(c):
    def lin(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = [lin(x) for x in hx(c)]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    x, y = sorted((rel(a), rel(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


def on_accent(ac):
    return '#ffffff' if contrast(ac, '#ffffff') >= contrast(ac, '#151515') else '#151515'


def neutral_of(h, kind):
    return NEUTRAL[kind] if NEUTRAL[kind] else (h, 9)


def build_vars(h, tone, neutral, dark):
    """用 HSL 派生成完整变量字典（同色系 tonal 配色）。"""
    nh, ns = neutral_of(h, neutral)
    s_a, l_a = TONE[tone][1 if dark else 0]
    accent = hsl(h, s_a, l_a)
    if dark:
        bg = hsl(nh, ns, 9); surface = hsl(nh, ns, 13)
        surface2 = hsl(nh, ns, 16); surface3 = hsl(nh, ns, 20); surface4 = hsl(nh, ns, 24)
        fg = hsl(nh, min(ns + 8, 20), 93); fg2 = hsl(nh, ns, 73); fg3 = hsl(nh, ns, 57)
        border = hsl(nh, ns, 25); border3 = hsl(nh, ns, 34)
    else:
        bg = hsl(nh, ns, 95); surface = hsl(nh, max(ns - 3, 2), 99)
        surface2 = hsl(nh, ns, 97); surface3 = hsl(nh, ns, 94); surface4 = hsl(nh, ns, 90)
        fg = hsl(nh, min(ns + 8, 22), 15); fg2 = hsl(nh, ns, 38); fg3 = hsl(nh, ns, 55)
        border = hsl(nh, ns, 88); border3 = hsl(nh, ns, 80)
    muted = fg3
    v = {}
    v['--bg'], v['--surface'], v['--fg'] = bg, surface, fg
    v['--surface-2'], v['--surface-3'], v['--surface-4'] = surface2, surface3, surface4
    v['--fg-2'], v['--fg-3'], v['--fg-4'], v['--fg-5'] = fg2, fg3, mix(muted, bg, .22), mix(muted, bg, .42)
    v['--ph'] = v['--fg-4']
    v['--border'] = border
    v['--border-2'] = mix(border, surface, .6)
    v['--border-3'] = border3
    v['--border-4'] = mix(border, surface, .78)
    v['--accent'], v['--accent-2'] = accent, hsl(h, s_a, l_a - (8 if not dark else -8))
    v['--accent-soft'] = hsl(h, min(s_a, 42), 22 if dark else 94)
    v['--accent-soft-border'] = hsl(h, min(s_a, 48), 30 if dark else 86)
    v['--accent-ring'] = rgba(accent, .35)
    v['--on-accent'] = on_accent(accent)
    v['--danger'] = '#ff8a8a' if dark else '#c23345'
    v['--danger-2'] = '#e87070' if dark else '#9c2535'
    v['--warn'] = '#e0b072' if dark else '#a3701a'
    v['--topbar-bg'], v['--topbar-fg'] = accent, v['--on-accent']
    v['--tabbar-bg'] = surface
    v['--bubble'] = surface
    v['--bubble-mine'] = hsl(h, min(s_a, 34), 30 if dark else 90)
    v['--bubble-fg'] = fg
    v['--bubble-who'] = muted
    v['--bubble-meta'] = v['--fg-4']
    v['--av-fg'] = v['--on-accent']
    v['--pick-bg'], v['--pick-border'], v['--pick-on'] = surface, v['--border-3'], accent
    v['--up-bg'] = v['--accent-soft']
    v['--up-fg'] = accent
    v['--up-track'] = border
    v['--up-fill'] = accent
    v['--toast-bg'] = rgba(mix(fg, bg, .12), .93)
    v['--toast-fg'] = surface
    v['--badge-bg'], v['--badge-fg'] = v['--accent-soft'], accent
    v['--badge-gray-bg'], v['--badge-gray-fg'] = v['--surface-3'], fg2
    v['--badge-warn-bg'] = hsl(38, 60, 24 if dark else 92)
    v['--badge-warn-fg'] = '#e0b072' if dark else '#9c6a1a'
    v['--role-4-bg'], v['--role-4-fg'] = v['--badge-warn-bg'], '#ff9a9a' if dark else '#a12a40'
    v['--role-3-bg'], v['--role-3-fg'] = v['--badge-warn-bg'], v['--badge-warn-fg']
    v['--role-2-bg'], v['--role-2-fg'] = v['--accent-soft'], accent
    v['--role-1-bg'], v['--role-1-fg'] = v['--surface-3'], hsl(150, 45, 62 if dark else 34)
    v['--role-0-bg'], v['--role-0-fg'] = v['--surface-3'], fg2
    v['--mact-off'] = v['--border-3']
    v['--link'], v['--link-hover'] = accent, v['--accent-2']
    v['--code-bg'], v['--code-fg'], v['--code-border'] = v['--surface-2'], fg, border
    v['--quote-bg'], v['--quote-border'], v['--quote-fg'] = v['--surface-2'], v['--border-3'], fg2
    v['--table-head-bg'] = v['--surface-2']
    v['--table-border'] = border
    v['--table-stripe'] = v['--surface-3']
    v['--table-hover'] = v['--surface-4']
    v['--img-bg'], v['--img-border'] = v['--surface-4'], border
    v['--shadow'] = rgba(fg, .30 if dark else .16)
    v['--overlay'] = rgba(fg, .66 if dark else .48)
    v['--scrollbar-thumb'] = v['--border-3']
    v['--scrollbar-thumb-hover'] = mix(v['--border-3'], fg, .2)
    v['--scrollbar-track'] = 'transparent' if not dark else bg
    v['--card-h-bg'] = v['--surface-2']
    v['--card-h-fg'] = fg2
    v['--dot'] = mix(border, bg, .3)
    v['--stroke'] = '1px'
    v['--drop'] = '0 2px 8px %s' % rgba(fg, .20 if dark else .08)
    return v


def block(sel, v):
    return sel + ' {\n' + ''.join('  %s: %s;\n' % (k, v[k]) for k in v) + '}\n'


def preview_svg(sid, name, h, tone, neutral, arche):
    """预览：左右各一张卡（浅/深），标题条按对比度选字色，字号足够大。"""
    lv = build_vars(h, tone, neutral, False)
    dv = build_vars(h, tone, neutral, True)
    l_bar, l_fg = lv['--topbar-bg'], lv['--topbar-fg']
    d_bar, d_fg = dv['--topbar-bg'], dv['--topbar-fg']
    lr = ARCH[arche]['radius']
    dr = ARCH[arche]['radius']
    return '''<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
<rect width="320" height="200" fill="{lb}"/>
<rect x="10" y="10" width="146" height="180" rx="{lr}" fill="{ls}" stroke="{lbd}" stroke-width="1"/>
<rect x="10" y="10" width="146" height="30" rx="{lr}" fill="{lbar}"/>
<text x="20" y="31" font-family="Arial,sans-serif" font-size="15" font-weight="bold" fill="{lfg}">{nm}</text>
<rect x="20" y="50" width="104" height="16" rx="3" fill="{lbd}" opacity=".5"/>
<rect x="20" y="74" width="112" height="22" rx="{lr}" fill="{ls}" stroke="{lbd}"/>
<rect x="34" y="112" width="98" height="22" rx="{lr}" fill="{lbub}"/>
<rect x="166" y="10" width="144" height="180" rx="{dr}" fill="{ds}" stroke="{dbd}" stroke-width="1"/>
<rect x="166" y="10" width="144" height="30" rx="{dr}" fill="{dbar}"/>
<text x="176" y="31" font-family="Arial,sans-serif" font-size="15" font-weight="bold" fill="{dfg}">{nm}</text>
<rect x="176" y="50" width="102" height="16" rx="3" fill="{dbd}" opacity=".5"/>
<rect x="176" y="74" width="118" height="22" rx="{dr}" fill="{ds}" stroke="{dbd}"/>
<rect x="190" y="112" width="106" height="22" rx="{dr}" fill="{dbub}"/>
</svg>
'''.format(lb=lv['--bg'], ls=lv['--surface'], lbd=lv['--border-3'], lbar=l_bar, lfg=l_fg,
           lbub=lv['--bubble-mine'], lr=lr,
           ds=dv['--surface'], dbd=dv['--border-3'], dbar=d_bar, dfg=d_fg,
           dbub=dv['--bubble-mine'], dr=dr, nm=name)


def arch_css(sid, arche):
    a = ARCH[arche]
    r = a['radius']
    sel = lambda c: 'html[data-skin="%s"] %s' % (sid, c)
    css = []
    css.append('%s .card, %s .msg-box, %s .inp, %s input[type=text], %s textarea { border-radius: %dpx; }\n' %
               (sel(''), sel(''), sel(''), sel(''), sel(''), r))
    css.append('%s body { font-family: %s; }\n' % (sel(''), a['font']))
    if a['bw'] >= 2:
        css.append('%s .card, %s .msg-box { border: %dpx solid var(--border-3) !important; box-shadow: 3px 3px 0 var(--border-3); }\n' %
                   (sel(''), sel(''), a['bw']))
    elif a['bw'] == 0 and arche in ('swiss', 'minimal'):
        css.append('%s .card { border: 0 !important; box-shadow: none; }\n' % sel(''))
    if a['head'] == 'line':
        css.append('%s .card-h { border-bottom: 2px solid var(--fg-3); border-radius: 0; }\n' % sel(''))
    elif a['head'] == 'block':
        css.append('%s .card-h { background: var(--accent); color: var(--on-accent); border-radius: 0; }\n' % sel(''))
    elif a['head'] == 'bar':
        css.append('%s .card-h { border-left: 4px solid var(--accent); border-radius: 0; }\n' % sel(''))
    elif a['head'] == 'tape':
        css.append('%s .card-h { background: var(--accent-soft); border-bottom: 1px dashed var(--border-3); }\n' % sel(''))
    if arche == 'terminal':
        css.append('%s .bubble { border: 1px solid var(--accent); background: transparent; }\n' % sel(''))
    if arche == 'vintage':
        css.append('%s body { background-image: repeating-linear-gradient(0deg, transparent, transparent 3px, var(--dot) 4px); }\n' % sel(''))
    if arche == 'notebook':
        css.append('%s body { background-image: linear-gradient(var(--dot) 1px, transparent 1px); background-size: 100%% 28px; }\n' % sel(''))
    return ''.join(css)


def main():
    count = 0
    for sid, name, en, h, tone, neutral, arche, desc in STYLES:
        d = os.path.join(BASE, sid)
        os.makedirs(d, exist_ok=True)
        lv = build_vars(h, tone, neutral, False)
        dv = build_vars(h, tone, neutral, True)
        # 对比度自检
        for v in (lv, dv):
            assert contrast(v['--topbar-bg'], v['--topbar-fg']) >= 4.5, sid + ' topbar'
            assert contrast(v['--card-h-bg'], v['--card-h-fg']) >= 4.5, sid + ' card-h'
        css = ('/* %s %s —— %s。\n'
               ' * 同色系(tonal)配色：中性色带主色调，非纯灰；浅深两套为同一设计语言的两种明度。\n'
               ' * 结构：%s；色相 %d° / 调性 %s / 中性底 %s。\n */\n' %
               (name, en, desc, ARCH[arche]['note'], h, tone, neutral))
        css += ':root {\n  color-scheme: light;\n' + ''.join('  %s: %s;\n' % (k, v) for k, v in lv.items()) + '}\n\n'
        css += ':root[data-theme="dark"] {\n  color-scheme: dark;\n' + ''.join('  %s: %s;\n' % (k, v) for k, v in dv.items()) + '}\n\n'
        css += '/* 结构特征 */\n' + arch_css(sid, arche)
        open(os.path.join(d, 'skin.css'), 'w', encoding='utf-8').write(css)
        mf = dict(id=sid, name='%s %s' % (name, en), version='1.0.0', author='系统内置',
                  description='%s；%s' % (desc, ARCH[arche]['note']),
                  entry='skin.css', preview='preview.svg', style=arche, tone=tone)
        open(os.path.join(d, 'manifest.json'), 'w', encoding='utf-8').write(
            json.dumps(mf, ensure_ascii=False, indent=2) + '\n')
        open(os.path.join(d, 'preview.svg'), 'w', encoding='utf-8').write(preview_svg(sid, name, h, tone, neutral, arche))
        count += 1
    print('generated %d skins' % count)


if __name__ == '__main__':
    main()
