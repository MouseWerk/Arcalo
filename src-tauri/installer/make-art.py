#!/usr/bin/env python3
"""Draws the Windows installer artwork from the Annalo logo (the same outline as ui/public/icon.svg).

NSIS Modern UI wants 24-bit BMPs: the welcome/finish page image (164x314) and the header image
(150x57, right side of the white page header). Drawn at 4x and scaled down for smooth edges.
Run from the repository root after `npm --prefix ui install` (the wordmark uses Inter):

    python3 src-tauri/installer/make-art.py
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
FONT = ROOT / "ui/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"
S = 4  # supersampling

# The logo outline (1000x1000 box), outer shape and the diamond cut-out.
OUTER = [(458.0, 103.4), (491.0, 160.1), (96.3, 842.8), (256.8, 842.8), (305.0, 769.1), (235.1, 769.1), (268.2, 710.6),
         (687.4, 710.6), (760.2, 839.9), (902.7, 839.9), (574.1, 262.0), (535.4, 327.2), (628.0, 486.8), (502.4, 689.8),
         (377.7, 486.8), (574.1, 145.9), (1000.0, 896.6), (722.4, 896.6), (647.8, 769.1), (365.4, 769.1), (289.9, 896.6),
         (0.0, 896.6)]
HOLE = [(502.4, 382.0), (562.8, 486.8), (502.4, 582.2), (441.9, 486.8)]

BG_TOP = (35, 37, 45)  # #23252d, as the app icon
BG_BOTTOM = (14, 15, 18)  # #0e0f12
ACCENT = (99, 102, 241)  # #6366f1, the default accent


def font(size: int, weight: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(FONT), size)
    f.set_variation_by_axes([weight])
    return f


def gradient(w: int, h: int, top, bottom) -> Image.Image:
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            # Diagonal, like the icon's background.
            t = min(1.0, max(0.0, (0.35 * x / w + 0.65 * y / h)))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
    return img


def glow(size, center, radius, color, strength) -> Image.Image:
    """A soft colored light, added on top of the background."""
    layer = Image.new("RGB", size, (0, 0, 0))
    d = ImageDraw.Draw(layer)
    cx, cy = center
    d.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=tuple(round(c * strength) for c in color))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.6))


def draw_logo(img: Image.Image, box, color):
    """The logo mark scaled into `box` (x, y, size), even-odd like the SVG."""
    x0, y0, size = box
    k = size / 1000
    mask = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(mask)
    d.polygon([(x0 + x * k, y0 + y * k) for x, y in OUTER], fill=255)
    d.polygon([(x0 + x * k, y0 + y * k) for x, y in HOLE], fill=0)
    img.paste(Image.new("RGB", img.size, color), (0, 0), mask)


def text_center(d: ImageDraw.ImageDraw, cx: int, y: int, text: str, f, fill):
    w = d.textlength(text, font=f)
    d.text((cx - w / 2, y), text, font=f, fill=fill)


def sidebar() -> Image.Image:
    w, h = 164 * S, 314 * S
    # Dark like the app icon, with a soft accent light behind the mark.
    img = ImageChops.add(gradient(w, h, BG_TOP, BG_BOTTOM), glow((w, h), (w // 2, int(h * 0.30)), int(w * 0.55), ACCENT, 0.55))
    # Mark, wordmark, one quiet line underneath.
    mark = int(w * 0.46)
    draw_logo(img, ((w - mark) // 2, int(h * 0.30) - mark // 2 - 6 * S, mark), (255, 255, 255))
    d = ImageDraw.Draw(img)
    text_center(d, w // 2, int(h * 0.30) + mark // 2 + 6 * S, "Annalo", font(22 * S, 650), (244, 244, 245))
    text_center(d, w // 2, int(h * 0.30) + mark // 2 + 36 * S, "Notizen · Zeit · KI", font(9 * S, 450), (161, 161, 170))
    # A thin accent line at the bottom edge.
    d.rectangle((0, h - 3 * S, w, h), fill=ACCENT)
    return img.resize((164, 314), Image.LANCZOS)


def header() -> Image.Image:
    """Right part of the white page header: the app icon tile, small."""
    w, h = 150 * S, 57 * S
    img = Image.new("RGB", (w, h), (255, 255, 255))
    tile = 40 * S
    x0, y0 = w - tile - 10 * S, (h - tile) // 2
    tile_img = gradient(tile, tile, BG_TOP, BG_BOTTOM)
    m = Image.new("L", (tile, tile), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, tile - 1, tile - 1), radius=int(tile * 0.223), fill=255)
    img.paste(tile_img, (x0, y0), m)
    mark = int(tile * 0.68)
    draw_logo(img, (x0 + (tile - mark) // 2, y0 + (tile - mark) // 2 - int(mark * 0.02), mark), (255, 255, 255))
    return img.resize((150, 57), Image.LANCZOS)


if __name__ == "__main__":
    sidebar().save(OUT / "sidebar.bmp")
    header().save(OUT / "header.bmp")
    print("wrote", OUT / "sidebar.bmp", OUT / "header.bmp")
