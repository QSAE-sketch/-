#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成轻聊 Android 客户端的启动图标（不依赖任何外部素材）。
输出：mipmap-{mdpi..xxxhdpi}/ic_launcher.png 与 ic_launcher_round.png
样式：品牌蓝圆角方块 + 白色聊天气泡 + 三个蓝点（呼应站点「💬」视觉）
"""
import os
from PIL import Image, ImageDraw

BRAND = (31, 111, 235, 255)
WHITE = (255, 255, 255, 255)
SS = 4  # 超采样倍数，用于抗锯齿

DENSITIES = {
    'mdpi': 48,
    'hdpi': 72,
    'xhdpi': 96,
    'xxhdpi': 144,
    'xxxhdpi': 192,
}

RES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'src', 'main', 'res')


def draw_bubble(d, S):
    """在边长为 S 的画布上画白色气泡 + 三个蓝点"""
    # 气泡主体：圆角矩形
    d.rounded_rectangle(
        [S * 0.17, S * 0.25, S * 0.83, S * 0.63],
        radius=S * 0.11, fill=WHITE)
    # 气泡尾巴（三角形）
    d.polygon([(S * 0.30, S * 0.60), (S * 0.30, S * 0.79), (S * 0.50, S * 0.61)], fill=WHITE)
    # 三个圆点
    r = S * 0.045
    for cx in (0.36, 0.50, 0.64):
        x, y = S * cx, S * 0.44
        d.ellipse([x - r, y - r, x + r, y + r], fill=BRAND)


def make_icon(size, round_shape):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if round_shape:
        d.ellipse([0, 0, S - 1, S - 1], fill=BRAND)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.22, fill=BRAND)
    draw_bubble(d, S)
    return img.resize((size, size), Image.LANCZOS)


def main():
    for dens, size in DENSITIES.items():
        out = os.path.abspath(os.path.join(RES, 'mipmap-' + dens))
        os.makedirs(out, exist_ok=True)
        make_icon(size, False).save(os.path.join(out, 'ic_launcher.png'))
        make_icon(size, True).save(os.path.join(out, 'ic_launcher_round.png'))
        print('生成 %-8s %dx%d' % (dens, size, size))


if __name__ == '__main__':
    main()
