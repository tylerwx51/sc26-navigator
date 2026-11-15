#!/usr/bin/env python3
"""Convert the SC26 Linklings per-day program snippets into a compact JSON file.

Usage: parse_schedule.py <days_dir> <mapdata.json> <out.json>

The day snippets come from
  https://sc26.conference-program.com/wp-content/linklings_snippets/wp_program_view_all_<date>.txt
(see tools/fetch_data.sh).
"""
import glob
import json
import os
import re
import sys
from urllib.parse import parse_qs, urlparse

from bs4 import BeautifulSoup


def text(el):
    return el.get_text(" ", strip=True) if el else ""


def people(el):
    if not el:
        return []
    out = []
    for p in el.select(".presenter-name"):
        name = re.sub(r"\s+", " ", p.get_text(" ", strip=True))
        if name and name not in out:
            out.append(name)
    return out


# Rooms the program names without a map link, mapped to the closest map location.
LOC_ALIASES = {"Central Concourse": "rCentral-Concourse---HUB"}
REG_ABBREV = re.compile(r"^[A-Z/&]{1,6}$")


def location(row):
    loc = row.select_one(".presentation-location")
    if not loc:
        return "", None
    a = loc.find("a")
    loc_id = None
    if a and a.get("href"):
        q = parse_qs(urlparse(a["href"]).query)
        loc_id = (q.get("location") or [None])[0]
    name = text(loc)
    return name, loc_id or LOC_ALIASES.get(name)


def main(days_dir, mapdata_path, out_path):
    mapdata = json.load(open(mapdata_path))
    known_locs = {l["id"] for l in mapdata["locations"]}

    sessions = {}
    presentations = {}
    for path in sorted(glob.glob(os.path.join(days_dir, "*.html"))):
        soup = BeautifulSoup(open(path, encoding="utf-8").read(), "lxml")
        for row in soup.select("tr.presentation-row"):
            psid = row.get("psid")
            key = f'{psid}@{row.get("s_utc")}'
            if key in sessions:
                continue
            title_el = row.select_one(".presentation-title")
            room_name, loc_id = location(row)
            tags = [text(t) for t in row.select(".ptrack-list .program-track") if text(t)]
            link = title_el.find("a") if title_el else None
            sessions[key] = {
                "id": key,
                "sid": psid,
                "title": text(title_el),
                "type": text(row.select_one(".type-td .event-type-name")) or text(row.select_one(".event-type-name")) or "Other",
                "start": row.get("s_utc"),
                "end": row.get("e_utc"),
                "room": room_name,
                "loc": loc_id if loc_id in known_locs else None,
                "rawLoc": loc_id,
                "tags": [t for t in tags if not REG_ABBREV.match(t)],
                "speakers": people(row.select_one(".presentation-speaker")),
                "url": ("https://sc26.conference-program.com" + link["href"]) if link and link.get("href", "").startswith("/") else None,
            }
        # Talks nested inside sessions (slots-slidedown rows keyed by session id)
        for row in soup.select("tr.agenda-item:not(.presentation-row)"):
            psid, ssid = row.get("psid"), row.get("ssid")
            pkey = f"{psid}/{ssid}/{row.get('s_utc')}"
            if pkey in presentations:
                continue
            title_a = row.select_one(".title-speakers-td > a")
            presentations[pkey] = {
                "sid": psid,
                "title": text(title_a) or text(row.select_one(".title-speakers-td")),
                "start": row.get("s_utc"),
                "end": row.get("e_utc"),
                "speakers": people(row.select_one(".speakers-line")),
            }

    # Attach presentations to the session instance they fall within.
    by_sid = {}
    for s in sessions.values():
        by_sid.setdefault(s["sid"], []).append(s)
    for p in presentations.values():
        cands = by_sid.get(p["sid"], [])
        host = next((s for s in cands if s["start"] <= p["start"] < s["end"]), cands[0] if cands else None)
        if host is not None:
            host.setdefault("talks", []).append({k: p[k] for k in ("title", "start", "end", "speakers")})
    for s in sessions.values():
        if "talks" in s:
            s["talks"].sort(key=lambda t: t["start"])

    out = sorted(sessions.values(), key=lambda s: (s["start"], s["end"], s["title"]))
    for s in out:
        s.pop("rawLoc", None)
    meta = {
        "source": "https://sc26.conference-program.com/",
        "generated": re.search(r'generated="([^"]+)"', open(sorted(glob.glob(os.path.join(days_dir, "*.html")))[0]).read()[:500]).group(1),
        "timezone": "America/Chicago",
    }
    json.dump({"meta": meta, "sessions": out}, open(out_path, "w"), ensure_ascii=False, separators=(",", ":"))
    unmapped = sorted({s["room"] for s in out if not s["loc"]})
    print(f"{len(out)} sessions, {sum(len(s.get('talks', [])) for s in out)} talks; "
          f"{sum(1 for s in out if s['loc'])} mapped; unmapped rooms: {unmapped[:40]}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
