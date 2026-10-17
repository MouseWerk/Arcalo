#!/usr/bin/env python3
"""Checks one report of the iOS simulator check (scripts/ios-smoke.sh, src-tauri/src/mobile/ios_smoke.js).

    ios-smoke-check.py report.json phone|full "iphone portrait"

Fails when the interface is not the expected one (the iPad shows the full app, the iPhone the
phone app), the page overflows sideways, a fixed control sits inside the safe-area insets, or the
console has errors.
"""

import json
import sys


def problems(report: dict, expect: str) -> list[str]:
    out = []
    if "raw" in report:
        return [f"the check did not run: {report['raw'][:300]}"]
    if report.get("ui") != expect:
        out.append(f"shows the {report.get('ui')} app on {report.get('page')}, expected the {expect} app")
    if expect == "full" and not report.get("ribbon"):
        out.append("the full app has no ribbon")
    if report.get("overflowX", 0) > 0:
        out.append(f"overflows sideways by {report['overflowX']} px")
    for c in report.get("insideInsets", []):
        out.append(f"inside the safe-area insets {report.get('inset')}: {c}")
    for e in report.get("errors", []):
        out.append(f"console error: {e}")
    return out


def main() -> int:
    path, expect, label = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(path, encoding="utf-8") as f:
        report = json.load(f)
    found = problems(report, expect)
    vp = report.get("viewport", {})
    print(f"{label}: {report.get('ui')} app, {vp.get('width')}x{vp.get('height')}, insets {report.get('inset')}")
    for p in found:
        print(f"::error title=iOS simulator ({label})::{p}")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
