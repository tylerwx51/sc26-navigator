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
    checked: [], notInterested: [], view: "schedule", day: null, types: [], query: "",
    mapScope: "all", mapTime: "next", mapBlock: null, layer: null, mapQuery: "", showConn: true,
  };
  let state = loadState();
  // migrate the old single-select type filter ("type": "Workshop") to the multi-select list
  if (!Array.isArray(state.types)) state.types = [];
  if (state.type) { if (!state.types.length) state.types = [state.type]; state.type = undefined; }
  let checked = new Set(state.checked);
  if (!Array.isArray(state.notInterested)) state.notInterested = [];
  let notInterested = new Set(state.notInterested); // sessions moved to the "Not interested" section of the schedule
  let sessions = [], byId = new Map(), mapData = null, locById = new Map(), layerById = new Map();
  let conn = { floors: {}, portals: [] }; // stairs/escalators/elevators per floor + links between buildings
  let exhibitors = { booths: {}, orgs: {} }; // booth location id -> exhibitor ids; exhibitor name/url/summary/logo
  let pages = new Set(); // session sids whose program page is mirrored at site/pages/<sid>.html
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
    state.notInterested = [...notInterested];
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const json = JSON.stringify(state);
      if (Native && Native.saveState) { try { Native.saveState(json); } catch (e) { /* ignore */ } }
      else { try { localStorage.setItem("sc26state", json); } catch (e) { /* ignore */ } }
    }, 150);
  }

  // ---------------- boot ----------------
  async function boot() {
    const [sched, map, connData, exData, pageData] = await Promise.all([
      fetch("data/schedule.json").then((r) => r.json()),
      fetch("data/map.json").then((r) => r.json()),
      fetch("data/connectors.json").then((r) => r.json()).catch(() => null),
      fetch("data/exhibitors.json").then((r) => r.json()).catch(() => null),
      fetch("data/pages.json").then((r) => r.json()).catch(() => null),
    ]);
    if (pageData) pages = new Set(pageData);
    if (connData) conn = connData;
    if (exData) exhibitors = exData;
    sessions = C.prepare(sched.sessions);
    sessions.forEach((s) => byId.set(s.id, s));
    // drop checks for sessions that no longer exist
    checked = new Set([...checked].filter((id) => byId.has(id)));
    notInterested = new Set([...notInterested].filter((id) => byId.has(id)));
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
  function setNotInterested(id, on) {
    if (on) notInterested.add(id); else notInterested.delete(id);
    saveState();
    renderSchedule();
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
    const ni = e.target.closest("[data-notint]");
    if (ni) { e.stopPropagation(); setNotInterested(ni.dataset.notint, ni.dataset.on === "1"); return; }
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
    return `<div class="item ${live ? "live" : ""} ${done ? "done" : ""} ${opts.conflict ? "conflict" : ""} ${opts.notInt ? "notint-item" : ""}" data-sid="${esc(s.id)}">
      ${checkBtn(s)}
      <div class="item-main">
        <div class="item-time">${opts.showDay ? esc(C.fmtDay(s.startMs)) + " · " : ""}${C.fmtRange(s.startMs, s.endMs)}${live ? ' <span class="tag live">now</span>' : ""}${opts.conflict ? ' <span class="tag warn">overlap</span>' : ""}</div>
        <div class="item-title">${esc(s.title)}</div>
        <div class="item-meta"><span class="type">${esc(s.type)}</span>
          ${s.loc ? `<button class="room" data-room="${esc(s.id)}">⌖ ${esc(s.room)}</button>` : `<span class="room off">${esc(s.room || "TBA")}</span>`}
          ${opts.interestBtn ? notIntBtn(s) : ""}</div>
      </div>
    </div>`;
  }

  // "Not interested" on a normal row; "Interested" (restore) on a row in the bottom section
  function notIntBtn(s) {
    return notInterested.has(s.id)
      ? `<button class="notint restore" data-notint="${esc(s.id)}" data-on="0" aria-label="Interested in ${esc(s.title)}">↺ Interested</button>`
      : `<button class="notint" data-notint="${esc(s.id)}" data-on="1" aria-label="Not interested in ${esc(s.title)}">✕ Not interested</button>`;
  }

  function renderSchedule() {
    $$("#dayChips .chip").forEach((b) => b.classList.toggle("active", b.dataset.day === (state.day || "")));
    const all = C.filterSessions(sessions, { day: state.day || null, types: state.types, query: state.query });
    const list = all.filter((s) => !notInterested.has(s.id));
    const skipped = all.filter((s) => notInterested.has(s.id));
    const el = $("#scheduleList");
    const skippedHtml = skipped.length ? `<h2 class="day-h notint-h" id="notIntSection">Not interested · ${skipped.length}</h2>
      ${skipped.map((s) => sessionRow(s, { showDay: !state.day, interestBtn: true, notInt: true })).join("")}` : "";
    if (!list.length) { el.innerHTML = `<div class="empty">No sessions match.</div>${skippedHtml}`; return; }
    const groups = C.groupBy(list, (s) => (state.day ? "" : s.day + "|") + s.startMs);
    let html = "", lastDay = null;
    for (const [, items] of groups) {
      const s0 = items[0];
      if (!state.day && s0.day !== lastDay) { html += `<h2 class="day-h">${esc(C.fmtDay(s0.startMs))}</h2>`; lastDay = s0.day; }
      html += `<div class="slot"><div class="slot-h">${C.fmtTime(s0.startMs)}</div>${items.map((s) => sessionRow(s, { interestBtn: true })).join("")}</div>`;
    }
    el.innerHTML = html + skippedHtml;
  }

  // ---------------- session sheet ----------------
  function openSession(s) {
    if (!s) return;
    const page = pages.has(s.sid);
    const talks = (s.talks || []).map((t) => `<li><span class="t-time">${C.fmtRange(Date.parse(t.start), Date.parse(t.end))}</span> ${esc(t.title)}${t.speakers && t.speakers.length ? `<div class="t-sp">${esc(t.speakers.join(", "))}</div>` : ""}</li>`).join("");
    openSheet(`
      <div class="sheet-h">
        <div><div class="item-time">${esc(C.fmtDay(s.startMs))} · ${C.fmtRange(s.startMs, s.endMs)}</div>
        <h3>${esc(s.title)}</h3></div>
      </div>
      <div class="meta-row"><span class="type">${esc(s.type)}</span> <span>${esc(s.room || "")}</span></div>
      ${s.speakers && s.speakers.length && !page ? `<p class="speakers">${esc(s.speakers.join(", "))}</p>` : ""}
      ${s.tags && s.tags.length ? `<div class="tags">${s.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="actions">
        <button class="btn primary" id="sheetCheck">${checked.has(s.id) ? "★ Checked" : "☆ Check"}</button>
        ${s.loc ? `<button class="btn" id="sheetMap">⌖ Show on map</button>` : ""}
      </div>
      ${page ? `<iframe class="page-frame" id="sheetPage" title="Program page" src="site/pages/${encodeURIComponent(s.sid)}.html"></iframe>`
        : talks ? `<h4>Talks</h4><ol class="talks">${talks}</ol>` : ""}
    `, page);
    if (page) wirePage($("#sheetPage"), s.url);
    $("#sheetCheck").addEventListener("click", () => { toggleCheck(s.id); $("#sheetCheck").textContent = checked.has(s.id) ? "★ Checked" : "☆ Check"; });
    if (s.loc) $("#sheetMap").addEventListener("click", () => { closeSheet(); showOnMap(s); });
  }

  // The session's mirrored program page: grow the iframe to its content (the sheet scrolls, not the
  // frame) and route its links: other sessions open in the app, everything else in the browser.
  function wirePage(frame, pageUrl) {
    const base = pageUrl || "https://sc26.conference-program.com/";
    frame.addEventListener("load", () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const fit = () => { frame.style.height = doc.documentElement.scrollHeight + "px"; };
      fit();
      try { new ResizeObserver(fit).observe(doc.body); } catch (e) { /* old WebView */ }
      wireSheetDrag(doc, () => frame.getBoundingClientRect().top);
      doc.addEventListener("submit", (e) => e.preventDefault(), true);
      doc.addEventListener("click", (e) => {
        const a = e.target.closest("a[href]");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
        let url;
        try { url = new URL(href, base); } catch (err) { return; }
        const sid = url.hostname === "sc26.conference-program.com" && url.searchParams.get("sess");
        const target = sid && sessions.find((x) => x.sid === sid);
        if (target) openSession(target);
        else if (url.protocol === "https:") openExternal(url.href);
      }, true);
    });
  }

  function openExternal(url) {
    if (Native && Native.openUrl) Native.openUrl(url); else window.open(url, "_blank");
  }

  // ---------------- sheet ----------------
  function setupSheet() {
    // ignore the tail of the gesture that opened the sheet
    $("#sheetBackdrop").addEventListener("click", () => { if (Date.now() - sheetOpenedAt > 350) closeSheet(); });
    $("#sheet").addEventListener("click", (e) => {
      if (connSheetClick(e)) return;
      const w = e.target.closest(".exh-web");
      if (w) { openExternal(w.dataset.url); return; }
      const c = e.target.closest("[data-check]");
      if (c) { e.stopPropagation(); toggleCheck(c.dataset.check); return; }
      const row = e.target.closest("[data-sid]");
      if (row && !e.target.closest("button")) openSession(byId.get(row.dataset.sid));
      const r = e.target.closest("[data-room]");
      if (r) { closeSheet(); showOnMap(byId.get(r.dataset.room)); }
    });
    wireSheetDrag($("#sheet"));
  }
  // Swipe down to dismiss: the sheet follows the finger when a downward drag starts with the sheet
  // scrolled to the top. Released past half its height (or flicked down) it slides out and closes;
  // otherwise it springs back to its open height. `frameTop` maps touches inside the session page
  // iframe into this document's viewport.
  let sheetDrag = null;
  function sheetTouchStart(e, frameTop = () => 0) {
    const sheet = $("#sheet");
    if (sheet.hidden || e.touches.length !== 1 || sheet.classList.contains("settling")) { sheetDrag = null; return; }
    const t = e.touches[0], y = t.clientY + frameTop();
    sheetDrag = { x0: t.clientX, y0: y, frameTop, on: false, d: 0, ly: y, lt: e.timeStamp, v: 0 };
  }
  function sheetTouchMove(e) {
    const g = sheetDrag;
    if (!g) return;
    if (e.touches.length !== 1) { sheetDragEnd(true); return; }
    const t = e.touches[0], y = t.clientY + g.frameTop(), sheet = $("#sheet");
    if (!g.on) {
      const dx = t.clientX - g.x0, dy = y - g.y0;
      if (Math.hypot(dx, dy) < 8) return;
      if (dy <= Math.abs(dx) || sheet.scrollTop > 0) { sheetDrag = null; return; } // a normal scroll
      g.on = true; g.y0 = y; g.h = sheet.offsetHeight;
    }
    e.preventDefault();
    const dt = e.timeStamp - g.lt;
    if (dt > 0) g.v = 0.6 * ((y - g.ly) / dt) + 0.4 * g.v;
    g.ly = y; g.lt = e.timeStamp;
    g.d = Math.max(0, y - g.y0);
    sheet.style.transform = `translateY(${g.d}px)`;
    $("#sheetBackdrop").style.opacity = String(1 - g.d / g.h);
  }
  function sheetDragEnd(cancel = false) {
    const g = sheetDrag;
    sheetDrag = null;
    if (!g || !g.on) return;
    // the browser may still deliver a click for the finger-up; swallow it
    const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    document.addEventListener("click", eat, true);
    setTimeout(() => document.removeEventListener("click", eat, true), 400);
    const close = !cancel && (g.d > g.h * 0.5 || (g.v > 0.6 && g.d > 30));
    settleSheet(close ? g.h : 0, close);
  }
  function settleSheet(to, close) {
    const sheet = $("#sheet"), bd = $("#sheetBackdrop");
    sheet.classList.add("settling"); bd.classList.add("settling");
    sheet.style.transform = `translateY(${to}px)`;
    bd.style.opacity = close ? "0" : "1";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sheet.removeEventListener("transitionend", finish);
      if (close) closeSheet(); else resetSheetDrag();
    };
    sheet.addEventListener("transitionend", finish);
    setTimeout(finish, 300);
  }
  function resetSheetDrag() {
    sheetDrag = null;
    for (const el of [$("#sheet"), $("#sheetBackdrop")]) { el.classList.remove("settling"); el.style.transform = ""; el.style.opacity = ""; }
  }
  function wireSheetDrag(target, frameTop) {
    target.addEventListener("touchstart", (e) => sheetTouchStart(e, frameTop), { passive: true });
    target.addEventListener("touchmove", sheetTouchMove, { passive: false });
    target.addEventListener("touchend", () => sheetDragEnd(), { passive: true });
    target.addEventListener("touchcancel", () => sheetDragEnd(true), { passive: true });
  }

  let sheetOpenedAt = 0;
  function openSheet(html, tall = false) {
    sheetOpenedAt = Date.now();
    resetSheetDrag();
    $("#sheetBody").innerHTML = html;
    $("#sheet").classList.toggle("tall", tall);
    $("#sheet").hidden = false; $("#sheetBackdrop").hidden = false;
    $("#sheet").scrollTop = 0;
  }
  function closeSheet() { $("#sheet").hidden = true; $("#sheetBackdrop").hidden = true; resetSheetDrag(); }

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
  const view = { scale: 1, tx: 0, ty: 0, layer: null, svgLoaded: null, minScale: 0.2, focusLoc: null };
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
    setupMapSearch();
    $("#btnZoomIn").addEventListener("click", () => zoomAt(1.5));
    $("#btnZoomOut").addEventListener("click", () => zoomAt(1 / 1.5));
    $("#btnFit").addEventListener("click", () => fitView());
    $("#btnLocate").addEventListener("click", locateMe);
    $("#btnConn").addEventListener("click", openConnections);
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

  // Events on the map: scope + time filters, plus the map search query unless noQuery.
  function mapFiltered(noQuery) {
    return C.filterSessions(sessions, { scope: state.mapScope, checked, block: activeBlock(), mappedOnly: true,
      query: noQuery ? "" : state.mapQuery });
  }

  // ---------------- map search ----------------
  const MAX_PLACES = 8, MAX_EVENTS = 40;
  let placeMatches = [];
  function setupMapSearch() {
    const input = $("#mapSearch");
    input.value = state.mapQuery || "";
    placeMatches = C.searchLocations(mapData.locations, state.mapQuery);
    let t = null;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.mapQuery = input.value; saveState();
        placeMatches = C.searchLocations(mapData.locations, state.mapQuery);
        view.focusLoc = null; // a new search drops the previously picked place
        renderMap();
        setMapResults(!!state.mapQuery.trim());
      }, 120);
    });
    input.addEventListener("focus", () => { if (state.mapQuery.trim()) setMapResults(true); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    input.addEventListener("click", (e) => e.stopPropagation());
    $("#mapResults").addEventListener("click", (e) => {
      e.stopPropagation();
      const done = e.target.closest("[data-close]");
      if (done) { setMapResults(false); return; }
      const p = e.target.closest("[data-place]");
      if (p) { setMapResults(false); input.blur(); focusLocation(p.dataset.place); return; }
      const s = e.target.closest("[data-sid]");
      if (s) { setMapResults(false); input.blur(); showOnMap(byId.get(s.dataset.sid)); }
    });
    document.addEventListener("click", () => setMapResults(false));
  }
  function setMapResults(open) {
    if (open) renderMapResults();
    $("#mapResults").hidden = !open;
    $("#mapSearch").setAttribute("aria-expanded", open ? "true" : "false");
  }
  function renderMapResults() {
    const q = state.mapQuery.trim();
    if (!q) { $("#mapResults").innerHTML = ""; return; }
    // events at each place under the current filters (the query matched the place itself)
    const perLoc = C.groupBy(mapFiltered(true), (s) => s.loc);
    const events = mapFiltered().sort((a, b) => a.startMs - b.startMs);
    const filtTxt = filterLabel();
    const places = placeMatches.slice(0, MAX_PLACES).map((l) => {
      const n = (perLoc.get(l.id) || []).length;
      return `<button class="res" role="option" data-place="${esc(l.id)}">
        <span class="res-ico">${l.id.startsWith("b") ? "▣" : "⌖"}</span>
        <span class="res-main"><span class="res-title">${esc(l.t)}</span>
        <span class="res-sub">${esc(layerById.get(l.l)?.name || "")}${n ? ` · ${n} event${n > 1 ? "s" : ""} ${esc(filtTxt)}` : ""}</span></span></button>`;
    }).join("");
    const evs = events.slice(0, MAX_EVENTS).map((s) => `<button class="res" role="option" data-sid="${esc(s.id)}">
        <span class="res-ico">${checked.has(s.id) ? "★" : "•"}</span>
        <span class="res-main"><span class="res-title">${esc(s.title)}</span>
        <span class="res-sub">${esc(C.fmtDay(s.startMs))} · ${C.fmtRange(s.startMs, s.endMs)} · ${esc(s.room || "")}</span></span></button>`).join("");
    const more = (n, max) => (n > max ? `<div class="res-more">+${n - max} more, refine the search</div>` : "");
    $("#mapResults").innerHTML = `
      <div class="res-head"><span>Places (${placeMatches.length})</span><button class="btn ghost" data-close>Close</button></div>
      ${places || `<div class="res-empty">No rooms or booths match.</div>`}${more(placeMatches.length, MAX_PLACES)}
      <div class="res-head"><span>Events ${filtTxt ? esc(filtTxt) + " " : ""}(${events.length})</span></div>
      ${evs || `<div class="res-empty">No events match${filtTxt ? " with these filters" : ""}.</div>`}${more(events.length, MAX_EVENTS)}`;
  }
  // short description of the map's scope/time filters, e.g. "★ checked · Tue PM"
  function filterLabel() {
    const b = activeBlock();
    const parts = [];
    if (state.mapScope === "checked") parts.push("★ checked");
    if (b) parts.push(b.label || "no upcoming block");
    return parts.length ? `(${parts.join(" · ")})` : "";
  }
  function focusLocation(id) {
    const L = locById.get(id); if (!L) return;
    view.focusLoc = id;
    setLayer(L.l, { center: { x: L.x, y: L.y, scale: Math.max(view.scale, 2.2) } }).then(() => {
      const m = $(`#markerLayer [data-loc="${CSS.escape(id)}"]`);
      if (m) { m.classList.add("pulse"); setTimeout(() => m.classList.remove("pulse"), 2500); }
    });
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
    const q = state.mapQuery.trim();
    const timeTxt = (q ? ` matching “${q}”` : "") + (b ? (b.label ? ` in ${b.longLabel}` : " (no upcoming block)") : "");
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
    if (m) {
      const mk = m.closest(".marker");
      if (mk.dataset.conn) openConnector(+mk.dataset.conn);
      else if (mk.dataset.portal) openPortal(mk.dataset.portal);
      else openLocation(mk.dataset.loc);
      return;
    }
    for (const el of els) {
      const hit = el.closest && el.closest("#mapStage [id]");
      if (hit && locById.has(hit.id)) { openLocation(hit.id); return; }
    }
  }

  function renderMarkers() {
    const layer = $("#markerLayer");
    const stage = $("#mapStage");
    $$(".hl, .hl-checked, .hl-match, .hl-focus", stage).forEach((el) => el.classList.remove("hl", "hl-checked", "hl-match", "hl-focus"));
    const shapeOf = (id) => stage.querySelector(`[id="${CSS.escape(id)}"]`);
    // rooms/booths matching the map search get an outline (event highlights below take precedence)
    if (state.mapQuery.trim()) {
      for (const l of placeMatches.filter((p) => p.l === view.layer).slice(0, 80)) shapeOf(l.id)?.classList.add("hl-match");
    }
    const list = mapFiltered().filter((s) => locById.get(s.loc)?.l === view.layer);
    const byLoc = C.groupBy(list, (s) => s.loc);
    const n = now();
    let html = state.showConn ? connectorMarkers() : "";
    for (const [loc, items] of byLoc) {
      const L = locById.get(loc);
      const anyChecked = items.some((s) => checked.has(s.id));
      const live = items.some((s) => s.startMs <= n && s.endMs > n);
      const shape = shapeOf(loc);
      if (shape) { shape.classList.remove("hl-match"); shape.classList.add(anyChecked ? "hl-checked" : "hl"); }
      html += `<button class="marker ${anyChecked ? "checked" : ""} ${live ? "live" : ""}" data-loc="${esc(loc)}" data-x="${L.x}" data-y="${L.y}" aria-label="${esc(L.t)}: ${items.length} events">
        <span class="count">${anyChecked ? "★" : ""}${items.length}</span><span class="lbl">${esc(shortRoom(L.t))}</span></button>`;
    }
    // place picked from the map search: pin it even when it has no events
    const F = view.focusLoc && locById.get(view.focusLoc);
    if (F && F.l === view.layer) {
      const shape = shapeOf(F.id);
      if (shape) { shape.classList.remove("hl-match"); shape.classList.add("hl-focus"); }
      if (!byLoc.has(F.id)) {
        html += `<button class="marker pin" data-loc="${esc(F.id)}" data-x="${F.x}" data-y="${F.y}" aria-label="${esc(F.t)}">
          <span class="count">⌖</span><span class="lbl">${esc(shortRoom(F.t))}</span></button>`;
      }
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
    $("#btnConn").classList.toggle("on", !!state.showConn);
    positionYou();
  }

  function openLocation(locId) {
    const L = locById.get(locId); if (!L) return;
    const filtered = mapFiltered(true).filter((s) => s.loc === locId);
    const all = sessions.filter((s) => s.loc === locId && !filtered.includes(s));
    const exh = (exhibitors.booths[locId] || []).map((id) => [id, exhibitors.orgs[id]]).filter(([, o]) => o);
    // a booth with exhibitor info and no events at all doesn't need the "no events" line
    const events = exh.length && !filtered.length && !all.length ? "" : `
      ${filtered.length ? `<h4>Matching filters (${filtered.length})</h4>${filtered.map((s) => sessionRow(s, { showDay: true })).join("")}` : `<p class="muted">No events here match the current filters.</p>`}
      ${all.length ? `<details><summary>Other events in this room (${all.length})</summary>${all.map((s) => sessionRow(s, { showDay: true })).join("")}</details>` : ""}`;
    openSheet(`
      <div class="sheet-h"><div><div class="item-time">${esc(layerById.get(L.l)?.name || "")}</div><h3>${esc(L.t)}</h3></div></div>
      ${exh.map(([id, o]) => exhibitorCard(id, o, exh.length > 1)).join("")}
      ${events}
    `);
  }

  // showName: the booth title already names a lone exhibitor; shared booths list each one
  function exhibitorCard(id, o, showName) {
    const host = o.u ? o.u.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/.*$/, "") : "";
    const logo = o.g ? `<img class="exh-logo" src="logos/${esc(id)}.webp" alt="">`
      : `<div class="exh-logo exh-initial" aria-hidden="true">${esc((o.n.match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase())}</div>`;
    return `<div class="exh">${logo}<div class="exh-body">
      ${showName ? `<div class="exh-name">${esc(o.n)}</div>` : ""}
      ${o.d ? `<p class="exh-desc">${esc(o.d)}</p>` : ""}
      ${o.u ? `<button class="btn exh-web" data-url="${esc(o.u)}">${esc(host || "Website")} ↗</button>` : ""}
    </div></div>`;
  }

  function showOnMap(s) {
    if (!s || !s.loc) return;
    const L = locById.get(s.loc);
    // make sure the event is visible under the current search + filters (drop the search first)
    if (!mapFiltered().some((x) => x.id === s.id) && state.mapQuery) {
      state.mapQuery = ""; $("#mapSearch").value = ""; placeMatches = []; saveState();
    }
    const visible = mapFiltered().some((x) => x.id === s.id);
    view.focusLoc = null;
    if (!visible) { state.mapScope = checked.has(s.id) ? state.mapScope : "all"; state.mapTime = "any"; saveState(); }
    showView("map");
    setLayer(L.l, { center: { x: L.x, y: L.y, scale: Math.max(view.scale, 2.2) } }).then(() => {
      const m = $(`#markerLayer [data-loc="${CSS.escape(s.loc)}"]`);
      if (m) { m.classList.add("pulse"); setTimeout(() => m.classList.remove("pulse"), 2500); }
    });
  }

  // ---------------- floor connections ----------------
  // Stairs / escalators / elevators drawn on top of the floor plan (the plans' own icons are a few
  // pixels wide on a phone), tap one to jump to the same spot on another floor; plus "portal"
  // pills for the links between buildings and a sheet that shows how all the maps connect.
  const CONN_NAME = { esc: "Escalator", elev: "Elevator", stairs: "Stairs" };
  const CONN_ICON = {
    stairs: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 13.5h3.5v-3h3v-3h3v-3h3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
    esc: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 13h3.5l6-8.5h3.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 12.5l3-3.2m0 0v2.4m0-2.4h-2.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    elev: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l4.2 5H3.8zM8 14.5l4.2-5H3.8z" fill="currentColor"/></svg>`,
  };
  const layerName = (id) => layerById.get(id)?.name || id;

  function connectorMarkers() {
    let html = "";
    (conn.floors[view.layer] || []).forEach((c, i) => {
      html += `<button class="marker conn k-${c.k}" data-conn="${i}" data-x="${c.x}" data-y="${c.y}" aria-label="${CONN_NAME[c.k]}"><span class="cico">${CONN_ICON[c.k]}</span></button>`;
    });
    for (const p of conn.portals.filter((p) => p.l === view.layer)) {
      html += `<button class="marker portal" data-portal="${esc(p.id)}" data-x="${p.x}" data-y="${p.y}" aria-label="${esc(p.title)}"><span class="pchip">⇄ ${esc(p.label)}</span></button>`;
    }
    return html;
  }

  function openConnector(i) {
    const c = (conn.floors[view.layer] || [])[i]; if (!c) return;
    const links = C.connectorLinks(mapData.layers, conn.floors, view.layer, c);
    const same = links.filter((l) => l.same), near = links.filter((l) => !l.same);
    const row = (l) => `<button class="res" data-goto="${esc(l.layer)}" data-x="${l.x}" data-y="${l.y}">
        <span class="res-ico conn-ico k-${l.k}">${CONN_ICON[l.k]}</span>
        <span class="res-main"><span class="res-title">${esc(layerName(l.layer))}</span>
        <span class="res-sub">${CONN_NAME[l.k]} · ≈${l.m} m away</span></span></button>`;
    openSheet(`
      <div class="sheet-h"><div><div class="item-time">${esc(layerName(view.layer))}</div><h3><span class="conn-ico k-${c.k}">${CONN_ICON[c.k]}</span> ${CONN_NAME[c.k]}</h3></div></div>
      ${same.length ? `<h4>Same ${CONN_NAME[c.k].toLowerCase()} on other floors</h4>${same.map(row).join("")}` : ""}
      ${near.length ? `<h4>Nearby on other floors</h4>${near.map(row).join("")}` : ""}
      ${links.length ? "" : `<p class="muted">Nothing lines up with this on the other mapped floors${layerById.get(view.layer)?.building === "west" ? "" : " (this building has only one mapped level)"}. It may lead to a level that isn't mapped.</p>`}
      <p class="muted small">Matched by position across the floor plans (about ±10 m). Tap a floor to jump to that spot.</p>
      <div class="actions"><button class="btn" data-conn-overview>⇅ How the floors connect</button></div>`);
  }

  function openPortal(id) {
    const p = conn.portals.find((x) => x.id === id); if (!p) return;
    openSheet(`
      <div class="sheet-h"><div><div class="item-time">${esc(layerName(p.l))}</div><h3>⇄ ${esc(p.title)}</h3></div></div>
      <p>${esc(p.text)}</p>
      <div class="actions">
        ${p.to ? `<button class="btn primary" data-goto="${esc(p.to)}">Go to ${esc(layerName(p.to))}</button>` : ""}
        <button class="btn" data-conn-overview>⇅ How the floors connect</button>
      </div>`);
  }

  // Schematic of all floors: buildings side by side, levels stacked, with what links them.
  function connectionDiagram() {
    const has = (id) => layerById.has(id);
    const fl = (id, sub) => has(id)
      ? `<button class="cd-floor ${view.layer === id ? "here" : ""}" data-goto="${id}"><b>${esc(layerName(id))}</b><span>${esc(sub)}</span></button>`
      : `<div class="cd-floor off"><b>${esc(id)}</b><span>${esc(sub)}</span></div>`;
    const kinds = (a, b) => C.floorPairKinds(mapData.layers, conn.floors, a, b).map((k) => `<span class="conn-ico k-${k}" title="${CONN_NAME[k]}">${CONN_ICON[k]}</span>`).join("");
    const vlink = (a, b, extra = "") => `<div class="cd-v">${kinds(a, b)}${extra}</div>`;
    const off = (t, sub) => `<div class="cd-floor off"><b>${esc(t)}</b><span>${esc(sub)}</span></div>`;
    const h = (t, sub) => `<div class="cd-h">${esc(t)}<span>${esc(sub)}</span></div>`;
    const skip = C.floorPairKinds(mapData.layers, conn.floors, "West1", "west3").includes("esc") &&
      !C.floorPairKinds(mapData.layers, conn.floors, "West1", "west2").includes("esc");
    return `<div class="cd">
      <div class="cd-lvl"></div>${h("West", "")}<div></div>${h("South", "")}<div></div>${h("Lakeside", "")}
      <div class="cd-lvl">L4</div>${fl("west4", "Rooms W470–476")}<div></div><div></div><div></div><div></div>
      <div class="cd-lvl"></div>${vlink("west3", "west4")}<div></div><div></div><div></div><div></div>
      <div class="cd-lvl">L3</div>${fl("west3", "Hall F · Skyline · Registration")}
        <div class="cd-link">⇄<span>Skybridge</span></div>${off("South upper", "not mapped")}
        <div class="cd-link">⇄<span>Grand Concourse</span></div>${fl("lakeside3", "Lakeside Ballroom")}
      <div class="cd-lvl"></div>${vlink("west2", "west3", skip ? `<span class="cd-note">escalators W1↔W3 skip W2</span>` : "")}<div></div>
        <div class="cd-v">${["esc", "elev", "stairs"].map((k) => `<span class="conn-ico k-${k}">${CONN_ICON[k]}</span>`).join("")}</div><div></div><div></div>
      <div class="cd-lvl">L2</div>${fl("west2", "Concessions")}<div></div><div class="cd-gap"></div><div></div><div></div>
      <div class="cd-lvl"></div>${vlink("West1", "west2")}<div></div><div class="cd-gap"></div><div></div><div></div>
      <div class="cd-lvl">L1</div>${fl("West1", "Rooms W171–W196 · Lobby")}<div></div>${fl("south1", "Grand Ballroom · S101–S106")}
        <div class="cd-link">⇄<span>North L1</span></div>${off("North", "no map")}
    </div>`;
  }

  function openConnections() {
    const legend = ["esc", "elev", "stairs"].map((k) => `<span class="cd-leg"><span class="conn-ico k-${k}">${CONN_ICON[k]}</span>${CONN_NAME[k]}</span>`).join("");
    const portals = conn.portals.map((p) => `<button class="res" data-portal-go="${esc(p.id)}">
        <span class="res-ico">⇄</span><span class="res-main"><span class="res-title">${esc(p.title)}</span>
        <span class="res-sub">on ${esc(layerName(p.l))} · show on map</span></span></button>`).join("");
    openSheet(`
      <div class="sheet-h"><h3>⇅ How the floors connect</h3></div>
      <div class="actions" style="margin-top:4px"><button class="btn ${state.showConn ? "primary" : ""}" data-conn-toggle>${state.showConn ? "✓ Showing" : "Show"} stairs, escalators &amp; elevators on the map</button></div>
      <div class="cd-legend">${legend}</div>
      ${connectionDiagram()}
      <p class="muted small">Tap a floor to open it. Icons between West floors show what lines up between those two levels on the plans. On the map, tap an icon to jump to the same spot one floor up or down.</p>
      <h4>Between buildings</h4>${portals}
      <p class="muted small">Skybridge: West 3 → South Building upper level, then escalators down to South 1. Grand Concourse: North/South → Lakeside 3. These follow the venue's own plans; the South upper level and North Building aren't mapped here.</p>`);
  }

  function goToSpot(layer, x, y) {
    closeSheet();
    if (x == null || y == null || isNaN(x)) { setLayer(layer, { fit: true }); return; }
    if (!state.showConn) { state.showConn = true; saveState(); }
    setLayer(layer, { center: { x, y, scale: Math.max(view.scale, 2.2) } }).then(() => {
      const m = $$("#markerLayer .marker.conn, #markerLayer .marker.portal").find((el) => +el.dataset.x === x && +el.dataset.y === y);
      if (m) { m.classList.add("pulse"); setTimeout(() => m.classList.remove("pulse"), 2500); }
    });
  }

  function connSheetClick(e) {
    const g = e.target.closest("[data-goto]");
    if (g) { e.stopPropagation(); if (state.view !== "map") showView("map"); goToSpot(g.dataset.goto, g.dataset.x != null ? +g.dataset.x : null, g.dataset.y != null ? +g.dataset.y : null); return true; }
    const pg = e.target.closest("[data-portal-go]");
    if (pg) { const p = conn.portals.find((x) => x.id === pg.dataset.portalGo); if (p) { if (state.view !== "map") showView("map"); goToSpot(p.l, p.x, p.y); } return true; }
    if (e.target.closest("[data-conn-overview]")) { openConnections(); return true; }
    if (e.target.closest("[data-conn-toggle]")) { state.showConn = !state.showConn; saveState(); renderMarkers(); positionMarkers(); openConnections(); return true; }
    return false;
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
      if (!$("#mapResults").hidden) { setMapResults(false); return true; }
      if (state.view !== "schedule") { showView("schedule"); return true; }
      return false;
    },
    setNow(iso) { nowOverride = iso ? Date.parse(iso) : null; refreshBlocks(); renderAll(); },
    debug() {
      return {
        ready: document.body.dataset.ready === "1", view: state.view, layer: view.layer, checked: [...checked], notInterested: [...notInterested],
        gps: gps.status, fix: gps.fix, markers: $$("#markerLayer .marker[data-loc]").map((m) => m.dataset.loc),
        connectors: $$("#markerLayer .marker.conn").length, portals: $$("#markerLayer .marker.portal").map((m) => m.dataset.portal),
        you: youOnLayer(), mapScope: state.mapScope, mapTime: state.mapTime, block: activeBlock()?.key || null,
        notice: $("#mapNotice").hidden ? "" : $("#mapNotice").textContent, svg: !!$("#mapStage svg"),
        scale: view.scale, sheetOpen: !$("#sheet").hidden,
      };
    },
    // used by the instrumented tests
    _internals: {
      toggleCheck, setNotInterested, showView, setLayer, byId, sessions: () => sessions, openConnector, openPortal, openConnections, openLocation, openSession,
      locLayer: (id) => locById.get(id)?.l || null,
      geoOfLocation(id) {
        const l = locById.get(id), L = layerById.get(l.l);
        return { ...C.svgToGeo(L.geo, l.x, l.y), x: l.x, y: l.y, layer: l.l };
      },
    },
  };

  boot().catch((e) => { document.body.innerHTML = `<pre class="fatal">Failed to start: ${esc(e && e.stack || e)}</pre>`; });
})();
