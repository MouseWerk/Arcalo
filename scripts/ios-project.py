#!/usr/bin/env python3
"""Puts Arcalo's iOS files into the Xcode project `cargo tauri ios init` generated (docs/ios.md).

The project in src-tauri/gen/apple is made on the macOS runner (.github/workflows/ios.yml), as
for Arcalo Mail: Tauri's template changes with the CLI, and what Arcalo changes in it lives in
src-tauri/ios, src-tauri/Info.ios.plist and src-tauri/tauri.ios.conf.json. This script

- replaces the app icon and adds the launch screen's mark and color (src-tauri/ios/Assets.xcassets,
  made by scripts/ios-icons.py) and the launch screen (src-tauri/ios/LaunchScreen.storyboard);
- copies the privacy manifest and the permission texts (de, en) into the app's folder;
- makes the app universal (iPhone and iPad, TARGETED_DEVICE_FAMILY 1,2) in project.yml.

Run in src-tauri after `cargo tauri ios init --ci`, then `xcodegen generate` in gen/apple.
"""

import re
import shutil
import sys
from pathlib import Path

TAURI = Path(__file__).resolve().parent.parent / "src-tauri"
OURS = TAURI / "ios"
GEN = TAURI / "gen" / "apple"


def main() -> int:
    if not (GEN / "project.yml").is_file():
        print(f"no generated project in {GEN} (run `cargo tauri ios init --ci` first)", file=sys.stderr)
        return 1
    apps = [d for d in GEN.iterdir() if d.is_dir() and d.name.endswith("_iOS")]
    if len(apps) != 1:
        print(f"expected one *_iOS folder in {GEN}, found {[d.name for d in apps]}", file=sys.stderr)
        return 1
    app = apps[0]

    assets = GEN / "Assets.xcassets"
    for entry in (OURS / "Assets.xcassets").iterdir():
        target = assets / entry.name
        if entry.is_dir():
            shutil.rmtree(target, ignore_errors=True)
            shutil.copytree(entry, target)
        elif not target.exists():
            shutil.copy2(entry, target)
    shutil.copy2(OURS / "LaunchScreen.storyboard", GEN / "LaunchScreen.storyboard")
    shutil.copy2(OURS / "PrivacyInfo.xcprivacy", app / "PrivacyInfo.xcprivacy")
    for lproj in ("de.lproj", "en.lproj"):
        shutil.rmtree(app / lproj, ignore_errors=True)
        shutil.copytree(OURS / lproj, app / lproj)

    spec = GEN / "project.yml"
    text = spec.read_text()
    if "TARGETED_DEVICE_FAMILY" not in text:
        # The app's setting group (PRODUCT_BUNDLE_IDENTIFIER is in it): iPhone and iPad.
        text, n = re.subn(
            r"^(\s+)PRODUCT_BUNDLE_IDENTIFIER: (.+)$",
            lambda m: f'{m.group(0)}\n{m.group(1)}TARGETED_DEVICE_FAMILY: "1,2"',
            text,
            count=1,
            flags=re.M,
        )
        if n != 1:
            print("project.yml: PRODUCT_BUNDLE_IDENTIFIER not found", file=sys.stderr)
            return 1
        spec.write_text(text)
    print(f"iOS files put into {GEN} ({app.name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
