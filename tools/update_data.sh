#!/usr/bin/env bash
# Re-download the SC26 program + venue map and regenerate the bundled offline data.
# Run inside `nix develop`.
set -euo pipefail
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
BASE=https://sc26.conference-program.com
WWW=app/src/main/assets/www

mkdir -p "$WORK/days" "$WORK/svg" "$WWW/data" "$WWW/maps"
for d in 14 15 16 17 18 19 20 21; do
  curl -fsSL -o "$WORK/days/2026-11-$d.html" "$BASE/wp-content/linklings_snippets/wp_program_view_all_2026-11-$d.txt"
done

map_id=$(curl -fsSL "$BASE/map/" | grep -oE 'getMapData\?id=[A-Za-z0-9]+' | head -1 | cut -d= -f2)
curl -fsSL -o tools/src/mapdata.json "https://mapplic.com/getMapData?id=$map_id"
python3 - "$WORK/svg" <<'EOF'
import json, sys, urllib.request
for l in json.load(open("tools/src/mapdata.json"))["layers"]:
    urllib.request.urlretrieve(l["file"], f"{sys.argv[1]}/{l['id']}.svg")
EOF

python3 tools/parse_schedule.py "$WORK/days" tools/src/mapdata.json "$WWW/data/schedule.json"
# each session's program page (description, chairs/presenters) for the offline session pop-up
python3 tools/fetch_details.py "$WWW/data/schedule.json" "$WORK/details" "$WWW/data/details.json"
python3 tools/build_map.py tools/src/mapdata.json "$WORK/svg" tools/src/georef.json "$WWW"
python3 tools/build_connectors.py "$WWW"

# exhibitors: merge names/booths/new exhibitors from the organizations page into the curated
# tools/src/exhibitors.json (hand-written summaries are kept), fetch logos for any that lack one
curl -fsSL -o "$WORK/organizations.html" "$BASE/organizations/"
python3 tools/build_exhibitors.py --orgs-html "$WORK/organizations.html" tools/src/exhibitors.json "$WWW"
python3 tools/fetch_logos.py tools/src/exhibitors.json "$WWW/logos" tools/src/logo_sources.json || true
python3 tools/build_exhibitors.py tools/src/exhibitors.json "$WWW"
