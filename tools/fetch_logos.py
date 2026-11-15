#!/usr/bin/env python3
"""Fetch a small square logo for each exhibitor from its website.

usage: fetch_logos.py tools/src/exhibitors.json WWW/logos tools/src/logo_sources.json [--only id,id] [--force]

For each exhibitor with a "url", tries (best first): the site's apple-touch-icon / largest
<link rel=icon> (PNG, ICO or SVG), /apple-touch-icon.png, /favicon.ico, and finally Google's
favicon service. The best image that is at least 32 px is padded to a square and saved as a
96 px WebP: out_dir/<id>.webp. Records id -> image URL used (null = none found) in the
sources file. Existing logos are kept unless --force. Run it inside `nix develop`.
Network is only needed when regenerating; the app bundles the results.
"""
import io, json, os, re, socket, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from PIL import Image

SIZE = 96
# placeholder icons served by sites that never set their own, as 8x8 average hashes on white:
# WordPress "W" (grey and blue variants), a blank-page icon; Wix's default favicon by URL
GENERIC_HASHES = [0x187C3CB7D75A5A18, 0x3C7ED995D7C36E3C, 0x00C2C0C4DFD0C041]
GENERIC_URLS = ("parastorage.com/client/pfavico", "wp-includes/images/w-logo")
UA = "Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"


def get(url, limit=4_000_000, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.geturl(), r.headers.get("Content-Type", ""), r.read(limit)
        except urllib.error.URLError as e:
            # flaky resolvers: retry DNS failures with backoff; real HTTP errors fail at once
            if isinstance(e, urllib.error.HTTPError) or not isinstance(e.reason, socket.gaierror) or attempt == 4:
                raise
            time.sleep(1.5 * 2 ** attempt)


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.icons = []  # (rel, sizes, href)
        self.base = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "base" and a.get("href"):
            self.base = a["href"]
        if tag == "link" and a.get("href"):
            rel = (a.get("rel") or "").lower()
            if "icon" in rel:
                self.icons.append((rel, (a.get("sizes") or "").lower(), a["href"]))


def decode(data, ctype, url):
    """bytes -> RGBA PIL image (largest frame), or None."""
    if b"<svg" in data[:2000] or "svg" in ctype or url.lower().split("?")[0].endswith(".svg"):
        try:
            png = subprocess.run(["rsvg-convert", "-w", str(SIZE * 2), "-h", str(SIZE * 2), "-a"],
                                 input=data, capture_output=True, timeout=20, check=True).stdout
            return Image.open(io.BytesIO(png)).convert("RGBA")
        except Exception:
            return None
    try:
        im = Image.open(io.BytesIO(data))
        if im.format == "ICO":
            best = max(im.info.get("sizes", {im.size}), key=lambda s: s[0] * s[1])
            im = im.ico.getimage(best)
        im.load()
        return im.convert("RGBA")
    except Exception:
        return None


def candidates(site):
    out = []
    try:
        final, ctype, html = get(site, limit=1_500_000)
        p = Links()
        p.feed(html.decode("utf-8", "replace"))
        base = urllib.parse.urljoin(final, p.base) if p.base else final

        def score(icon):
            rel, sizes, href = icon
            n = max([int(m) for m in re.findall(r"(\d+)x\d+", sizes)] or [0])
            if href.lower().split("?")[0].endswith(".svg") or sizes == "any":
                n = max(n, 150)
            return (n + (60 if "apple-touch" in rel else 0))

        for icon in sorted(p.icons, key=score, reverse=True):
            if not icon[2].startswith("data:"):
                out.append(urllib.parse.urljoin(base, icon[2]))
        root = urllib.parse.urljoin(final, "/")
    except Exception:
        root = urllib.parse.urljoin(site, "/")
    out += [root + "apple-touch-icon.png", root + "favicon.ico"]
    host = urllib.parse.urlparse(site).hostname or ""
    bare = host[4:] if host.startswith("www.") else host
    if bare != host:  # some sites only serve icons on the bare domain
        out += [f"https://{bare}/apple-touch-icon.png", f"https://{bare}/favicon.ico"]
    # icon services answer 404 (an HTTPError, so skipped) for domains they don't know
    out += [f"https://www.google.com/s2/favicons?domain={bare}&sz=128",
            f"https://icons.duckduckgo.com/ip3/{bare}.ico"]
    # sub-sites (hpc.utdallas.edu, lab pages): fall back to the parent organisation's icon
    labels = bare.split(".")
    keep = 3 if len(labels) > 2 and labels[-2] in ("ac", "co", "com", "edu", "or", "gov", "go", "ne") else 2
    parent = ".".join(labels[-keep:])
    if parent != bare:
        out += [f"https://www.{parent}/apple-touch-icon.png",
                f"https://www.google.com/s2/favicons?domain={parent}&sz=128",
                f"https://icons.duckduckgo.com/ip3/{parent}.ico"]
    seen, res = set(), []
    for u in out:
        if u not in seen:
            seen.add(u); res.append(u)
    return res


def ahash(im):
    bg = Image.new("RGBA", im.size, "white")
    bg.alpha_composite(im)
    px = list(bg.convert("L").resize((8, 8), Image.LANCZOS).getdata())
    avg = sum(px) / 64
    return sum(1 << (63 - i) for i, p in enumerate(px) if p < avg)


def is_generic(url, im):
    if any(g in url for g in GENERIC_URLS):
        return True
    h = ahash(im)
    if h == 0:  # flat: nothing darker than average, i.e. blank or white-on-white
        return True
    return any(bin(h ^ g).count("1") <= 6 for g in GENERIC_HASHES)


def light_on_clear(im):
    """True for a white/very light logo on a transparent background (invisible on the white tile)."""
    px = [p for p in im.convert("RGBA").resize((32, 32)).getdata() if p[3] > 128]
    if not px or len(px) > 0.95 * 1024:
        return False
    return sum(0.299 * r + 0.587 * g + 0.114 * b for r, g, b, _ in px) / len(px) > 215


def fetch_one(oid, site, out_dir):
    best = None
    for u in candidates(site):
        try:
            final, ctype, data = get(u)
        except Exception:
            continue
        im = decode(data, ctype, final)
        if im is None or min(im.size) < 16 or not im.getbbox() or is_generic(final, im):
            continue
        # list is best-first: keep the largest image seen, stop at the first one that's big enough
        if best is None or min(im.size) > min(best[1].size):
            best = (u, im)
        if min(im.size) >= 64:
            break
    if not best:
        return oid, None
    u, im = best
    im = im.crop(im.getbbox())
    w, h = im.size
    side = max(w, h)
    sq = Image.new("RGBA", (side, side), (29, 35, 48, 255) if light_on_clear(im) else (0, 0, 0, 0))
    sq.alpha_composite(im, ((side - w) // 2, (side - h) // 2))
    # tiny favicons (some sites have nothing bigger) scale up with hard pixel edges instead of blur
    sq = sq.resize((SIZE, SIZE), Image.NEAREST if side < 32 else Image.LANCZOS)
    sq.save(os.path.join(out_dir, f"{oid}.webp"), "WEBP", quality=85, method=6)
    return oid, u


def main():
    src, out_dir, srcf = sys.argv[1], sys.argv[2], sys.argv[3]
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    force = "--force" in sys.argv
    os.makedirs(out_dir, exist_ok=True)
    ex = json.load(open(src))
    sources = json.load(open(srcf)) if os.path.exists(srcf) else {}
    todo = [(k, v["url"]) for k, v in ex.items() if v.get("url")
            and (only is None or k in only)
            and (force or not os.path.exists(os.path.join(out_dir, f"{k}.webp")))]
    print(f"fetching {len(todo)} logos", file=sys.stderr)
    with ThreadPoolExecutor(6) as pool:
        for i, (oid, u) in enumerate(pool.map(lambda t: fetch_one(t[0], t[1], out_dir), todo)):
            # a failed refetch (often just a flaky network) keeps the existing logo and its source
            if u is not None or not os.path.exists(os.path.join(out_dir, f"{oid}.webp")):
                sources[oid] = u
            if u is None:
                print("  no logo:", ex[oid]["name"], ex[oid]["url"], file=sys.stderr)
    json.dump(dict(sorted(sources.items())), open(srcf, "w"), indent=1)
    have = sum(1 for k in ex if os.path.exists(os.path.join(out_dir, f"{k}.webp")))
    print(f"{have}/{len(ex)} exhibitors have a logo", file=sys.stderr)


if __name__ == "__main__":
    main()
