#!/usr/bin/env python3
"""The iOS app's icon and launch screen mark from the Arcalo mark (docs/brand/arcalo-mark.svg).

iOS rounds the corners itself and the App Store refuses an icon with transparency, so the icon is
the full square of the brand icon's dark gradient with the white mark, without the rounded
corners of docs/brand/arcalo-icon.svg. One 1024 px image serves every size (Xcode 14 and later).
The launch screen shows the mark alone, in the text color of the app's light and dark theme.

Run from the repository root after the mark changes; the output is committed:

    python3 scripts/ios-icons.py

Needs Pillow.
"""

import json
import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MARK = ROOT / "docs/brand/arcalo-mark.svg"
OUT = ROOT / "src-tauri/ios/Assets.xcassets"
SIZE = 1024
# Supersampling for smooth edges.
SCALE = 4
# The gradient of docs/brand/arcalo-icon.svg (top left to bottom right).
TOP = (0x23, 0x25, 0x2D)
BOTTOM = (0x0E, 0x0F, 0x12)
# The mark's place in the icon, as in docs/brand/arcalo-icon.svg: translate(172 172) scale(0.68).
OFFSET = 172
FACTOR = 0.68
# The text colors of the light and dark theme (ui/src/styles/tokens.css, --text).
INK_LIGHT = (0x18, 0x18, 0x1B)
INK_DARK = (0xEC, 0xEC, 0xEF)


def mark_polygons() -> list[list[tuple[float, float]]]:
    """The mark's outline and its hole (viewBox 0 0 1000 1000)."""
    d = re.search(r'\sd="([^"]+)"', MARK.read_text()).group(1)
    polys = []
    for part in d.split("Z"):
        pts = [(float(x), float(y)) for x, y in re.findall(r"([\d.]+),([\d.]+)", part)]
        if pts:
            polys.append(pts)
    return polys


def mark_mask(side: int, offset: float, factor: float) -> Image.Image:
    """The mark as a mask of `side` px (supersampled), its hole left open."""
    mask = Image.new("L", (side, side), 0)
    draw = ImageDraw.Draw(mask)
    outer, *holes = mark_polygons()
    place = lambda pts: [((offset + x * factor) * SCALE, (offset + y * factor) * SCALE) for x, y in pts]
    draw.polygon(place(outer), fill=255)
    for hole in holes:
        draw.polygon(place(hole), fill=0)
    return mask


def icon() -> Image.Image:
    big = SIZE * SCALE
    img = Image.new("RGB", (big, big))
    # The diagonal gradient, row by row (t = (x + y) / 2).
    line = Image.new("RGB", (2 * big, 1))
    lp = line.load()
    for i in range(2 * big):
        t = i / (2 * big - 1)
        lp[i, 0] = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
    for y in range(big):
        img.paste(line.crop((y, 0, y + big, 1)), (0, y))
    img.paste((255, 255, 255), (0, 0), mark_mask(big, OFFSET, FACTOR))
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def launch_mark(color) -> Image.Image:
    """The mark alone on a transparent square (300 pt at @3x)."""
    side = 900
    big = side * SCALE
    img = Image.new("RGBA", (big, big), color + (0,))
    img.putalpha(mark_mask(big, 0, side / 1000))
    return img.resize((side, side), Image.LANCZOS)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def main() -> None:
    info = {"author": "xcode", "version": 1}
    write_json(OUT / "Contents.json", {"info": info})
    appicon = OUT / "AppIcon.appiconset"
    appicon.mkdir(parents=True, exist_ok=True)
    icon().save(appicon / "AppIcon-1024.png", optimize=True)
    write_json(
        appicon / "Contents.json",
        {"images": [{"filename": "AppIcon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}], "info": info},
    )
    mark = OUT / "LaunchMark.imageset"
    mark.mkdir(parents=True, exist_ok=True)
    launch_mark(INK_LIGHT).save(mark / "LaunchMark.png", optimize=True)
    launch_mark(INK_DARK).save(mark / "LaunchMark-dark.png", optimize=True)
    dark = [{"appearance": "luminosity", "value": "dark"}]
    write_json(
        mark / "Contents.json",
        {
            "images": [
                {"filename": "LaunchMark.png", "idiom": "universal", "scale": "3x"},
                {"appearances": dark, "filename": "LaunchMark-dark.png", "idiom": "universal", "scale": "3x"},
            ],
            "info": info,
        },
    )
    # The launch screen's background: the app's --bg-app of the light and dark theme.
    color = lambda r, g, b: {"color-space": "srgb", "components": {"alpha": "1.000", "red": f"0x{r:02X}", "green": f"0x{g:02X}", "blue": f"0x{b:02X}"}}
    write_json(
        OUT / "LaunchBackground.colorset/Contents.json",
        {
            "colors": [
                {"color": color(0xF4, 0xF4, 0xF5), "idiom": "universal"},
                {"appearances": dark, "color": color(0x0E, 0x0F, 0x11), "idiom": "universal"},
            ],
            "info": info,
        },
    )


if __name__ == "__main__":
    main()
