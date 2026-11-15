/* Pure logic shared by the app and the Node unit tests (no DOM access here). */
(function (root) {
  "use strict";

  const TZ = "America/Chicago";
  const HOUR = 3600e3;

  // ---------- time helpers (venue local time) ----------
  const partsFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  function localParts(ms) {
    const p = {};
    for (const { type, value } of partsFmt.formatToParts(new Date(ms))) p[type] = value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second };
  }

  // offset (ms) of venue local time vs UTC at instant ms
  function tzOffset(ms) {
    const p = localParts(ms);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
  }

  // UTC ms for a venue-local wall-clock time
  function localToUtc(y, m, d, h) {
    const guess = Date.UTC(y, m - 1, d, h);
    let t = guess - tzOffset(guess);
    t = guess - tzOffset(t); // second pass handles DST edges
    return t;
  }

  function ymd(ms) {
    const p = localParts(ms);
    return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  }

  const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
  const wdFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" });

  function fmtTime(ms) { return timeFmt.format(new Date(ms)).replace(" AM", "am").replace(" PM", "pm"); }
  function fmtRange(a, b) { return `${fmtTime(a)} – ${fmtTime(b)}`; }
  function fmtDay(ms) { return dayFmt.format(new Date(ms)); }

  // ---------- half-day blocks ----------
  // A block is a venue-local half day: AM = 00:00–12:00, PM = 12:00–24:00.
  function blockAt(ms) {
    const p = localParts(ms);
    const pm = p.h >= 12;
    const start = localToUtc(p.y, p.m, p.d, pm ? 12 : 0);
    const end = pm ? localToUtc(p.y, p.m, p.d, 24) : localToUtc(p.y, p.m, p.d, 12);
    return makeBlock(start, end, pm);
  }

  function makeBlock(start, end, pm) {
    return {
      key: `${ymd(start)}-${pm ? "PM" : "AM"}`,
      start, end, pm,
      label: `${wdFmt.format(new Date(start))} ${pm ? "PM" : "AM"}`,
      longLabel: `${fmtDay(start)} ${pm ? "afternoon/evening" : "morning"}`,
    };
  }

  function nextBlock(block) { return blockAt(block.end + 1000); }

  function overlaps(s, a, b) { return s.startMs < b && s.endMs > a; }

  function blockHasEvents(sessions, block) { return sessions.some((s) => overlaps(s, block.start, block.end)); }

  // all blocks touched by any session, chronological
  function allBlocks(sessions) {
    if (!sessions.length) return [];
    const first = Math.min(...sessions.map((s) => s.startMs));
    const last = Math.max(...sessions.map((s) => s.endMs));
    const out = [];
    for (let b = blockAt(first); b.start < last; b = nextBlock(b)) {
      if (blockHasEvents(sessions, b)) out.push(b);
      if (out.length > 64) break;
    }
    return out;
  }

  // The block after the current one that actually has events.
  // Before the conference this is the first block with events.
  function upcomingBlock(sessions, now) {
    const cur = blockAt(now);
    for (let b = nextBlock(cur), i = 0; i < 40; b = nextBlock(b), i++) {
      if (blockHasEvents(sessions, b)) return b;
    }
    return null;
  }

  // ---------- data prep / filtering ----------
  function prepare(sessions) {
    for (const s of sessions) {
      s.startMs = Date.parse(s.start);
      s.endMs = Date.parse(s.end);
      s.day = ymd(s.startMs);
      s.search = [s.title, s.room, s.type, ...(s.speakers || []), ...(s.tags || []),
        ...((s.talks || []).flatMap((t) => [t.title, ...(t.speakers || [])]))].join(" \u0001 ").toLowerCase();
    }
    return sessions;
  }

  /**
   * opts: { scope: 'all'|'checked', checked: Set, block: {start,end}|null, type, types, query, day, mappedOnly }
   * types: array of event types to keep (empty/missing = all types)
   */
  function filterSessions(sessions, opts) {
    const q = (opts.query || "").trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    const types = opts.types && opts.types.length ? new Set(opts.types) : null;
    return sessions.filter((s) => {
      if (opts.scope === "checked" && !(opts.checked && opts.checked.has(s.id))) return false;
      if (opts.block && !overlaps(s, opts.block.start, opts.block.end)) return false;
      if (opts.day && s.day !== opts.day) return false;
      if (opts.type && s.type !== opts.type) return false;
      if (types && !types.has(s.type)) return false;
      if (opts.mappedOnly && !s.loc) return false;
      for (const t of terms) if (!s.search.includes(t)) return false;
      return true;
    });
  }

  /**
   * Search map locations (rooms "W375de", booths "Booth 252 - Foo") by number or name.
   * Every query term must appear in the name; results are ranked:
   * exact room/booth number, number prefix, word prefix, then anywhere.
   */
  function locationCode(l) {
    const m = /^Booth\s+(\S+)/i.exec(l.t);
    return (m ? m[1] : l.t.split(/[\s(]/)[0]).toLowerCase();
  }
  function searchLocations(locations, query) {
    const terms = (query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const q = terms.join(" ");
    const out = [];
    for (const l of locations) {
      const hay = l.t.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      const code = locationCode(l), num = code.replace(/^[a-z]+(?=\d)/, "");
      let rank = 3;
      if (code === q || num === q) rank = 0;
      else if (code.startsWith(q) || num.startsWith(q)) rank = 1;
      else if (terms.every((t) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay))) rank = 2;
      out.push({ l, rank });
    }
    out.sort((a, b) => a.rank - b.rank || a.l.t.localeCompare(b.l.t, undefined, { numeric: true }));
    return out.map((r) => r.l);
  }

  function groupBy(arr, keyFn) {
    const m = new Map();
    for (const x of arr) {
      const k = keyFn(x);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return m;
  }

  // Pairs of overlapping checked sessions (for the plan view)
  function conflicts(list) {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
    const ids = new Set();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j].startMs < sorted[i].endMs; j++) {
        // long all-day items (exhibits, posters) don't count as conflicts
        const long = (s) => s.endMs - s.startMs >= 6 * HOUR;
        if (long(sorted[i]) || long(sorted[j])) continue;
        ids.add(sorted[i].id); ids.add(sorted[j].id);
      }
    }
    return ids;
  }

  // ---------- georeferencing ----------
  // affine: lon = a*x + b*y + c ; lat = d*x + e*y + f   (x,y in SVG units)
  function svgToGeo(A, x, y) { return { lon: A[0] * x + A[1] * y + A[2], lat: A[3] * x + A[4] * y + A[5] }; }

  function geoToSvg(A, lat, lon) {
    const [a, b, c, d, e, f] = A;
    const det = a * e - b * d;
    const u = lon - c, v = lat - f;
    return { x: (e * u - b * v) / det, y: (-d * u + a * v) / det };
  }

  // metres per SVG unit for a layer's affine
  function metresPerUnit(A) {
    const k = 111320;
    const lat0 = A[5];
    const dx = Math.hypot(A[0] * k * Math.cos((lat0 * Math.PI) / 180), A[3] * k);
    return dx;
  }

  function distanceM(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Which georeferenced layer frame contains the point (with margin, in SVG units)?
  function layersContaining(layers, lat, lon, margin = 0) {
    return layers.filter((L) => {
      if (!L.geo) return false;
      const p = geoToSvg(L.geo, lat, lon);
      return p.x >= -margin && p.y >= -margin && p.x <= L.w + margin && p.y <= L.h + margin;
    });
  }

  // ---------- floor connections ----------
  // Stairs / escalators / elevators on one floor that line up with the same kind on the other
  // floors of that building (matched by georeferenced position, since each floor plan has its own
  // SVG frame). Returns one entry per other floor: the nearest same-kind connector within maxM
  // metres, else the nearest stairs/elevator within anyM (escalators often skip a level).
  function connectorLinks(layers, floors, layerId, c, opts = {}) {
    const maxM = opts.maxM ?? 30, anyM = opts.anyM ?? 20;
    const L = layers.find((x) => x.id === layerId);
    if (!L || !L.geo || !L.building) return [];
    const g = svgToGeo(L.geo, c.x, c.y);
    const out = [];
    for (const M of layers) {
      if (M.id === layerId || M.building !== L.building || !M.geo) continue;
      let same = null, any = null;
      for (const d of floors[M.id] || []) {
        const h = svgToGeo(M.geo, d.x, d.y);
        const m = distanceM(g.lat, g.lon, h.lat, h.lon);
        if (d.k === c.k) { if (m <= maxM && (!same || m < same.m)) same = { ...d, m }; }
        else if (d.k !== "esc" && m <= anyM && (!any || m < any.m)) any = { ...d, m };
      }
      const best = same || any;
      if (best) out.push({ layer: M.id, k: best.k, x: best.x, y: best.y, m: Math.round(best.m), same: !!same });
    }
    return out;
  }

  // Kinds of connector ("esc", "elev", "stairs") that line up between floors a and b.
  function floorPairKinds(layers, floors, a, b, maxM = 30) {
    const kinds = new Set();
    for (const c of floors[a] || []) {
      if (kinds.has(c.k)) continue;
      if (connectorLinks(layers, floors, a, c, { maxM, anyM: 0 }).some((r) => r.layer === b && r.same)) kinds.add(c.k);
    }
    return ["esc", "elev", "stairs"].filter((k) => kinds.has(k));
  }

  const api = {
    TZ, localParts, tzOffset, localToUtc, ymd, fmtTime, fmtRange, fmtDay,
    blockAt, nextBlock, allBlocks, upcomingBlock, overlaps,
    prepare, filterSessions, searchLocations, groupBy, conflicts,
    svgToGeo, geoToSvg, metresPerUnit, distanceM, layersContaining, connectorLinks, floorPairKinds,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Core = api;
})(typeof window !== "undefined" ? window : globalThis);
