#!/usr/bin/env python3
"""Checks one report of the iOS simulator check (scripts/ios-smoke.sh, src-tauri/src/mobile/ios_smoke.js).

    ios-smoke-check.py report.json phone|full portrait|landscape "iphone portrait"

Fails when the interface is not the expected one (the iPad shows the full app, the iPhone the
phone app), the window is not in the expected orientation, the WebView reaches outside the
window's safe area (the status bar, the notch, the home indicator, the rounded corners), the page
overflows sideways, a fixed control sits inside the page's own safe-area insets, or the console
has errors.
"""

import json
import sys


def problems(report: dict, expect: str, orientation: str) -> list[str]:
    out = []
    if "raw" in report:
        return [f"the check did not run: {report['raw'][:300]}"]
    if report.get("ui") != expect:
        out.append(f"shows the {report.get('ui')} app on {report.get('page')}, expected the {expect} app")
    if expect == "full" and not report.get("ribbon"):
        out.append("the full app has no ribbon")
    native = report.get("native") or {}
    win, ins, web = native.get("window"), native.get("insets"), native.get("webview")
    if not (win and ins and web):
        out.append("no native geometry in the report")
    else:
        if (win["width"] > win["height"]) != (orientation == "landscape"):
            why = report.get("orientationError")
            out.append(f"the window is {win['width']}x{win['height']}, not {orientation}" + (f" ({why})" if why else ""))
        eps = 0.5
        inside = (
            web["x"] >= ins["left"] - eps
            and web["y"] >= ins["top"] - eps
            and web["x"] + web["width"] <= win["width"] - ins["right"] + eps
            and web["y"] + web["height"] <= win["height"] - ins["bottom"] + eps
        )
        if not inside:
            out.append(f"the WebView {web} reaches outside the safe area (insets {ins}, window {win})")
    if report.get("overflowX", 0) > 0:
        out.append(f"overflows sideways by {report['overflowX']} px")
    for c in report.get("insideInsets", []):
        out.append(f"inside the safe-area insets {report.get('inset')}: {c}")
    for e in report.get("errors", []):
        out.append(f"console error: {e}")
    return out


def main() -> int:
    path, expect, orientation, label = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    with open(path, encoding="utf-8") as f:
        report = json.load(f)
    found = problems(report, expect, orientation)
    vp = report.get("viewport", {})
    native = report.get("native") or {}
    print(f"{label}: {report.get('ui')} app, page {vp.get('width')}x{vp.get('height')}, window {native.get('window')}, safe-area insets {native.get('insets')}")
    for p in found:
        print(f"::error title=iOS simulator ({label})::{p}")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
