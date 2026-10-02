#!/usr/bin/env python3
"""Mirror an Arcalo release to an internal share or web server (docs/admin/updates.md).

Downloads a release's latest.json and the update files it lists, stores them in DEST and
rewrites each file's URL: to the bare file name (a folder source such as \\\\server\\share\\arcalo
finds the files next to latest.json), or to --base-url plus the file name (a web server).
Signatures are copied unchanged; Arcalo checks every file against its built-in key, so a
mirror can deliver the files but cannot alter them. latest.json is written last, so clients
never see a feed whose files are not there yet.

Examples:
  python3 mirror-release.py --dest \\\\server\\share\\arcalo
  python3 mirror-release.py --tag v1.9.1 --dest /srv/www/arcalo --base-url https://intranet.example/arcalo/
  python3 mirror-release.py --dest D:\\arcalo --platform windows-x86_64 --platform windows-x86_64-nsis

Only the Python 3 standard library is needed. Proxy: the usual HTTPS_PROXY variable.
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request

REPOSITORY = "MouseWerk/Arcalo"


def feed_url(args):
    if args.feed:
        return args.feed
    if args.tag:
        tag = args.tag if args.tag.startswith("v") else f"v{args.tag}"
        return f"https://github.com/{REPOSITORY}/releases/download/{tag}/latest.json"
    return f"https://github.com/{REPOSITORY}/releases/latest/download/latest.json"


def fetch(url, target=None):
    req = urllib.request.Request(url, headers={"User-Agent": "arcalo-mirror"})
    with urllib.request.urlopen(req, timeout=60) as res:
        if target is None:
            return res.read()
        with open(target, "wb") as out:
            shutil.copyfileobj(res, out, 1024 * 1024)
        return None


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dest", required=True, help="folder that receives latest.json and the files")
    p.add_argument("--tag", help="release tag (v1.9.1); default: the latest release")
    p.add_argument("--feed", help="URL of a latest.json to mirror instead of GitHub's")
    p.add_argument("--base-url", help="URL under which DEST is served (web server); default: bare file names (folder source)")
    p.add_argument("--platform", action="append", help="only these platform keys (repeatable), e.g. windows-x86_64")
    p.add_argument("--prune", action="store_true", help="delete files in DEST that the new latest.json no longer lists")
    args = p.parse_args()

    os.makedirs(args.dest, exist_ok=True)
    url = feed_url(args)
    print(f"feed: {url}")
    feed = json.loads(fetch(url).decode("utf-8-sig"))
    platforms = feed.get("platforms") or {}
    if args.platform:
        platforms = {k: v for k, v in platforms.items() if k in set(args.platform)}
    if not platforms:
        sys.exit("no platform entries to mirror")

    names = {}
    for key, entry in sorted(platforms.items()):
        source = urllib.parse.urljoin(url, entry["url"])
        name = os.path.basename(urllib.parse.urlparse(source).path)
        if name not in names:
            target = os.path.join(args.dest, name)
            print(f"  {key}: {name}")
            part = target + ".part"
            fetch(source, part)
            if os.path.getsize(part) == 0:
                sys.exit(f"{name}: empty download")
            os.replace(part, target)
            names[name] = target
        entry["url"] = urllib.parse.urljoin(args.base_url, name) if args.base_url else name
    feed["platforms"] = platforms

    fd, tmp = tempfile.mkstemp(dir=args.dest, prefix=".latest-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as out:
        json.dump(feed, out, indent=2)
    os.replace(tmp, os.path.join(args.dest, "latest.json"))
    print(f"version {feed.get('version')} mirrored to {args.dest}")

    if args.prune:
        keep = set(names) | {"latest.json"}
        for f in os.listdir(args.dest):
            if f not in keep and not f.startswith("."):
                os.remove(os.path.join(args.dest, f))
                print(f"  removed {f}")


if __name__ == "__main__":
    main()
