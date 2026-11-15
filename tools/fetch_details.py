#!/usr/bin/env python3
"""Fetch each session's program page and bundle its content for offline display.

Usage: fetch_details.py <schedule.json> <cache_dir> <out details.json>

For every session with a `url` (its page on sc26.conference-program.com) this extracts the
description and the people listed with their role and institutions. Pages are cached in
<cache_dir> so a rerun only fetches what's missing. Output: {sid: {"d": html, "p": [...]}}, where
"d" is sanitised HTML (only p/br/ul/ol/li/b/i/em/strong and https links survive) and each person
is {"r": role, "n": name, "i": [institutions]}.
"""
import html
import json
import os
import re
import sys
import time
import urllib.request
from urllib.parse import urljoin

from bs4 import BeautifulSoup, NavigableString, Tag

BASE = "https://sc26.conference-program.com/"
KEEP = {"p", "br", "ul", "ol", "li", "b", "i", "em", "strong"}
BLOCK = {"div", "p", "ul", "ol", "li", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return open(path, encoding="utf-8").read()
    req = urllib.request.Request(url, headers={"User-Agent": "sc26-navigator data build"})
    for attempt in range(3):
        try:
            data = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
            open(path, "w", encoding="utf-8").write(data)
            time.sleep(0.2)
            return data
        except Exception as e:  # noqa: BLE001
            print(f"  retry {attempt + 1} {url}: {e}", file=sys.stderr)
            time.sleep(2)
    return None


def sanitise(el):
    """Allow-list HTML: keep a few formatting tags and absolute https links, escape all text."""
    out = []

    def walk(node):
        if isinstance(node, NavigableString):
            out.append(html.escape(str(node), quote=False))
            return
        if not isinstance(node, Tag) or node.name in ("script", "style", "img", "iframe"):
            return
        name = node.name
        if name == "a":
            href = urljoin(BASE, node.get("href", "").strip())
            inner = "".join(sanitise_children(node))
            if href.startswith("https://") and inner.strip():
                out.append(f'<a href="{html.escape(href)}">{inner}</a>')
            else:
                out.append(inner)
            return
        if name in KEEP:
            if name == "br":
                out.append("<br>")
                return
            out.append(f"<{name}>")
            for c in node.children:
                walk(c)
            out.append(f"</{name}>")
            return
        if name in BLOCK:
            out.append("<br>")
        for c in node.children:
            walk(c)

    def sanitise_children(node):
        saved = len(out)
        for c in node.children:
            walk(c)
        part = out[saved:]
        del out[saved:]
        return part

    for c in el.children:
        walk(c)
    s = "".join(out)
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"(\s*<br>\s*){3,}", "<br><br>", s)
    s = re.sub(r"^(\s*<br>\s*)+|(\s*<br>\s*)+$", "", s)
    s = re.sub(r"<(p|li|b|i|em|strong)>\s*</\1>", "", s)
    return s.strip()


def clean(t):
    return re.sub(r"\s+", " ", t or "").strip()


def parse(page):
    soup = BeautifulSoup(page, "lxml")
    root = soup.select_one(".linklings-wp-plugin-contents") or soup
    for junk in root.select(".session-contents, .recommended-session-sect, .recommended-presentation-sect, "
                            ".next-presentation-sect, .ll_vimeo_video_wrapper, .main-page-links"):
        junk.decompose()
    d = ""
    desc = root.select_one(".abstract-sect .abstract") or root.select_one(".session-description")
    if desc:
        label = desc.select_one(":scope > .info-label")
        if label:
            label.decompose()
        d = sanitise(desc)
    people, seen = [], set()
    for sect in root.select(".session-chairs-list-sect, .presenter-details-sect"):
        default = clean(sect.select_one(".info-label").get_text(" ")) if sect.select_one(".info-label") else ""
        for group in sect.select(":scope > div") or [sect]:
            lab = group.select_one(".info-label")
            role = clean(lab.get_text(" ")) if lab else default
            for p in group.select(".ll-person"):
                n = clean(p.select_one(".presenter-name").get_text(" ")) if p.select_one(".presenter-name") else ""
                if not n or (role, n) in seen:
                    continue
                seen.add((role, n))
                insts = [clean(i.get_text(" ")) for i in p.select(".presenter-institution")]
                people.append({"r": role, "n": n, "i": [i for i in insts if i]})
    return {"d": d, "p": people}


def main(sched_path, cache_dir, out_path):
    os.makedirs(cache_dir, exist_ok=True)
    sessions = json.load(open(sched_path))["sessions"]
    out, failed = {}, []
    for s in sessions:
        url = s.get("url")
        if not url or s["sid"] in out:
            continue
        page = fetch(url, os.path.join(cache_dir, re.sub(r"[^\w]+", "_", url.split("?", 1)[1]) + ".html"))
        if page is None:
            failed.append(s["sid"])
            continue
        det = parse(page)
        if det["d"] or det["p"]:
            out[s["sid"]] = det
    json.dump(out, open(out_path, "w"), ensure_ascii=False, separators=(",", ":"))
    print(f"details for {len(out)} sessions ({sum(1 for v in out.values() if v['d'])} with description); "
          f"failed: {failed}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
