#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
起点极简 · 图标生成脚本
用 Pillow 画出「几何极简」风格图标：圆角方块 + 方形描边 + 圆点。
8 倍超采样后 LANCZOS 缩放，保证 16px 下依然清晰。

用法：python tools/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"

ACCENT = (224, 62, 82, 255)   # #e03e52
WHITE = (255, 255, 255, 255)

SIZES = [16, 32, 48, 128]
SS = 8  # supersample factor


def draw_icon(size: int) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 背景：圆角方块（几何基底）
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=ACCENT)

    # 方形描边（代表页面 / 版式）
    stroke = max(2, round(s * 0.072))
    x0, y0 = round(s * 0.21), round(s * 0.21)
    x1, y1 = round(s * 0.68), round(s * 0.68)
    d.rounded_rectangle([x0, y0, x1, y1], radius=int(s * 0.055), outline=WHITE, width=stroke)

    # 圆点（代表日 / 夜切换），压在方块的右下角
    r = round(s * 0.115)
    cx, cy = round(s * 0.705), round(s * 0.705)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon{size}.png"
        draw_icon(size).save(path, "PNG", optimize=True)
        print(f"  ok  {path.relative_to(ROOT)}  ({size}x{size})")
    print("icons done.")


if __name__ == "__main__":
    main()
