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
