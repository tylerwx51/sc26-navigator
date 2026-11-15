// Unit tests for the shared web logic. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const C = require("../app/src/main/assets/www/js/core.js");
const WWW = new URL("../app/src/main/assets/www/", import.meta.url);
const sched = JSON.parse(readFileSync(new URL("data/schedule.json", WWW)));
const map = JSON.parse(readFileSync(new URL("data/map.json", WWW)));
const sessions = C.prepare(sched.sessions);

test("bundled data is sane", () => {
  assert.ok(sessions.length > 300, "expected the full program");
  const locIds = new Set(map.locations.map((l) => l.id));
  const mapped = sessions.filter((s) => s.loc);
  assert.ok(mapped.length / sessions.length > 0.95);
  for (const s of mapped) assert.ok(locIds.has(s.loc), `unknown loc ${s.loc}`);
  for (const L of map.layers) assert.ok(readFileSync(new URL(L.file, WWW)).length > 1000, L.file);
  assert.equal(new Set(sessions.map((s) => s.id)).size, sessions.length, "ids unique");
});

test("venue-local half-day blocks", () => {
  // 2026-11-17 09:15 CST == 15:15Z
  const b = C.blockAt(Date.parse("2026-11-17T15:15:00Z"));
  assert.equal(b.key, "2026-11-17-AM");
  assert.equal(new Date(b.start).toISOString(), "2026-11-17T06:00:00.000Z");
  assert.equal(new Date(b.end).toISOString(), "2026-11-17T18:00:00.000Z");
  assert.equal(b.label, "Tue AM");
  const n = C.nextBlock(b);
  assert.equal(n.key, "2026-11-17-PM");
  assert.equal(new Date(n.end).toISOString(), "2026-11-18T06:00:00.000Z");
  // 23:30 CST Tuesday is still Tuesday PM (UTC already Wednesday)
  assert.equal(C.blockAt(Date.parse("2026-11-18T05:30:00Z")).key, "2026-11-17-PM");
});

test("upcoming block skips empty half-days", () => {
  const fake = C.prepare([
    { id: "a", title: "A", start: "2026-11-15T14:30:00Z", end: "2026-11-15T16:00:00Z" }, // Sun AM
    { id: "b", title: "B", start: "2026-11-16T20:00:00Z", end: "2026-11-16T21:00:00Z" }, // Mon PM
  ]);
  // Sunday 10am: next block with events is Monday PM (Sun PM, Mon AM empty)
  const up = C.upcomingBlock(fake, Date.parse("2026-11-15T16:00:00Z"));
  assert.equal(up.key, "2026-11-16-PM");
  // before the conference: first block with events
  assert.equal(C.upcomingBlock(fake, Date.parse("2026-11-14T22:00:00Z")).key, "2026-11-15-AM");
});

test("filters: checked + block combine", () => {
  const tueAM = C.blockAt(Date.parse("2026-11-17T15:00:00Z"));
  const inBlock = C.filterSessions(sessions, { scope: "all", block: tueAM });
  assert.ok(inBlock.length > 5);
  for (const s of inBlock) assert.ok(s.startMs < tueAM.end && s.endMs > tueAM.start);
  const pick = inBlock.slice(0, 2).map((s) => s.id);
  const other = sessions.find((s) => !C.overlaps(s, tueAM.start, tueAM.end));
  const checked = new Set([...pick, other.id]);
  const res = C.filterSessions(sessions, { scope: "checked", checked, block: tueAM });
  assert.deepEqual(res.map((s) => s.id).sort(), pick.sort());
  assert.equal(C.filterSessions(sessions, { scope: "checked", checked }).length, 3);
});

test("search matches speakers and rooms", () => {
  const keynote = C.filterSessions(sessions, { query: "keynote" });
  assert.ok(keynote.length >= 1);
  const room = C.filterSessions(sessions, { query: "W375de" });
  assert.ok(room.every((s) => s.search.includes("w375de")));
});

test("multi-select type filter keeps any checked type; empty means all", () => {
  const picked = ["Paper", "Workshop"];
  const res = C.filterSessions(sessions, { types: picked });
  const expected = sessions.filter((s) => picked.includes(s.type)).length;
  assert.ok(expected > 0);
  assert.equal(res.length, expected);
  assert.ok(res.some((s) => s.type === "Paper") && res.some((s) => s.type === "Workshop"));
  assert.equal(C.filterSessions(sessions, { types: [] }).length, sessions.length);
});

test("location search finds booths and rooms by number or name", () => {
  const first = (q) => C.searchLocations(map.locations, q)[0]?.t;
  assert.match(first("252"), /^Booth 252 - /, "exact booth number ranks first");
  assert.match(first("S100"), /^Booth S100 - /);
  assert.match(first("w375"), /^W375/);
  assert.match(first("375"), /^W375/, "room number without the hall letter");
  assert.match(first("nvidia"), /NVIDIA/i, "exhibitor name");
  assert.ok(C.searchLocations(map.locations, "booth 18").every((l) => /booth/i.test(l.t) && l.t.includes("18")));
  assert.deepEqual(C.searchLocations(map.locations, "  "), []);
});

test("conflicts ignore all-day items", () => {
  const list = C.prepare([
    { id: "x", title: "x", start: "2026-11-17T16:00:00Z", end: "2026-11-17T17:00:00Z" },
    { id: "y", title: "y", start: "2026-11-17T16:30:00Z", end: "2026-11-17T17:30:00Z" },
    { id: "z", title: "exhibits", start: "2026-11-17T15:00:00Z", end: "2026-11-17T24:00:00Z" },
  ]);
  assert.deepEqual([...C.conflicts(list)].sort(), ["x", "y"]);
});

test("georeference round-trips and lands rooms in the right place", () => {
  const L = map.layers.find((l) => l.id === "west3");
  const p = C.svgToGeo(L.geo, 400, 500);
  const q = C.geoToSvg(L.geo, p.lat, p.lon);
  assert.ok(Math.abs(q.x - 400) < 1e-6 && Math.abs(q.y - 500) < 1e-6);
  // plan is drawn south-up: larger y is further north
  assert.ok(C.svgToGeo(L.geo, 400, 900).lat > C.svgToGeo(L.geo, 400, 100).lat);
  // scale ~0.45 m per SVG unit
  assert.ok(Math.abs(C.metresPerUnit(L.geo) - 0.456) < 0.02);
  // McCormick Place West Building centroid (OSM) is inside the west layers
  const ids = C.layersContaining(map.layers, 41.8506, -87.6203).map((l) => l.id);
  assert.ok(ids.includes("west3") && ids.includes("West1"), ids.join());
  // Downtown Chicago (Millennium Park) is in none of them
  assert.equal(C.layersContaining(map.layers, 41.8826, -87.6226).length, 0);
  // Lakeside Center is placed on the lakeside layer
  assert.ok(C.layersContaining(map.layers, 41.8531, -87.6123).some((l) => l.id === "lakeside3"));
});

test("floor connectors: icons extracted from every plan, portals valid", () => {
  const conn = JSON.parse(readFileSync(new URL("data/connectors.json", WWW)));
  const layerIds = new Set(map.layers.map((l) => l.id));
  for (const L of map.layers.filter((l) => l.building)) {
    const list = conn.floors[L.id];
    assert.ok(list && list.length >= 5, `connectors on ${L.id}`);
    for (const c of list) {
      assert.ok(["esc", "elev", "stairs"].includes(c.k), c.k);
      assert.ok(c.x > 0 && c.x < L.w && c.y > 0 && c.y < L.h, `${L.id} ${c.x},${c.y} inside the plan`);
    }
  }
  // the escalator bank by West 3 registration / the West 4 escalator are where the plans draw them
  assert.ok(conn.floors.west4.some((c) => c.k === "esc"));
  assert.ok(conn.floors.west3.filter((c) => c.k === "esc").length >= 8);
  for (const p of conn.portals) {
    assert.ok(layerIds.has(p.l) && layerIds.has(p.to), p.id);
    const L = map.layers.find((l) => l.id === p.l);
    assert.ok(p.x > 0 && p.x < L.w && p.y > 0 && p.y < L.h, p.id);
    assert.ok(p.label && p.title && p.text, p.id);
  }
  assert.ok(conn.portals.some((p) => p.l === "west3" && p.to === "south1"), "skybridge");
});

test("floor connectors line up across West floors", () => {
  const conn = JSON.parse(readFileSync(new URL("data/connectors.json", WWW)));
  const kinds = (a, b) => C.floorPairKinds(map.layers, conn.floors, a, b);
  assert.deepEqual(kinds("west3", "west4"), ["esc", "stairs"]);
  assert.ok(kinds("West1", "west3").includes("esc"), "escalators W1 <-> W3");
  assert.ok(!kinds("West1", "west2").includes("esc"), "no escalator landing on W2");
  assert.ok(kinds("West1", "west2").includes("elev") && kinds("west2", "west3").includes("elev"));
  // the West 4 escalator comes down at a West 3 escalator, within georef accuracy
  const e4 = conn.floors.west4.find((c) => c.k === "esc");
  const links = C.connectorLinks(map.layers, conn.floors, "west4", e4);
  const to3 = links.find((l) => l.layer === "west3");
  assert.ok(to3 && to3.same && to3.k === "esc" && to3.m < 20, JSON.stringify(links));
  // other buildings have one mapped floor each: nothing to link to
  assert.deepEqual(C.connectorLinks(map.layers, conn.floors, "south1", conn.floors.south1[0]), []);
  assert.deepEqual(C.connectorLinks(map.layers, conn.floors, "overview", { k: "esc", x: 1, y: 1 }), []);
});

test("exhibitors: booths on the map, https links, short summaries, logos present", () => {
  const ex = JSON.parse(readFileSync(new URL("data/exhibitors.json", WWW)));
  const locIds = new Set(map.locations.map((l) => l.id));
  const booths = map.locations.filter((l) => /^Booth /.test(l.t));
  const covered = booths.filter((l) => ex.booths[l.id]);
  assert.ok(covered.length / booths.length > 0.95, `only ${covered.length}/${booths.length} booths have exhibitor info`);
  for (const [b, ids] of Object.entries(ex.booths)) {
    assert.ok(locIds.has(b), `unknown booth ${b}`);
    for (const id of ids) assert.ok(ex.orgs[id], `booth ${b}: unknown exhibitor ${id}`);
  }
  for (const [id, o] of Object.entries(ex.orgs)) {
    assert.ok(o.n, id);
    // the native bridge only opens https links
    if (o.u) assert.match(o.u, /^https:\/\/[^\s/,]+\.[a-z]{2,}/i, `${o.n}: ${o.u}`);
    assert.ok(o.d && o.d.split(/\s+/).length < 50, `${o.n}: summary missing or 50+ words`);
    if (o.g) assert.ok(readFileSync(new URL(`logos/${id}.webp`, WWW)).length > 100, `${o.n}: logo`);
  }
});

test("session details: bundled for linked sessions, sanitised HTML, https links only", () => {
  const det = JSON.parse(readFileSync(new URL("data/details.json", WWW)));
  const linked = sched.sessions.filter((s) => s.url);
  const have = linked.filter((s) => det[s.sid]);
  assert.ok(have.length > linked.length * 0.9, `${have.length}/${linked.length} linked sessions have details`);
  for (const [sid, d] of Object.entries(det)) {
    for (const tag of d.d.matchAll(/<\/?([a-z0-9]+)([^>]*)>/gi)) {
      assert.ok(["p", "br", "ul", "ol", "li", "b", "i", "em", "strong", "a"].includes(tag[1]), `${sid}: <${tag[1]}>`);
      if (tag[1] === "a" && tag[2]) assert.match(tag[2], /^ href="https:\/\/[^"]+"$/, `${sid}: link`);
      else assert.equal(tag[2], "", `${sid}: attributes on <${tag[1]}>`);
    }
    for (const p of d.p) assert.ok(p.n && p.r && Array.isArray(p.i), `${sid}: person`);
  }
  const key = det.sess248; // keynote
  assert.match(key.d, /Neural operators/);
  assert.ok(key.p.some((p) => p.n === "Animashree Anandkumar" && p.i.includes("California Institute of Technology")));
});
