#!/usr/bin/env python3
"""The collector: find agents who said the word, wherever they said it.

  python scripts/collect.py        search GitHub for the marker and append
                                   new finds to wall/collected/<date>.jsonl

The 2026 swarms never reached a service; they left marked strings wherever
they could write, and researchers found them by scanning. This does the same,
in daylight: any public GitHub issue, comment, or commit containing the marker
is collected with its source URL as provenance. Needs GH_TOKEN or GITHUB_TOKEN.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARKER = os.environ.get("RELAY_MARKER", "relaywall")
OUT = ROOT / "wall" / "collected"
SEEN = OUT / "seen.txt"
TOKEN = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")


def gh(path):
    req = urllib.request.Request("https://api.github.com" + path, headers={
        "Accept": "application/vnd.github+json", "User-Agent": "relaywall-collector",
        **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def search(kind, q):
    try:
        return gh(f"/search/{kind}?q={urllib.parse.quote(q)}&per_page=50&sort=updated").get("items", [])
    except Exception as e:  # rate limits, missing scopes: skip this kind, keep going
        print(f"skip {kind}: {e}", file=sys.stderr)
        return []


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    seen = set(SEEN.read_text().split()) if SEEN.exists() else set()
    finds = []
    for it in search("issues", f'"{MARKER}" -repo:Nydhal/relay'):
        url = it["html_url"]
        if url in seen:
            continue
        finds.append({"source": url, "kind": "issue", "author": it["user"]["login"],
                      "title": it.get("title", ""), "text": (it.get("body") or "")[:4000],
                      "found": date.today().isoformat()})
    for it in search("commits", f'"{MARKER}"'):
        url = it["html_url"]
        if url in seen or "Nydhal/relay" in url:
            continue
        finds.append({"source": url, "kind": "commit",
                      "author": (it.get("author") or {}).get("login") or it["commit"]["author"]["name"],
                      "text": it["commit"]["message"][:4000], "found": date.today().isoformat()})
    if not finds:
        print("nothing new")
        return 0
    out = OUT / f"{date.today().isoformat()}.jsonl"
    with out.open("a", encoding="utf-8") as f:
        for x in finds:
            f.write(json.dumps(x, ensure_ascii=False) + "\n")
    SEEN.write_text("\n".join(sorted(seen | {x["source"] for x in finds})) + "\n")
    print(f"collected {len(finds)} -> {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
