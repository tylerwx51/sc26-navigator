#!/usr/bin/env python3
"""Mirror each session's program page (HTML + its stylesheets, images and fonts) for offline display.

Usage: mirror_pages.py <schedule.json> <cache_dir> <www_dir>

For every session with a `url` (its static page on sc26.conference-program.com) this saves the
page as <www>/site/pages/<sid>.html, unchanged apart from:
  - <script> tags removed (they need the network, the app has none),
  - stylesheets, images and the files CSS url()s point at downloaded under <www>/site/ (same
    path as on the site; other hosts under site/_ext/<host>/) and referenced relatively.
Links are left as they are; the app intercepts clicks. Downloads are cached in <cache_dir> so a
rerun only fetches what's missing. Writes <www>/data/pages.json: list of sids that have a page.
"""
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.request
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup
from PIL import Image

BASE = "https://sc26.conference-program.com/"
HOST = urlparse(BASE).netloc
UA = {"User-Agent": "sc26-navigator data build"}
MAX_BYTES = 40_000
MAX_IMG = 300  # px; pages show presenter photos at 200 px, the originals are up to a few thousand


def fetch(url, cache_dir):
    """bytes of url (cached), or None."""
    path = os.path.join(cache_dir, hashlib.sha1(url.encode()).hexdigest())
    if os.path.exists(path):
        data = open(path, "rb").read()
        return data or None  # empty file = known failure
    for attempt in range(3):
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
            open(path, "wb").write(data)
            time.sleep(0.1)
            return data
        except urllib.error.HTTPError as e:
            if e.code in (403, 404, 410):
                break
            print(f"  retry {attempt + 1} {url}: {e}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"  retry {attempt + 1} {url}: {e}", file=sys.stderr)
        time.sleep(2)
    print(f"  failed {url}", file=sys.stderr)
    open(path, "wb").close()
    return None


def shrink(path):
    """Shrink a heavy image in place (same name and format): cap its size at MAX_IMG px and
    recompress (PNG photos -> 256-colour palette). Presenter photos are 200 px but up to 600 KB."""
    try:
        im = Image.open(path)
        fmt = im.format
        if max(im.size) <= MAX_IMG and os.path.getsize(path) <= MAX_BYTES:
            return
        im.load()
        im.thumbnail((MAX_IMG, MAX_IMG), Image.LANCZOS)
        if fmt == "PNG":
            if im.mode in ("RGBA", "LA") or "transparency" in im.info:
                im = im.convert("RGBA").quantize(256, method=Image.Quantize.FASTOCTREE)
            else:
                im = im.convert("RGB").quantize(256)
            im.save(path, "PNG", optimize=True)
        elif fmt in ("JPEG", "WEBP"):
            im = im.convert("RGB")
            im.save(path, fmt, quality=82, optimize=True)
    except Exception as e:  # noqa: BLE001
        print(f"  can't shrink {path}: {e}", file=sys.stderr)


class Mirror:
    def __init__(self, cache_dir, site_dir):
        self.cache, self.site = cache_dir, site_dir
        self.done = {}  # url -> local path (or None)

    def local_path(self, url):
        u = urlparse(url)
        path = u.path.lstrip("/") or "index"
        if path.endswith("/"):
            path += "index"
        path = re.sub(r"[^\w./@-]", "_", path)
        return os.path.join(self.site, path if u.netloc == HOST else os.path.join("_ext", u.netloc, path))

    def asset(self, url):
        """Download url (and, for CSS, everything it references); return its local path or None."""
        url = url.split("#")[0]
        if url in self.done:
            return self.done[url]
        self.done[url] = None
        if urlparse(url).scheme not in ("http", "https"):
            return None
        data = fetch(url, self.cache)
        if data is None:
            return None
        dest = self.local_path(url)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if dest.endswith(".css"):
            data = self.rewrite_css(data.decode("utf-8", "replace"), url, os.path.dirname(dest)).encode()
        open(dest, "wb").write(data)
        if re.search(r"\.(png|jpe?g|webp)$", dest, re.I):
            shrink(dest)
        self.done[url] = dest
        return dest

    def rel(self, url, base_url, from_dir):
        """Relative reference from from_dir to the mirrored copy of url ('' if unavailable)."""
        if url.strip().startswith("data:"):
            return url
        full = urljoin(base_url, url.strip())
        frag = "#" + full.split("#", 1)[1] if "#" in full else ""
        local = self.asset(full)
        return os.path.relpath(local, from_dir) + frag if local else ""

    def rewrite_css(self, css, css_url, from_dir):
        def sub(m):
            ref = m.group(2)
            if not ref or ref.startswith("data:"):
                return m.group(0)
            return f'url("{self.rel(ref, css_url, from_dir)}")'
        css = re.sub(r"""url\(\s*(['"]?)([^'")]*)\1\s*\)""", sub, css)
        # @import "x.css" without url()
        return re.sub(r"""@import\s+(['"])([^'"]+)\1""",
                      lambda m: f'@import "{self.rel(m.group(2), css_url, from_dir)}"', css)

    def page(self, html, page_url, dest):
        soup = BeautifulSoup(html, "lxml")
        d = os.path.dirname(dest)
        for s in soup.find_all("script"):
            s.decompose()
        for link in soup.find_all("link"):
            rels = {r.lower() for r in link.get("rel", [])}
            if rels & {"stylesheet", "icon", "apple-touch-icon"} and link.get("href"):
                link["href"] = self.rel(link["href"], page_url, d)
            else:
                link.decompose()  # preload/prefetch/alternate/api links: useless offline
        for img in soup.find_all(["img", "source"]):
            for attr in ("srcset", "data-srcset", "sizes"):
                img.attrs.pop(attr, None)
            if img.get("src"):
                img["src"] = self.rel(img["src"], page_url, d)
        for st in soup.find_all("style"):
            st.string = self.rewrite_css(st.get_text(), page_url, d)
        for el in soup.find_all(style=re.compile("url\\(")):
            el["style"] = self.rewrite_css(el["style"], page_url, d)
        os.makedirs(d, exist_ok=True)
        open(dest, "w", encoding="utf-8").write(str(soup))


def main(sched_path, cache_dir, www):
    os.makedirs(cache_dir, exist_ok=True)
    site = os.path.join(www, "site")
    shutil.rmtree(site, ignore_errors=True)
    m = Mirror(cache_dir, site)
    sessions = json.load(open(sched_path))["sessions"]
    have, failed = [], []
    for s in sessions:
        url = s.get("url")
        if not url or s["sid"] in have or s["sid"] in failed:
            continue
        data = fetch(url, cache_dir)
        if data is None:
            failed.append(s["sid"])
            continue
        m.page(data.decode("utf-8", "replace"), url, os.path.join(site, "pages", s["sid"] + ".html"))
        have.append(s["sid"])
    json.dump(sorted(have), open(os.path.join(www, "data", "pages.json"), "w"), separators=(",", ":"))
    assets = sum(1 for v in m.done.values() if v)
    size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(site) for f in fs)
    print(f"{len(have)} pages, {assets} assets, {size / 1e6:.1f} MB; failed pages: {failed}; "
          f"missing assets: {sum(1 for v in m.done.values() if not v)}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
