#!/usr/bin/env python3
"""Build www/data/map.json + copy floor-plan SVGs from the Mapplic export.

Usage: build_map.py <mapdata.json> <svg_dir> <georef.json> <www_dir>
"""
import json
import os
import re
import shutil
import sys

LAYER_ORDER = ["West1", "west2", "west3", "west4", "south1", "lakeside3", "overview"]
SHORT = {"West1": "W1", "west2": "W2", "west3": "W3", "west4": "W4", "south1": "S1", "lakeside3": "L3", "overview": "All"}
BUILDING = {"West1": "west", "west2": "west", "west3": "west", "west4": "west", "south1": "south", "lakeside3": "lakeside"}


def svg_size(path):
    head = open(path, encoding="utf-8").read(600)
    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', head)
    return float(m.group(1)), float(m.group(2))


def main(mapdata_path, svg_dir, georef_path, www):
    md = json.load(open(mapdata_path))
    georef = json.load(open(georef_path))
    os.makedirs(os.path.join(www, "maps"), exist_ok=True)
    layers = []
    by_id = {l["id"]: l for l in md["layers"]}
    sizes = {}
    for lid in LAYER_ORDER:
        src = os.path.join(svg_dir, f"{lid}.svg")
        dst = os.path.join(www, "maps", f"{lid}.svg")
        if os.path.abspath(src) != os.path.abspath(dst):
            shutil.copyfile(src, dst)
        w, h = svg_size(dst)
        sizes[lid] = (w, h)
        layers.append({
            "id": lid,
            "name": by_id[lid]["name"],
            "short": SHORT[lid],
            "building": BUILDING.get(lid),
            "w": w,
            "h": h,
            "file": f"maps/{lid}.svg",
            "geo": georef.get(lid, {}).get("affine"),
        })
    locations = []
    for l in md["locations"]:
        w, h = sizes[l["layer"]]
        locations.append({
            "id": l["id"],
            "t": l["title"],
            "l": l["layer"],
            "x": round(l["coord"][0] * w, 1),
            "y": round(l["coord"][1] * h, 1),
        })
    out = {"layers": layers, "locations": locations, "source": "https://sc26.conference-program.com/map/"}
    json.dump(out, open(os.path.join(www, "data", "map.json"), "w"), separators=(",", ":"))
    print(f"{len(layers)} layers, {len(locations)} locations")


if __name__ == "__main__":
    main(*sys.argv[1:5])
