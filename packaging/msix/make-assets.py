#!/usr/bin/env python3
"""Draws the visual assets of the MSIX package (Microsoft Store build) from the app icon.

The manifest (AppxManifest.xml) names each asset without a qualifier (`Assets\\Square44x44Logo.png`);
Windows picks the file for the display scale or the icon size through `resources.pri`, which
pack.ps1 builds with MakePri. Written here:

- Square44x44Logo (app list, taskbar, Start): scale-100/125/150/200/400, and targetsize-16 … 256
  plain and `altform-unplated` (taskbar and title bar draw these without a plate) and
  `altform-lightunplated` (light taskbar).
- StoreLogo (Store and installer): scale-100 … 400.
- Square150x150Logo, SmallTile (71x71), LargeTile (310x310), Wide310x150Logo, SplashScreen
  (620x300): the icon centered on a transparent background, scale-100 … 400.

Source: docs/brand/annalo-icon-1024.png (the rounded dark square with the white mark, the same
art as src-tauri/icons). Run from the repository root after changing the icon:

    python3 packaging/msix/make-assets.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs/brand/annalo-icon-1024.png"
OUT = Path(__file__).resolve().parent / "Assets"

SCALES = (100, 125, 150, 200, 400)
TARGET_SIZES = (16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256)

# name: (width, height at scale-100, share of the height the icon fills)
TILES = {
    "Square150x150Logo": (150, 150, 0.56),
    "SmallTile": (71, 71, 0.68),
    "LargeTile": (310, 310, 0.5),
    "Wide310x150Logo": (310, 150, 0.56),
    "SplashScreen": (620, 300, 0.42),
}


def icon(size: int) -> Image.Image:
    return SOURCE_IMAGE.resize((size, size), Image.Resampling.LANCZOS)


def scaled(n: int, scale: int) -> int:
    return round(n * scale / 100)


def save(img: Image.Image, name: str) -> None:
    img.save(OUT / name, optimize=True)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.png"):
        old.unlink()
    for scale in SCALES:
        save(icon(scaled(44, scale)), f"Square44x44Logo.scale-{scale}.png")
        save(icon(scaled(50, scale)), f"StoreLogo.scale-{scale}.png")
        for name, (w, h, share) in TILES.items():
            W, H = scaled(w, scale), scaled(h, scale)
            tile = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            s = round(H * share)
            tile.alpha_composite(icon(s), ((W - s) // 2, (H - s) // 2))
            save(tile, f"{name}.scale-{scale}.png")
    for size in TARGET_SIZES:
        img = icon(size)
        save(img, f"Square44x44Logo.targetsize-{size}.png")
        save(img, f"Square44x44Logo.targetsize-{size}_altform-unplated.png")
        save(img, f"Square44x44Logo.targetsize-{size}_altform-lightunplated.png")
    print(f"{len(list(OUT.glob('*.png')))} assets in {OUT.relative_to(ROOT)}")


SOURCE_IMAGE = Image.open(SOURCE).convert("RGBA")

if __name__ == "__main__":
    main()
