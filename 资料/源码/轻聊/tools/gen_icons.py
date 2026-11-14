# -*- coding: utf-8 -*-
"""从 WorkBuddy 标志生成全套图标资源（浏览器 favicon / PWA / Android 启动图标）。

原截图只有 22x22 像素，直接放大会糊；这里按实测像素几何做矢量重绘，
再 4 倍超采样降采样，保证 16px 到 512px 都清晰。

图形结构（实测自原图）：
    左上 / 右上 / 左下 = 圆角方块，主蓝 #2688FF
    右下             = 圆形，浅蓝 #74B6FF
    2x2 排布，间隙 = 边长的 9%
"""
from PIL import Image, ImageDraw
import os

OUT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLUE    = (38, 136, 255, 255)    # #2688FF 主蓝
BLUE_LT = (116, 182, 255, 255)  # #74B6FF 浅蓝（右下圆形）
DARK_BG = (38, 38, 38, 255)     # #262626 深色底（与原图底色一致）

# 归一化到 100x100 的布局
UNIT = 100.0
RECTS = [
    (0.0, 0.0, 45.45, 45.45),    # 左上
    (54.55, 0.0, 100.0, 45.45),  # 右上
    (0.0, 54.55, 45.45, 100.0),  # 左下
]
CIRCLE = (75.0, 75.0, 22.73)    # cx, cy, r
CORNER_R = 13.0                 # 圆角半径（归一化单位）


def draw_mark(size, margin_ratio=0.0, ss=4):
    """透明底的蓝色标志。margin_ratio = 四周留白比例（0.26 = 内容占 48%）。"""
    S = size * ss
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    inner = S * (1.0 - margin_ratio * 2)
    off = (S - inner) / 2.0
    k = inner / UNIT

    def px(v):
        return off + v * k

    for (x0, y0, x1, y1) in RECTS:
        d.rounded_rectangle([px(x0), px(y0), px(x1), px(y1)],
                            radius=CORNER_R * k, fill=BLUE)
    cx, cy, r = CIRCLE
    d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], fill=BLUE_LT)
    return img.resize((size, size), Image.LANCZOS)


def draw_app_icon(size, radius_ratio=0.22, ss=4):
    """应用图标形态：深色圆角方块底 + 居中蓝色标志。"""
    S = size * ss
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * radius_ratio), fill=DARK_BG)
    img.alpha_composite(draw_mark(S, margin_ratio=0.26, ss=ss))
    return img.resize((size, size), Image.LANCZOS)


def draw_round_icon(size, ss=4):
    """圆形图标（Android roundIcon）。"""
    S = size * ss
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([0, 0, S - 1, S - 1], fill=DARK_BG)
    img.alpha_composite(draw_mark(S, margin_ratio=0.26, ss=ss))
    return img.resize((size, size), Image.LANCZOS)


pub = os.path.join(OUT, 'public')
os.makedirs(pub, exist_ok=True)

# ---- 浏览器标签页 / PWA ----
# 用「深色底 + 标记」形态，小尺寸下轮廓清晰，和原图观感一致
for name, sz in [('favicon-16.png', 16), ('favicon-32.png', 32),
                 ('favicon-192.png', 192), ('favicon-512.png', 512)]:
    draw_app_icon(sz).save(os.path.join(pub, name))

draw_app_icon(256).save(os.path.join(pub, 'favicon.ico'), format='ICO',
                        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

draw_app_icon(180).save(os.path.join(pub, 'apple-touch-icon.png'))
draw_app_icon(96).save(os.path.join(pub, 'logo.png'))

# ---- Android 启动图标 ----
DENS = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
res = os.path.join(OUT, 'android', 'app', 'src', 'main', 'res')
for dens, sz in DENS.items():
    folder = os.path.join(res, 'mipmap-' + dens)
    os.makedirs(folder, exist_ok=True)
    draw_app_icon(sz).save(os.path.join(folder, 'ic_launcher.png'))
    draw_round_icon(sz).save(os.path.join(folder, 'ic_launcher_round.png'))

print('图标生成完成')
