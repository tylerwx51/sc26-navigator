/* SC26 Navigator UI. Runs inside the Android WebView (window.Native bridge) or a desktop browser. */
(function () {
  "use strict";
  const C = window.Core;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const Native = window.Native || null;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------- state ----------------
  const DEFAULT_STATE = {
    checked: [], view: "schedule", day: null, types: [], query: "",
    mapScope: "all", mapTime: "next", mapBlock: null, layer: null,
  };
  let state = loadState();
  // migrate the old single-select type filter ("type": "Workshop") to the multi-select list
  if (!Array.isArray(state.types)) state.types = [];
  if (state.type) { if (!state.types.length) state.types = [state.type]; state.type = undefined; }
  let checked = new Set(state.checked);
  let sessions = [], byId = new Map(), mapData = null, locById = new Map(), layerById = new Map();
  let nowOverride = null;
  const now = () => nowOverride ?? Date.now();

  function loadState() {
    let raw = null;
    // Native SharedPreferences is the source of truth in the app; localStorage only in a plain browser.
    if (Native && Native.getState) { try { raw = Native.getState(); } catch (e) { /* ignore */ } }
    else { try { raw = localStorage.getItem("sc26state"); } catch (e) { /* ignore */ } }
    try { return Object.assign({}, DEFAULT_STATE, raw ? JSON.parse(raw) : {}); } catch (e) { return { ...DEFAULT_STATE }; }
  }
  let saveTimer = null;
  function saveState() {
    state.checked = [...checked];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const json = JSON.stringify(state);
      if (Native && Native.saveState) { try { Native.saveState(json); } catch (e) { /* ignore */ } }
      else { try { localStorage.setItem("sc26state", json); } catch (e) { /* ignore */ } }
    }, 150);
  }

  // ---------------- boot ----------------
  async function boot() {
    const [sched, map] = await Promise.all([
      fetch("data/schedule.json").then((r) => r.json()),
      fetch("data/map.json").then((r) => r.json()),
    ]);
    sessions = C.prepare(sched.sessions);
    sessions.forEach((s) => byId.set(s.id, s));
    // drop checks for sessions that no longer exist
    checked = new Set([...checked].filter((id) => byId.has(id)));
    mapData = map;
    map.locations.forEach((l) => locById.set(l.id, l));
    map.layers.forEach((l) => layerById.set(l.id, l));

    const q = new URLSearchParams(location.search);
    if (q.get("now")) nowOverride = Date.parse(q.get("now"));

    setupTabs();
    setupSchedule();
    setupMap();
    setupPlan();
    setupSheet();
    setupGps();
    showView(state.view || "schedule");
    renderAll();
    document.body.dataset.ready = "1";
    setInterval(() => { refreshBlocks(); if (state.view === "map") renderMarkers(); }, 60e3);
  }

  function renderAll() {
    renderSchedule();
    refreshBlocks();
    renderPlan();
    updatePlanBadge();
    if (state.view === "map") renderMap();
  }

  // ---------------- tabs ----------------
  function setupTabs() {
    $$(".tabs button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  }
  function showView(v) {
    state.view = v; saveState();
    $$(".view").forEach((el) => el.classList.toggle("active", el.id === `view-${v}`));
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    if (v === "map") renderMap();
    if (v === "plan") renderPlan();
  }

  // ---------------- checks ----------------
  function toggleCheck(id, force) {
    const on = force ?? !checked.has(id);
    if (on) checked.add(id); else checked.delete(id);
    saveState();
    $$(`[data-check="${CSS.escape(id)}"]`).forEach((el) => setCheckEl(el, on));
    updatePlanBadge();
    if (state.view === "plan") renderPlan();
    if (state.view === "map") renderMap();
  }
  function setCheckEl(el, on) {
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
    el.textContent = on ? "★" : "☆";
  }
  function checkBtn(s) {
    const on = checked.has(s.id);
    return `<button class="check ${on ? "on" : ""}" role="checkbox" aria-checked="${on}" aria-label="Check ${esc(s.title)}" data-check="${esc(s.id)}">${on ? "★" : "☆"}</button>`;
  }
  function updatePlanBadge() { const b = $("#planCount"); b.textContent = checked.size; b.hidden = checked.size === 0; }

  // ---------------- schedule ----------------
  function setupSchedule() {
    const days = [...new Set(sessions.map((s) => s.day))].sort();
    const todayYmd = C.ymd(now());
    if (!state.day || !days.includes(state.day)) state.day = days.includes(todayYmd) ? todayYmd : days.find((d) => d >= todayYmd) || days[0];
    $("#dayChips").innerHTML = [`<button class="chip" data-day="">All days</button>`]
      .concat(days.map((d) => {
        const ms = sessions.find((s) => s.day === d).startMs;
        return `<button class="chip" data-day="${d}">${esc(C.fmtDay(ms))}</button>`;
      })).join("");
    $("#dayChips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-day]"); if (!b) return;
      state.day = b.dataset.day; saveState(); renderSchedule();
    });
    setupTypeFilter();
    $("#search").value = state.query || "";
    let t = null;
    $("#search").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.query = e.target.value; saveState(); renderSchedule(); }, 120); });
    $("#scheduleList").addEventListener("click", listClick);
  }

  // Multi-select type filter: a dropdown panel of checkboxes. No types checked = all types.
  function setupTypeFilter() {
    const types = [...new Set(sessions.map((s) => s.type))].sort();
    state.types = state.types.filter((t) => types.includes(t));
    $("#typeList").innerHTML = types.map((t) =>
      `<label class="type-opt"><input type="checkbox" value="${esc(t)}"><span>${esc(t)}</span></label>`).join("");
    const boxes = () => $$("#typeList input");
    const sync = () => {
      const on = new Set(state.types);
      boxes().forEach((b) => { b.checked = on.has(b.value); });
      const n = state.types.length;
      const btn = $("#typeBtn");
      btn.textContent = (n === 0 ? "All types" : n === 1 ? state.types[0] : `${n} types`) + " ▾";
      btn.classList.toggle("active", n > 0);
    };
    const commit = () => {
      state.types = boxes().filter((b) => b.checked).map((b) => b.value);
      sync(); saveState(); renderSchedule();
    };
    $("#typeBtn").addEventListener("click", (e) => { e.stopPropagation(); setTypePanel($("#typePanel").hidden); });
    $("#typeList").addEventListener("change", commit);
    $("#typePanel").addEventListener("click", (e) => {
      e.stopPropagation();
      const a = e.target.closest("[data-types]"); if (!a) return;
      if (a.dataset.types === "done") { setTypePanel(false); return; }
      boxes().forEach((b) => { b.checked = a.dataset.types === "all"; });
      commit();
    });
    document.addEventListener("click", () => setTypePanel(false));
    sync();
  }
  function setTypePanel(open) {
    $("#typePanel").hidden = !open;
    $("#typeBtn").setAttribute("aria-expanded", open ? "true" : "false");
  }

  function listClick(e) {
    const c = e.target.closest("[data-check]");
    if (c) { e.stopPropagation(); toggleCheck(c.dataset.check); return; }
    const r = e.target.closest("[data-room]");
    if (r) { e.stopPropagation(); showOnMap(byId.get(r.dataset.room)); return; }
    const row = e.target.closest("[data-sid]");
    if (row) openSession(byId.get(row.dataset.sid));
  }

  function sessionRow(s, opts = {}) {
    const n = now();
    const live = s.startMs <= n && s.endMs > n;
    const done = s.endMs <= n;
    return `<div class="item ${live ? "live" : ""} ${done ? "done" : ""} ${opts.conflict ? "conflict" : ""}" data-sid="${esc(s.id)}">
      ${checkBtn(s)}
      <div class="item-main">
        <div class="item-time">${opts.showDay ? esc(C.fmtDay(s.startMs)) + " · " : ""}${C.fmtRange(s.startMs, s.endMs)}${live ? ' <span class="tag live">now</span>' : ""}${opts.conflict ? ' <span class="tag warn">overlap</span>' : ""}</div>
        <div class="item-title">${esc(s.title)}</div>
        <div class="item-meta"><span class="type">${esc(s.type)}</span>
          ${s.loc ? `<button class="room" data-room="${esc(s.id)}">⌖ ${esc(s.room)}</button>` : `<span class="room off">${esc(s.room || "TBA")}</span>`}</div>
      </div>
    </div>`;
  }

  function renderSchedule() {
    $$("#dayChips .chip").forEach((b) => b.classList.toggle("active", b.dataset.day === (state.day || "")));
    const list = C.filterSessions(sessions, { day: state.day || null, types: state.types, query: state.query });
    const el = $("#scheduleList");
    if (!list.length) { el.innerHTML = `<div class="empty">No sessions match.</div>`; return; }
    const groups = C.groupBy(list, (s) => (state.day ? "" : s.day + "|") + s.startMs);
    let html = "", lastDay = null;
    for (const [, items] of groups) {
      const s0 = items[0];
      if (!state.day && s0.day !== lastDay) { html += `<h2 class="day-h">${esc(C.fmtDay(s0.startMs))}</h2>`; lastDay = s0.day; }
      html += `<div class="slot"><div class="slot-h">${C.fmtTime(s0.startMs)}</div>${items.map((s) => sessionRow(s)).join("")}</div>`;
    }
    el.innerHTML = html;
  }

  // ---------------- session sheet ----------------
  function openSession(s) {
    if (!s) return;
    const talks = (s.talks || []).map((t) => `<li><span class="t-time">${C.fmtRange(Date.parse(t.start), Date.parse(t.end))}</span> ${esc(t.title)}${t.speakers && t.speakers.length ? `<div class="t-sp">${esc(t.speakers.join(", "))}</div>` : ""}</li>`).join("");
    openSheet(`
      <div class="sheet-h">
        <div><div class="item-time">${esc(C.fmtDay(s.startMs))} · ${C.fmtRange(s.startMs, s.endMs)}</div>
        <h3>${esc(s.title)}</h3></div>
      </div>
      <div class="meta-row"><span class="type">${esc(s.type)}</span> <span>${esc(s.room || "")}</span></div>
      ${s.speakers && s.speakers.length ? `<p class="speakers">${esc(s.speakers.join(", "))}</p>` : ""}
      ${s.tags && s.tags.length ? `<div class="tags">${s.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="actions">
        <button class="btn primary" id="sheetCheck">${checked.has(s.id) ? "★ Checked" : "☆ Check"}</button>
        ${s.loc ? `<button class="btn" id="sheetMap">⌖ Show on map</button>` : ""}
        ${s.url ? `<button class="btn ghost" id="sheetWeb">Open on web</button>` : ""}
      </div>
      ${talks ? `<h4>Talks</h4><ol class="talks">${talks}</ol>` : ""}
    `);
    $("#sheetCheck").addEventListener("click", () => { toggleCheck(s.id); $("#sheetCheck").textContent = checked.has(s.id) ? "★ Checked" : "☆ Check"; });
    if (s.loc) $("#sheetMap").addEventListener("click", () => { closeSheet(); showOnMap(s); });
    if (s.url) $("#sheetWeb").addEventListener("click", () => openExternal(s.url));
  }

  function openExternal(url) {
    if (Native && Native.openUrl) Native.openUrl(url); else window.open(url, "_blank");
  }

  // ---------------- sheet ----------------
  function setupSheet() {
    // ignore the tail of the gesture that opened the sheet
    $("#sheetBackdrop").addEventListener("click", () => { if (Date.now() - sheetOpenedAt > 350) closeSheet(); });
    $("#sheet").addEventListener("click", (e) => {
      const c = e.target.closest("[data-check]");
      if (c) { e.stopPropagation(); toggleCheck(c.dataset.check); return; }
      const row = e.target.closest("[data-sid]");
      if (row && !e.target.closest("button")) openSession(byId.get(row.dataset.sid));
      const r = e.target.closest("[data-room]");
      if (r) { closeSheet(); showOnMap(byId.get(r.dataset.room)); }
    });
  }
  let sheetOpenedAt = 0;
  function openSheet(html) {
    sheetOpenedAt = Date.now();
    $("#sheetBody").innerHTML = html;
    $("#sheet").hidden = false; $("#sheetBackdrop").hidden = false;
    $("#sheet").scrollTop = 0;
  }
  function closeSheet() { $("#sheet").hidden = true; $("#sheetBackdrop").hidden = true; }

  // ---------------- plan ----------------
  function setupPlan() {
    $("#planList").addEventListener("click", listClick);
    $("#planOnMap").addEventListener("click", () => {
      state.mapScope = "checked"; state.mapTime = "any"; saveState(); showView("map");
    });
  }
  function renderPlan() {
    const list = sessions.filter((s) => checked.has(s.id)).sort((a, b) => a.startMs - b.startMs);
    const conf = C.conflicts(list);
    $("#planSummary").textContent = list.length ? `${list.length} checked · ${conf.size ? conf.size + " overlapping" : "no overlaps"}` : "";
    const el = $("#planList");
    if (!list.length) { el.innerHTML = `<div class="empty">Tap ☆ on any session to add it here.<br>Checked sessions can be filtered on the map.</div>`; return; }
    let html = "", lastDay = null;
    for (const s of list) {
      if (s.day !== lastDay) { html += `<h2 class="day-h">${esc(C.fmtDay(s.startMs))}</h2>`; lastDay = s.day; }
      html += sessionRow(s, { conflict: conf.has(s.id) });
    }
    el.innerHTML = html;
  }

  // ---------------- map ----------------
  const view = { scale: 1, tx: 0, ty: 0, layer: null, svgLoaded: null, minScale: 0.2 };
  const svgCache = new Map();
  let gps = { status: "init", fix: null };
  let blocks = [], curBlock = null, upBlock = null;

  function setupMap() {
    $("#mapFilters").addEventListener("click", (e) => {
      const b = e.target.closest("button.chip"); if (!b) return;
      if (b.dataset.scope) state.mapScope = b.dataset.scope;
      if (b.dataset.time) { state.mapTime = b.dataset.time; state.mapBlock = null; }
      saveState(); renderMap();
    });
    $("#blockPicker").addEventListener("change", (e) => {
      if (e.target.value) { state.mapTime = "pick"; state.mapBlock = e.target.value; }
      saveState(); renderMap();
    });
    $("#floorChips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-layer]"); if (!b) return;
      setLayer(b.dataset.layer, { fit: true });
    });
    $("#btnZoomIn").addEventListener("click", () => zoomAt(1.5));
    $("#btnZoomOut").addEventListener("click", () => zoomAt(1 / 1.5));
    $("#btnFit").addEventListener("click", () => fitView());
    $("#btnLocate").addEventListener("click", locateMe);
    setupPanZoom($("#mapViewport"));
    window.addEventListener("resize", () => { if (state.view === "map") { clampView(); applyTransform(); } });
  }

  function refreshBlocks() {
    blocks = C.allBlocks(sessions);
    curBlock = C.blockAt(now());
    upBlock = C.upcomingBlock(sessions, now());
    $("#chipCurrent").textContent = `This block · ${curBlock.label}`;
    $("#chipNext").textContent = upBlock ? `Next block · ${upBlock.label}` : "Next block";
    const sel = $("#blockPicker");
    sel.innerHTML = `<option value="">Pick block…</option>` + blocks.map((b) => `<option value="${b.key}">${esc(b.label)}</option>`).join("");
    sel.value = state.mapTime === "pick" ? state.mapBlock || "" : "";
  }

  function activeBlock() {
    if (state.mapTime === "current") return curBlock;
    if (state.mapTime === "next") return upBlock || { start: 0, end: 0 };
    if (state.mapTime === "pick") return blocks.find((b) => b.key === state.mapBlock) || null;
    return null;
  }

  function mapFiltered() {
    return C.filterSessions(sessions, { scope: state.mapScope, checked, block: activeBlock(), mappedOnly: true });
  }

  function renderMap() {
    // chips
    $$("#mapFilters [data-scope]").forEach((b) => b.classList.toggle("active", b.dataset.scope === state.mapScope));
    $$("#mapFilters [data-time]").forEach((b) => b.classList.toggle("active", b.dataset.time === state.mapTime));
    $("#blockPicker").classList.toggle("active", state.mapTime === "pick");
    $("#blockPicker").value = state.mapTime === "pick" ? state.mapBlock || "" : "";

    const list = mapFiltered();
    const perLayer = new Map();
    for (const s of list) { const L = locById.get(s.loc); if (L) perLayer.set(L.l, (perLayer.get(L.l) || 0) + 1); }
    $("#floorChips").innerHTML = mapData.layers.map((L) => {
      const n = perLayer.get(L.id) || 0;
      return `<button class="chip floor" data-layer="${L.id}" title="${esc(L.name)}">${esc(L.name)}${n ? ` <b class="badge">${n}</b>` : ""}</button>`;
    }).join("");

    if (!view.layer) {
      // first time: saved floor, else the floor with most events, else West 1
      let best = state.layer && layerById.has(state.layer) ? state.layer : null;
      if (!best) best = [...perLayer.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "West1";
      setLayer(best, { fit: true });
    } else {
      $$("#floorChips .chip").forEach((b) => b.classList.toggle("active", b.dataset.layer === view.layer));
      renderMarkers();
    }

    const b = activeBlock();
    const scopeTxt = state.mapScope === "checked" ? "checked events" : "events";
    const timeTxt = b ? (b.label ? ` in ${b.longLabel}` : " (no upcoming block)") : "";
    const offFloor = list.length - (perLayer.get(view.layer) || 0);
    $("#mapSummary").innerHTML = `${list.length} ${scopeTxt}${esc(timeTxt)}${list.length && offFloor ? ` · <span class="muted">${offFloor} on other floors</span>` : ""}`;
  }

  async function loadSvg(L) {
    if (svgCache.has(L.id)) return svgCache.get(L.id);
    const txt = await fetch(L.file).then((r) => r.text());
    svgCache.set(L.id, txt);
    return txt;
  }

  async function setLayer(id, opts = {}) {
    const L = layerById.get(id); if (!L) return;
    const changed = view.layer !== id;
    view.layer = id; state.layer = id; saveState();
    $$("#floorChips .chip").forEach((b) => b.classList.toggle("active", b.dataset.layer === id));
    if (changed || view.svgLoaded !== id) {
      const stage = $("#mapStage");
      stage.style.width = L.w + "px"; stage.style.height = L.h + "px";
      stage.innerHTML = await loadSvg(L);
      const svg = $("svg", stage);
      if (svg) { svg.setAttribute("width", L.w); svg.setAttribute("height", L.h); svg.removeAttribute("style"); }
      view.svgLoaded = id;
    }
    if (opts.fit || changed) fitView();
    if (opts.center) centerOn(opts.center.x, opts.center.y, opts.center.scale);
    renderMarkers();
  }

  function vpSize() { const r = $("#mapViewport").getBoundingClientRect(); return { w: r.width, h: r.height }; }

  function fitView() {
    const L = layerById.get(view.layer); if (!L) return;
    const { w, h } = vpSize();
    const s = Math.min(w / L.w, h / L.h) * 0.98;
    view.minScale = s * 0.8;
    view.scale = s; view.tx = (w - L.w * s) / 2; view.ty = (h - L.h * s) / 2;
    applyTransform();
  }

  function centerOn(x, y, scale) {
    const { w, h } = vpSize();
    if (scale) view.scale = scale;
    view.tx = w / 2 - x * view.scale; view.ty = h / 2 - y * view.scale;
    clampView(); applyTransform();
  }

  function zoomAt(f, cx, cy) {
    const { w, h } = vpSize();
    cx = cx ?? w / 2; cy = cy ?? h / 2;
    const ns = Math.max(view.minScale, Math.min(12, view.scale * f));
    const k = ns / view.scale;
    view.tx = cx - (cx - view.tx) * k; view.ty = cy - (cy - view.ty) * k; view.scale = ns;
    clampView(); applyTransform();
  }

  function clampView() {
    const L = layerById.get(view.layer); if (!L) return;
    const { w, h } = vpSize();
    const mw = L.w * view.scale, mh = L.h * view.scale, pad = 60;
    view.tx = Math.min(w - pad, Math.max(pad - mw, view.tx));
    view.ty = Math.min(h - pad, Math.max(pad - mh, view.ty));
  }

  // Coalesce to one style write per frame (two-finger moves fire several events per frame).
  let rafPending = false;
  function applyTransform() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      $("#mapStage").style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
      positionMarkers();
    });
  }

  // Gesture handling: every finger on the map counts (including ones that land on a marker),
  // pinch is computed from the first two pointers, and a gesture is only a "tap" if it was a
  // single finger that stayed put. Taps are resolved by hit-testing (marker first, then room).
  function setupPanZoom(vp) {
    const pts = new Map();
    let last = null, lastTap = 0;
    let g = null; // current gesture: { startX, startY, maxPointers, moved }
    const TAP_SLOP = 10;

    vp.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".fab")) return;
      try { vp.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (pts.size === 0) { g = { startX: e.clientX, startY: e.clientY, maxPointers: 0, moved: false }; gestureStart(); }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      g.maxPointers = Math.max(g.maxPointers, pts.size);
      if (pts.size > 1) g.moved = true; // multi-finger gestures are never taps
      last = null;
    });

    vp.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > TAP_SLOP) g.moved = true;
      const r = vp.getBoundingClientRect();
      const arr = [...pts.values()].slice(0, 2);
      const cx = arr.reduce((a, p) => a + p.x, 0) / arr.length - r.left;
      const cy = arr.reduce((a, p) => a + p.y, 0) / arr.length - r.top;
      const dist = arr.length > 1 ? Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y) : 0;
      if (last && last.n === arr.length && g.moved) {
        view.tx += cx - last.cx; view.ty += cy - last.cy;
        if (arr.length > 1 && last.dist > 10 && dist > 10) {
          const k = dist / last.dist;
          const ns = Math.max(view.minScale, Math.min(12, view.scale * k));
          const f = ns / view.scale;
          view.tx = cx - (cx - view.tx) * f; view.ty = cy - (cy - view.ty) * f; view.scale = ns;
        }
        clampView(); applyTransform();
      }
      last = { cx, cy, dist, n: arr.length };
    });

    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      last = null; // re-anchor so the remaining finger doesn't jump
      if (pts.size > 0) return;
      const isTap = e.type === "pointerup" && g && !g.moved && g.maxPointers === 1;
      g = null;
      gestureEnd();
      // Act on the browser's own click that follows a tap (not here): if we opened a sheet on
      // pointerup, that click would land on the freshly shown backdrop and close it again.
      pendingTap = isTap ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
    };
    let pendingTap = null;
    vp.addEventListener("pointerup", up);
    vp.addEventListener("pointercancel", up);
    vp.addEventListener("click", (e) => {
      if (e.target.closest(".fab")) return;
      const tap = pendingTap; pendingTap = null;
      if (!tap || Date.now() - tap.t > 600) return;
      const t = Date.now();
      if (t - lastTap < 300) { const r = vp.getBoundingClientRect(); zoomAt(2, tap.x - r.left, tap.y - r.top); lastTap = 0; }
      else { lastTap = t; tapMap({ clientX: tap.x, clientY: tap.y }); }
    });
    vp.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }

  // While a finger is down the stage is a GPU layer (scaled as a bitmap, cheap); afterwards it is
  // re-rasterised once at the final scale so the floor plan is crisp again.
  let settleT = null;
  function gestureStart() { clearTimeout(settleT); $("#mapStage").classList.add("moving"); $("#mapViewport").classList.add("gesturing"); }
  function gestureEnd() {
    clearTimeout(settleT);
    settleT = setTimeout(() => { $("#mapStage").classList.remove("moving"); $("#mapViewport").classList.remove("gesturing"); }, 120);
  }

  // tap: a marker under the finger wins, otherwise the room shape
  function tapMap(e) {
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    const m = els.find((el) => el.closest && el.closest(".marker"));
    if (m) { openLocation(m.closest(".marker").dataset.loc); return; }
    for (const el of els) {
      const hit = el.closest && el.closest("#mapStage [id]");
      if (hit && locById.has(hit.id)) { openLocation(hit.id); return; }
    }
  }

  function renderMarkers() {
    const layer = $("#markerLayer");
    const stage = $("#mapStage");
    $$(".hl, .hl-checked", stage).forEach((el) => el.classList.remove("hl", "hl-checked"));
    const list = mapFiltered().filter((s) => locById.get(s.loc)?.l === view.layer);
    const byLoc = C.groupBy(list, (s) => s.loc);
    const n = now();
    let html = "";
    for (const [loc, items] of byLoc) {
      const L = locById.get(loc);
      const anyChecked = items.some((s) => checked.has(s.id));
      const live = items.some((s) => s.startMs <= n && s.endMs > n);
      const shape = stage.querySelector(`[id="${CSS.escape(loc)}"]`);
      if (shape) shape.classList.add(anyChecked ? "hl-checked" : "hl");
      html += `<button class="marker ${anyChecked ? "checked" : ""} ${live ? "live" : ""}" data-loc="${esc(loc)}" data-x="${L.x}" data-y="${L.y}" aria-label="${esc(L.t)}: ${items.length} events">
        <span class="count">${anyChecked ? "★" : ""}${items.length}</span><span class="lbl">${esc(shortRoom(L.t))}</span></button>`;
    }
    html += `<div id="youAcc" class="you-acc" hidden></div><div id="youDot" class="you-dot" hidden></div>`;
    layer.innerHTML = html;
    positionMarkers();
    updateNotice();
  }

  function shortRoom(t) { return t.replace(/^Booth \d+\w* - /, "").replace(/\s*\(.*\)$/, "").slice(0, 22); }

  function positionMarkers() {
    for (const m of $$("#markerLayer .marker")) {
      const x = +m.dataset.x * view.scale + view.tx, y = +m.dataset.y * view.scale + view.ty;
      m.style.transform = `translate(${x}px, ${y}px)`;
      m.classList.toggle("small", view.scale < 0.9);
    }
    positionYou();
  }

  function openLocation(locId) {
    const L = locById.get(locId); if (!L) return;
    const filtered = mapFiltered().filter((s) => s.loc === locId);
    const all = sessions.filter((s) => s.loc === locId && !filtered.includes(s));
    openSheet(`
      <div class="sheet-h"><div><div class="item-time">${esc(layerById.get(L.l)?.name || "")}</div><h3>${esc(L.t)}</h3></div></div>
      ${filtered.length ? `<h4>Matching filters (${filtered.length})</h4>${filtered.map((s) => sessionRow(s, { showDay: true })).join("")}` : `<p class="muted">No events here match the current filters.</p>`}
      ${all.length ? `<details><summary>Other events in this room (${all.length})</summary>${all.map((s) => sessionRow(s, { showDay: true })).join("")}</details>` : ""}
    `);
  }

  function showOnMap(s) {
    if (!s || !s.loc) return;
    const L = locById.get(s.loc);
    // make sure the event is visible under the current filters
    const visible = mapFiltered().some((x) => x.id === s.id);
    if (!visible) { state.mapScope = checked.has(s.id) ? state.mapScope : "all"; state.mapTime = "any"; saveState(); }
    showView("map");
    setLayer(L.l, { center: { x: L.x, y: L.y, scale: Math.max(view.scale, 2.2) } }).then(() => {
      const m = $(`#markerLayer [data-loc="${CSS.escape(s.loc)}"]`);
      if (m) { m.classList.add("pulse"); setTimeout(() => m.classList.remove("pulse"), 2500); }
    });
  }

  // ---------------- GPS ----------------
  const GPS_TEXT = {
    init: "GPS…", searching: "Locating…", ok: "GPS", off: "GPS off", denied: "No location permission",
    unavailable: "No GPS", error: "GPS error",
  };

  function setupGps() {
    $("#gpsPill").addEventListener("click", gpsAction);
    if (Native && Native.startLocation) { try { Native.startLocation(); } catch (e) { /* ignore */ } }
    else if (navigator.geolocation) {
      onLocationStatus("searching");
      navigator.geolocation.watchPosition(
        (p) => onLocation({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, time: p.timestamp }),
        (err) => onLocationStatus(err.code === 1 ? "denied" : "unavailable"),
        { enableHighAccuracy: true, maximumAge: 10000 });
    } else onLocationStatus("unavailable");
  }

  function gpsAction() {
    if (gps.status === "denied" && Native && Native.requestLocation) Native.requestLocation();
    else if (gps.status === "off" && Native && Native.openLocationSettings) {
      openSheet(`<h3>Location is turned off</h3><p>The map and schedule work fully offline without it. Turn on location to see where you are on the floor plan.</p>
        <div class="actions"><button class="btn primary" id="goSettings">Open location settings</button><button class="btn ghost" id="noSettings">Not now</button></div>`);
      $("#goSettings").addEventListener("click", () => { closeSheet(); Native.openLocationSettings(); });
      $("#noSettings").addEventListener("click", closeSheet);
    } else if (gps.fix) { showView("map"); locateMe(); }
  }

  function onLocationStatus(status, detail) {
    gps.status = status;
    if (status !== "ok" && status !== "searching") gps.fix = null; // off / denied / unavailable: drop stale fix
    renderGpsPill();
    updateNotice();
    positionYou();
  }

  function onLocation(fix) {
    gps.fix = fix; gps.status = "ok";
    renderGpsPill();
    positionYou();
    updateNotice();
  }

  function renderGpsPill() {
    const p = $("#gpsPill");
    p.dataset.status = gps.status;
    p.textContent = gps.status === "ok" && gps.fix ? `● ±${Math.round(gps.fix.acc || 0)} m` : GPS_TEXT[gps.status] || gps.status;
  }

  function youOnLayer() {
    const L = layerById.get(view.layer);
    if (!gps.fix || !L || !L.geo) return null;
    const p = C.geoToSvg(L.geo, gps.fix.lat, gps.fix.lon);
    const inside = p.x >= 0 && p.y >= 0 && p.x <= L.w && p.y <= L.h;
    return { ...p, inside, mpu: C.metresPerUnit(L.geo) };
  }

  function positionYou() {
    const dot = $("#youDot"), acc = $("#youAcc");
    if (!dot) return;
    const p = youOnLayer();
    if (!p || !p.inside) { dot.hidden = true; acc.hidden = true; return; }
    const x = p.x * view.scale + view.tx, y = p.y * view.scale + view.ty;
    dot.hidden = false; acc.hidden = false;
    dot.style.transform = `translate(${x}px, ${y}px)`;
    const r = Math.max(8, ((gps.fix.acc || 0) / p.mpu) * view.scale);
    acc.style.width = acc.style.height = 2 * r + "px";
    acc.style.transform = `translate(${x - r}px, ${y - r}px)`;
  }

  function venueDistance() {
    if (!gps.fix) return null;
    // distance to the nearest georeferenced floor-plan centre
    let best = Infinity;
    for (const L of mapData.layers) {
      if (!L.geo) continue;
      const c = C.svgToGeo(L.geo, L.w / 2, L.h / 2);
      best = Math.min(best, C.distanceM(gps.fix.lat, gps.fix.lon, c.lat, c.lon));
    }
    return best;
  }

  function updateNotice() {
    const n = $("#mapNotice"); if (!n || !mapData) return;
    let msg = "";
    const L = layerById.get(view.layer);
    if (gps.status === "off") msg = "Location is off. The map works without it; tap the GPS pill to turn it on.";
    else if (gps.status === "denied") msg = "Location permission not granted. Tap the GPS pill to allow it.";
    else if (gps.status === "unavailable") msg = "No GPS on this device. The map still works.";
    else if (gps.fix) {
      const p = youOnLayer();
      if (L && !L.geo) msg = "Pick a floor to see your position.";
      else if (p && !p.inside) {
        const here = C.layersContaining(mapData.layers, gps.fix.lat, gps.fix.lon);
        if (here.length) msg = `You appear to be in another building: ${here.map((x) => x.name).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).join(" / ")}. Tap ◎ to switch.`;
        else { const d = venueDistance(); msg = `You are about ${d >= 100e3 ? Math.round(d / 1000).toLocaleString("en-US") + " km" : d > 1500 ? (d / 1000).toFixed(1) + " km" : Math.round(d) + " m"} from McCormick Place.`; }
      }
    }
    n.textContent = msg;
    n.hidden = !msg;
  }

  function locateMe() {
    if (!gps.fix) { gpsAction(); if (gps.status === "searching" || gps.status === "init") toast("Waiting for a location fix…"); return; }
    const here = C.layersContaining(mapData.layers, gps.fix.lat, gps.fix.lon);
    let target = here.find((L) => L.id === view.layer);
    if (!target && here.length) {
      const cur = layerById.get(view.layer);
      target = here.find((L) => cur && L.building === cur.building) || here.find((L) => L.id === "west3") || here[0];
    }
    if (!target) { toast("You're not at McCormick Place right now."); updateNotice(); return; }
    const p = C.geoToSvg(target.geo, gps.fix.lat, gps.fix.lon);
    setLayer(target.id, { center: { x: p.x, y: p.y, scale: Math.max(view.scale, 1.6) } });
  }

  let toastT = null;
  function toast(msg) {
    let t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2500);
  }

  // ---------------- native hooks ----------------
  window.SC26 = {
    onLocation, onLocationStatus,
    onBack() {
      if (!$("#sheet").hidden) { closeSheet(); return true; }
      if (!$("#typePanel").hidden) { setTypePanel(false); return true; }
      if (state.view !== "schedule") { showView("schedule"); return true; }
      return false;
    },
    setNow(iso) { nowOverride = iso ? Date.parse(iso) : null; refreshBlocks(); renderAll(); },
    debug() {
      return {
        ready: document.body.dataset.ready === "1", view: state.view, layer: view.layer, checked: [...checked],
        gps: gps.status, fix: gps.fix, markers: $$("#markerLayer .marker").map((m) => m.dataset.loc),
        you: youOnLayer(), mapScope: state.mapScope, mapTime: state.mapTime, block: activeBlock()?.key || null,
        notice: $("#mapNotice").hidden ? "" : $("#mapNotice").textContent, svg: !!$("#mapStage svg"),
        scale: view.scale, sheetOpen: !$("#sheet").hidden,
      };
    },
    // used by the instrumented tests
    _internals: {
      toggleCheck, showView, setLayer, byId, sessions: () => sessions,
      locLayer: (id) => locById.get(id)?.l || null,
      geoOfLocation(id) {
        const l = locById.get(id), L = layerById.get(l.l);
        return { ...C.svgToGeo(L.geo, l.x, l.y), x: l.x, y: l.y, layer: l.l };
      },
    },
  };

  boot().catch((e) => { document.body.innerHTML = `<pre class="fatal">Failed to start: ${esc(e && e.stack || e)}</pre>`; });
})();
