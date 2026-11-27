# -*- coding: utf-8 -*-
"""
内置皮肤生成器：把参考站点的配色做成轻聊皮肤。
每套含浅色 + 深色两套完整变量（同色系重新配色，不是调亮度），
并带上该风格的圆角/字体特征，避免只是换色。

运行： python tools/gen-skins.py
"""
import os, json, colorsys, re

BASE = os.path.join(os.path.dirname(__file__), '..', 'public', 'skins')

# id, 名称, 圆角px, 字体族, 浅色(bg,surface,fg,muted,border,accent), 深色(...)
# 数据提炼自 chat-12-styles.html / chat-serie02.html 的 24 套主题，
# 精选 12 套风格差异大、配色克制的，深色/浅色互为配套重新配色。
SKINS = [
    ('inkscroll','墨卷 INKSCROLL',3,'serif',
     ('#f2ece0','#faf6ec','#1c1a16','#8b8172','#ded5c3','#a2472b'),
     ('#1c1813','#262019','#f2ece0','#9a8c7a','#3d3327','#d9805f')),
    ('sky','晴空 SKY',19,'sans',
     ('#e8edf4','#ffffff','#111827','#77808f','#e3e7ee','#1a6cf5'),
     ('#0e1624','#16223a','#e8edf4','#8496b2','#283a59','#6ba6ff')),
    ('plain','素纸 PLAIN',2,'sans',
     ('#e9e6df','#fbfaf6','#141210','#6f6a60','#c9c4b6','#5c5548'),
     ('#161615','#20201e','#e9e6df','#8a857a','#393832','#b8b2a6')),
    ('vermilion','赤章 VERMILION',2,'sans',
     ('#ffffff','#ffffff','#0d0d0d','#8a8a8a','#e6e6e6','#c62c19'),
     ('#1a0f0e','#261716','#f7efed','#a8908c','#4a2824','#ff6b57')),
    ('parchment','羊皮 PARCHMENT',6,'serif',
     ('#f6ecd6','#fdf7e6','#33311f','#9c9070','#e4d6b4','#2f4f8f'),
     ('#1b1a14','#26251c','#f0e6cf','#a79a7c','#3a3728','#7fa0d8')),
    ('mint','薄荷 MINT',18,'sans',
     ('#dff3e8','#eafaf1','#132018','#5f7a69','#bfe3ce','#107148'),
     ('#0d1c14','#13291d','#e6f5ec','#88a895','#28503b','#5ad6a0')),
    ('nightgold','夜金 NIGHT GOLD',4,'serif',
     ('#f7f2e6','#fffcf5','#2b2416','#8d8268','#ded3b6','#8a6b1f'),
     ('#14130f','#181611','#efe7d4','#8d8574','#302c22','#c8a45a')),
    ('oldpaper','古纸 OLD PAPER',3,'serif',
     ('#e5decd','#f4eee0','#241f17','#7c7260','#cfc4ac','#8e3a2c'),
     ('#1c1710','#282117','#efe4cd','#9a8c74','#3f3325','#d98f75')),
    ('pine','松绿 PINE',10,'serif',
     ('#eef3e9','#fbfdf8','#16251b','#728474','#ceddcc','#35663f'),
     ('#0f1b16','#12211b','#ede4ce','#85957f','#26382d','#c3a05c')),
    ('deepsea','深海 DEEP SEA',12,'sans',
     ('#edf3f7','#fbfdff','#122434','#6a7f91','#cadce8','#1a7a99'),
     ('#08131f','#0a1726','#d9e5f1','#5e7891','#1a3149','#4fb3c9')),
    ('cloud','云白 CLOUD',10,'sans',
     ('#f7f7f6','#ffffff','#151719','#7b8493','#e9ebee','#3a5ccc'),
     ('#111722','#18202f','#e8ecf2','#8391a8','#27334a','#7fa0ff')),
    ('grey','灰调 GREY',6,'sans',
     ('#f2f1ee','#f7f6f3','#131313','#8c8b86','#e0dfda','#4a4a48'),
     ('#161616','#202020','#eeedeb','#918f8a','#383835','#bdbcb6')),
]


def hx(c):
    c = c.strip().lstrip('#')
    if len(c) == 3:
        c = ''.join(ch * 2 for ch in c)
    return tuple(int(c[i:i+2], 16) for i in (0, 2, 4))


def hstr(rgb):
    return '#%02x%02x%02x' % tuple(max(0, min(255, int(round(v)))) for v in rgb)


def mix(a, b, t):
    """t=0 取 a，t=1 取 b"""
    ca, cb = hx(a), hx(b)
    return hstr(ca[i] * (1 - t) + cb[i] * t for i in range(3))


def rgba(c, a):
    r, g, b = hx(c)
    return 'rgba(%d, %d, %d, %s)' % (r, g, b, a)


def lum(c):
    """WCAG 相对亮度（先线性化再加权），用于计算对比度。"""
    def lin(v):
        v = v / 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = [lin(x) for x in hx(c)]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    """WCAG 对比度，范围 1~21；正文至少 4.5，大号/标题至少 3。"""
    x, y = sorted((lum(a), lum(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


def on_accent(accent):
    """在白/深字里选对比度更高的一个，保证顶栏文字看得清。"""
    return '#ffffff' if contrast(accent, '#ffffff') >= contrast(accent, '#151515') else '#151515'


def vars_for(bg, surface, fg, muted, border, accent, dark):
    """生成一套完整 CSS 变量"""
    v = {}
    v['--bg'], v['--surface'], v['--fg'] = bg, surface, fg
    v['--surface-2'] = mix(surface, bg, .45)
    v['--surface-3'] = mix(surface, border, .55)
    v['--surface-4'] = mix(bg, border, .55)
    v['--fg-2'] = mix(fg, muted, .55)
    v['--fg-3'] = muted
    v['--fg-4'] = mix(muted, bg, .22)
    v['--fg-5'] = mix(muted, bg, .42)
    v['--ph'] = v['--fg-4']
    v['--border'] = border
    v['--border-2'] = mix(border, surface, .6)
    v['--border-3'] = mix(border, fg, .18)
    v['--border-4'] = mix(border, surface, .78)
    v['--accent'], v['--accent-2'] = accent, mix(accent, fg, .18)
    v['--accent-soft'] = mix(accent, surface, .9 if dark else .88)
    v['--accent-soft-border'] = mix(accent, surface, .72)
    v['--accent-ring'] = rgba(accent, .35)
    v['--on-accent'] = on_accent(accent)
    v['--danger'] = '#ff8a8a' if dark else '#c23345'
    v['--danger-2'] = '#e87070' if dark else '#9c2535'
    v['--warn'] = '#e0b072' if dark else '#a3701a'
    v['--topbar-bg'], v['--topbar-fg'] = accent, on_accent(accent)
    v['--tabbar-bg'] = surface
    v['--bubble'] = surface
    v['--bubble-mine'] = mix(accent, surface, .78 if dark else .84)
    v['--bubble-fg'] = fg
    v['--bubble-who'] = muted
    v['--bubble-meta'] = v['--fg-4']
    v['--av-fg'] = on_accent(accent)
    v['--pick-bg'] = surface
    v['--pick-border'] = v['--border-3']
    v['--pick-on'] = accent
    v['--up-bg'] = v['--accent-soft']
    v['--up-fg'] = mix(accent, fg, .25)
    v['--up-track'] = v['--border']
    v['--up-fill'] = accent
    v['--toast-bg'] = rgba(mix(fg, bg, .12), .93)
    v['--toast-fg'] = surface
    v['--badge-bg'] = v['--accent-soft']
    v['--badge-fg'] = mix(accent, fg, .25)
    v['--badge-gray-bg'] = v['--surface-3']
    v['--badge-gray-fg'] = v['--fg-2']
    v['--badge-warn-bg'] = mix('#e0b072', surface, .78 if dark else .82)
    v['--badge-warn-fg'] = '#e0b072' if dark else '#9c6a1a'
    v['--role-4-bg'], v['--role-4-fg'] = v['--badge-warn-bg'], '#ff9a9a' if dark else '#a12a40'
    v['--role-3-bg'], v['--role-3-fg'] = v['--badge-warn-bg'], v['--badge-warn-fg']
    v['--role-2-bg'], v['--role-2-fg'] = v['--accent-soft'], v['--badge-fg']
    v['--role-1-bg'], v['--role-1-fg'] = v['--surface-3'], mix('#4a9a6a', fg, .2 if dark else .1)
    v['--role-0-bg'], v['--role-0-fg'] = v['--surface-3'], v['--fg-2']
    v['--mact-off'] = v['--border-3']
    v['--link'], v['--link-hover'] = accent, mix(accent, fg, .2)
    v['--code-bg'], v['--code-fg'], v['--code-border'] = v['--surface-2'], fg, border
    v['--quote-bg'], v['--quote-border'], v['--quote-fg'] = v['--surface-2'], v['--border-3'], v['--fg-2']
    v['--table-head-bg'] = v['--surface-2']
    v['--table-border'] = border
    v['--table-stripe'] = v['--surface-3']
    v['--table-hover'] = v['--surface-4']
    v['--img-bg'] = v['--surface-4']
    v['--img-border'] = border
    v['--shadow'] = rgba(fg, .28 if dark else .14)
    v['--overlay'] = rgba(fg, .66 if dark else .48)
    v['--scrollbar-thumb'] = v['--border-3']
    v['--scrollbar-thumb-hover'] = mix(v['--border-3'], fg, .2)
    v['--scrollbar-track'] = 'transparent' if not dark else bg
    v['--card-h-bg'] = v['--surface-3']
    v['--card-h-fg'] = mix(accent, fg, .18)
    v['--dot'] = mix(border, bg, .3)
    v['--stroke'] = '1px'
    v['--drop'] = '0 2px 8px %s' % rgba(fg, .18 if dark else .08)
    return v


def block(selector, v):
    lines = ['%s {' % selector]
    for k in v:
        lines.append('  %s: %s;' % (k, v[k]))
    lines.append('}')
    return '\n'.join(lines)


def preview_svg(name, light, dark, accent):
    """预览图：标题条文字按背景对比度自动选黑/白，字号足够大。

    缩略图只有 92x62，原 SVG 320x200 会被压到约 0.29 倍，
    因此标题字放大到 15px（缩放后约 4.3px）并用 bold，且必须保证对比度 >= 4.5。
    """
    bg, surface, fg, border, ac = light[0], light[1], light[2], light[4], light[5]
    d_bg, d_surf, d_border, d_ac = dark[0], dark[1], dark[4], dark[5]
    # 标题条文字色：对比度优先（浅/深主色都可能很亮，不能一律白字）
    ac_on = on_accent(ac)
    d_ac_on = on_accent(d_ac)
    # 条上对比度不足 4.5 时，改用中性深/浅底承托文字，保证可读
    if contrast(ac, ac_on) < 4.5:
        bar, bar_on = (fg, surface)
    else:
        bar, bar_on = (ac, ac_on)
    if contrast(d_ac, d_ac_on) < 4.5:
        d_bar, d_bar_on = (d_surf, dark[2])
    else:
        d_bar, d_bar_on = (d_ac, d_ac_on)
    return '''<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
<rect width="320" height="200" fill="{bg}"/>
<rect x="10" y="10" width="146" height="180" rx="9" fill="{surface}" stroke="{border}" stroke-width="1"/>
<rect x="10" y="10" width="146" height="30" rx="9" fill="{bar}"/>
<text x="20" y="31" font-family="Arial,sans-serif" font-size="15" font-weight="bold" fill="{bar_on}">{name}</text>
<rect x="20" y="50" width="104" height="18" rx="6" fill="{border}" opacity=".4"/>
<rect x="20" y="76" width="112" height="22" rx="6" fill="{surface}" stroke="{border}"/>
<rect x="34" y="114" width="98" height="22" rx="6" fill="{ac}" opacity=".55"/>
<rect x="166" y="10" width="144" height="180" rx="9" fill="{d_bg}" stroke="{d_border}" stroke-width="1"/>
<rect x="166" y="10" width="144" height="30" rx="9" fill="{d_bar}"/>
<text x="176" y="31" font-family="Arial,sans-serif" font-size="15" font-weight="bold" fill="{d_bar_on}">{name}</text>
<rect x="176" y="50" width="102" height="18" rx="6" fill="{d_border}" opacity=".5"/>
<rect x="176" y="76" width="118" height="22" rx="6" fill="{d_surf}" stroke="{d_border}"/>
<rect x="190" y="114" width="106" height="22" rx="6" fill="{d_ac}" opacity=".7"/>
</svg>
'''.format(name=name, bg=bg, surface=surface, border=border, ac=ac,
           bar=bar, bar_on=bar_on,
           d_bg=d_bg, d_surf=d_surf, d_border=d_border, d_ac=d_ac,
           d_bar=d_bar, d_bar_on=d_bar_on)


def main():
    for sid, name, radius, font, light, dark in SKINS:
        d = os.path.join(BASE, sid)
        os.makedirs(d, exist_ok=True)
        lv = vars_for(*light, dark=False)
        dv = vars_for(*dark, dark=True)
        css = ('/* %s 皮肤 —— 浅色/深色两套同色系配色，深色不是调亮度。\n'
               ' * 配色克制：一个主色 + 中性面，避免同屏堆砌多种颜色。\n'
               ' * 字体/圆角体现原风格：%s / %dpx。\n */\n' % (name, font, radius))
        css += ':root {\n  color-scheme: light;\n'
        css += ''.join('  %s: %s;\n' % (k, v) for k, v in lv.items())
        css += '}\n\n'
        css += ':root[data-theme="dark"] {\n  color-scheme: dark;\n'
        css += ''.join('  %s: %s;\n' % (k, v) for k, v in dv.items())
        css += '}\n\n'
        css += ('/* 结构特征：圆角与字体（只对本皮肤生效） */\n'
                'html[data-skin="%s"] .card,\n'
                'html[data-skin="%s"] .msg-box,\n'
                'html[data-skin="%s"] .inp,\n'
                'html[data-skin="%s"] input[type=text],\n'
                'html[data-skin="%s"] textarea { border-radius: %dpx; }\n'
                'html[data-skin="%s"] body { font-family: %s; }\n'
                % (sid, sid, sid, sid, sid, radius, sid, font))
        open(os.path.join(d, 'skin.css'), 'w', encoding='utf-8').write(css)
        mf = {
            'id': sid, 'name': name, 'version': '1.0.0', 'author': '系统内置',
            'description': '参考 chat 系列 12 风格：%s；浅深两套同色系配色' % name,
            'entry': 'skin.css', 'preview': 'preview.svg'
        }
        open(os.path.join(d, 'manifest.json'), 'w', encoding='utf-8').write(
            json.dumps(mf, ensure_ascii=False, indent=2) + '\n')
        open(os.path.join(d, 'preview.svg'), 'w', encoding='utf-8').write(
            preview_svg(name.split()[0], light, dark, light[5]))
        print('generated', sid, name)


if __name__ == '__main__':
    main()
