#!/usr/bin/env python3
"""生成飞牛应用图标（ICON.PNG 64x64 / ICON_256.PNG 256x256）。

设计：深色圆角方块 + 抖音双色错位播放三角（青 #25F4EE / 红 #FE2C55）+ 白色主三角。
纯几何绘制、4 倍超采样后缩放，边缘干净。改图标只要改这里的常量再跑一次：

    <python-env>/Scripts/python.exe fnos/assets/make-icons.py

（需要 Pillow。生成结果会写进 fnos/assets/，打包脚本直接复制它，
 所以日常打包不需要 Pillow。）
"""

import math
import os

from PIL import Image, ImageDraw

BRAND_BG = (14, 14, 18, 255)      # 深色底
CYAN = (37, 244, 238, 255)        # 抖音青
RED = (254, 44, 85, 255)          # 抖音红（与 App 的 --brand 同色）
WHITE = (255, 255, 255, 255)

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SS = 4                            # 超采样倍数


def rounded_bg(size):
    """深色圆角方块（满幅，圆角比例与 iOS 图标接近）"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=BRAND_BG)
    return img


def play_triangle(size, radius_ratio=0.242, dx=0.0, dy=0.0):
    """朝右的等边三角形（内接圆半径 = size * radius_ratio），整体偏移 dx/dy 像素"""
    c = size / 2.0
    r = size * radius_ratio
    pts = []
    for deg in (0, 120, 240):
        a = math.radians(deg)
        pts.append((c + r * math.cos(a) + dx, c + r * math.sin(a) + dy))
    return pts


def build(size):
    s = size * SS
    img = rounded_bg(s)

    off = size * 0.028 * SS          # 双色错位量（按尺寸等比缩放，64px 下也有 2px）
    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)

    ld.polygon(play_triangle(s, dx=-off, dy=-off * 0.85), fill=CYAN)
    ld.polygon(play_triangle(s, dx=off, dy=off * 0.85), fill=RED)
    ld.polygon(play_triangle(s), fill=WHITE)

    img = Image.alpha_composite(img, layer)
    return img.resize((size, size), Image.LANCZOS)


def main():
    for size, name in ((64, "icon-64.png"), (256, "icon-256.png")):
        p = os.path.join(OUT_DIR, name)
        build(size).save(p, "PNG", optimize=True)
        print("已生成", p, size, "x", size)


if __name__ == "__main__":
    main()
