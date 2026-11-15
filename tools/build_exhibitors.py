#!/usr/bin/env python3
"""Exhibitor info for booth pop-ups.

usage: build_exhibitors.py [--orgs-html organizations.html] tools/src/exhibitors.json WWW

tools/src/exhibitors.json is the curated source: org id -> {name, booths, url, summary}.
Summaries are hand-written (< 50 words). With --orgs-html (the conference's /organizations/
page), names, booths and new exhibitors are merged in first: existing summaries and URLs are
kept, new exhibitors get their conference URL and a trimmed conference description
("auto": true marks them for a proper rewrite).

Writes WWW/data/exhibitors.json (booths missing from WWW/data/map.json are skipped):
  {"booths": {booth location id: [org id, ...]},
   "orgs": {org id: {"n": name, "u": url|null, "d": summary, "g": 1 if WWW/logos/<id>.webp}}}
"""
import html, json, os, re, sys


def parse_orgs(path):
    s = open(path, encoding="utf-8").read()
    out = {}
    for b in re.split(r'<div class="(?:exhibitors )?institution(?: presenters)?">', s):
        if "institution-exhibitor" not in b:
            continue
        m = re.search(r'data-organization-id="(org\d+)" data-organization-name="([^"]*)"', b)
        if not m:
            continue

        def sec(h):
            mm = re.search(r"exhibitor-header %s'>[^<]*</div>(.*?)</div>" % h, b, re.S)
            if not mm:
                return None
            return re.sub(r"\s+", " ", html.unescape(re.sub("<[^>]+>", " ", mm.group(1)))).strip()

        w = re.search(r'exhibitor-link">\s*<a href="([^"]+)"', b)
        url = html.unescape(w.group(1)).strip() if w else None
        if url and not re.match(r"https?://[^/\s,]+\.[a-z]{2,}", url, re.I):
            url = None
        out[m.group(1)] = dict(name=html.unescape(m.group(2)), booths=re.findall(r"location=(b[^'\"&]+)", b),
                               desc=sec("note-header"), url=url)
    return out


def trim(desc, max_words=45):
    words = (desc or "").split()
    if len(words) <= max_words:
        return " ".join(words)
    cut = " ".join(words[:max_words])
    end = max(cut.rfind(". "), cut.rfind("! "))
    return cut[: end + 1] if end > 80 else cut.rstrip(",;:") + "..."


def main():
    args = sys.argv[1:]
    orgs_html = None
    if args[0] == "--orgs-html":
        orgs_html, args = args[1], args[2:]
    src, www = args
    ex = json.load(open(src, encoding="utf-8"))

    if orgs_html:
        fresh = {k: v for k, v in parse_orgs(orgs_html).items() if v["booths"]}
        merged = {}
        for k, v in fresh.items():
            old = ex.get(k)
            if old:
                merged[k] = {**old, "name": v["name"], "booths": v["booths"]}
            else:
                merged[k] = dict(name=v["name"], booths=v["booths"], url=v["url"],
                                 summary=trim(v["desc"]), auto=True)
                print("new exhibitor (summary needs a rewrite):", v["name"], file=sys.stderr)
        for k in ex.keys() - fresh.keys():
            print("dropped exhibitor:", ex[k]["name"], file=sys.stderr)
        ex = dict(sorted(merged.items(), key=lambda kv: kv[1]["name"].lower()))
        with open(src, "w", encoding="utf-8") as f:
            json.dump(ex, f, indent=1, ensure_ascii=False)
            f.write("\n")

    on_map = {l["id"] for l in json.load(open(os.path.join(www, "data", "map.json")))["locations"]}
    booths, orgs = {}, {}
    for k, v in ex.items():
        url = v.get("url")
        if url and url.startswith("http://"):
            url = "https://" + url[7:]  # the native bridge only opens https links
        o = {"n": v["name"], "u": url, "d": v.get("summary") or ""}
        if os.path.exists(os.path.join(www, "logos", f"{k}.webp")):
            o["g"] = 1
        orgs[k] = o
        for b in v["booths"]:
            b = b.replace(" ", "")  # "b 1800" -> "b1800"
            if b in on_map:
                booths.setdefault(b, []).append(k)
            else:
                print(f"booth {b} ({v['name']}) is not on the venue map; skipped", file=sys.stderr)
    os.makedirs(os.path.join(www, "data"), exist_ok=True)
    with open(os.path.join(www, "data", "exhibitors.json"), "w", encoding="utf-8") as f:
        json.dump({"booths": booths, "orgs": orgs}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"exhibitors.json: {len(orgs)} exhibitors, {len(booths)} booths, "
          f"{sum(1 for o in orgs.values() if o.get('g'))} logos", file=sys.stderr)


if __name__ == "__main__":
    main()
