package org.sc26.navigator

import android.Manifest
import android.content.pm.PackageManager
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NavigatorTest : AppTestBase() {

    @Before
    fun setUp() {
        shell("cmd location set-location-enabled true")
        installMockGps()
        launchApp()
    }

    @After
    fun tearDown() {
        if (launched) scenario.close()
        removeMockGps()
        shell("cmd location set-location-enabled true")
    }

    // ---------------- tests ----------------

    @Test
    fun appIsOfflineOnly() {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, PackageManager.GET_PERMISSIONS)
        assertFalse("must not request INTERNET", pi.requestedPermissions.orEmpty().contains(Manifest.permission.INTERNET))
        // data came from bundled assets
        assertTrue(js("SC26._internals.sessions().length").toInt() > 300)
    }

    @Test
    fun checkingSessionPersistsAcrossRestart() {
        js("SC26.setNow('2026-11-17T14:00:00Z')")
        tap("#dayChips [data-day='2026-11-17']")
        val firstId = js("document.querySelector('#scheduleList [data-check]').dataset.check")
        tap("#scheduleList [data-check]")
        waitFor("checked") { debug().getJSONArray("checked").toString().contains(firstId) }
        assertEquals("1", js("document.getElementById('planCount').textContent"))
        screenshot("01-schedule-checked")

        scenario.recreate()
        waitFor("ready after restart") { js("SC26.debug().ready") == "true" }
        SystemClock.sleep(300)
        assertTrue(debug().getJSONArray("checked").toString().contains(firstId))
        tap(".tabs [data-view='plan']")
        assertEquals(firstId, js("document.querySelector('#planList [data-sid]').dataset.sid"))
        screenshot("02-my-plan")
    }

    @Test
    fun notInterestedMovesSessionToBottomSectionAndBack() {
        js("SC26.setNow('2026-11-17T14:00:00Z')")
        tap("#dayChips [data-day='2026-11-17']")
        val id = js("document.querySelector('#scheduleList .slot [data-notint]').dataset.notint")
        val inSlots = "document.querySelectorAll('#scheduleList .slot [data-sid=' + JSON.stringify(${JSONObject.quote(id)}) + ']').length"
        val inSection = "document.querySelectorAll('#scheduleList .notint-item[data-sid=' + JSON.stringify(${JSONObject.quote(id)}) + ']').length"
        tap("#scheduleList .slot [data-notint]")
        waitFor("not interested") { debug().getJSONArray("notInterested").toString().contains(id) }
        assertEquals("0", js(inSlots))
        assertEquals("1", js(inSection))
        assertTrue(js("document.getElementById('notIntSection').textContent").contains("Not interested"))
        screenshot("03-not-interested")

        scenario.recreate()
        waitFor("ready after restart") { js("SC26.debug().ready") == "true" }
        SystemClock.sleep(300)
        assertEquals("1", js(inSection))
        tap("#scheduleList .notint-item [data-notint]")
        waitFor("interested again") { !debug().getJSONArray("notInterested").toString().contains(id) }
        assertEquals("1", js(inSlots))
        assertEquals("false", js("!!document.getElementById('notIntSection')"))
    }

    @Test
    fun mapFiltersCheckedAndNextBlock() {
        // Tuesday 8:00 CST -> current block Tue AM, next block Tue PM
        js("SC26.setNow('2026-11-17T14:00:00Z')")
        // Check one mapped session in Tue PM and one on Wed AM, on different rooms.
        val ids = JSONArray(js("""(function(){
            const S = SC26._internals.sessions().filter(s => s.loc);
            const a = S.find(s => s.start >= '2026-11-17T19:00:00Z' && s.start < '2026-11-17T22:00:00Z' && s.endMs - s.startMs < 4*3600e3);
            const b = S.find(s => s.start >= '2026-11-18T15:00:00Z' && s.start < '2026-11-18T17:00:00Z' && s.loc !== a.loc && s.endMs - s.startMs < 4*3600e3);
            return [a.id, a.loc, b.id, b.loc];
        })()"""))
        js("SC26._internals.toggleCheck(${JSONObject.quote(ids.getString(0))}, true)")
        js("SC26._internals.toggleCheck(${JSONObject.quote(ids.getString(2))}, true)")

        tap(".tabs [data-view='map']")
        waitFor("svg") { debug().getBoolean("svg") }
        tap("#mapFilters [data-scope='checked']")
        tap("#mapFilters [data-time='next']")
        assertTrue(js("document.getElementById('chipNext').textContent").contains("Tue PM"))
        val locA = ids.getString(1)
        js("SC26._internals.setLayer(${JSONObject.quote(layerOf(locA))})")
        waitFor("marker for checked Tue PM session") { debug().getJSONArray("markers").toString().contains(locA) }
        assertFalse(debug().getJSONArray("markers").toString().contains(ids.getString(3)))
        assertEquals("2026-11-17-PM", debug().getString("block"))
        screenshot("03-map-checked-next-block")

        // Any time: Wednesday's checked session is now included (on its own floor)
        tap("#mapFilters [data-time='any']")
        js("SC26._internals.setLayer(${JSONObject.quote(layerOf(ids.getString(3)))})")
        waitFor("marker for Wed session") { debug().getJSONArray("markers").toString().contains(ids.getString(3)) }

        // All events, next block: many markers
        tap("#mapFilters [data-scope='all']")
        tap("#mapFilters [data-time='next']")
        js("SC26._internals.setLayer('West1')")
        waitFor("several markers") { debug().getJSONArray("markers").length() > 3 }
        screenshot("04-map-all-next-block")
    }

    @Test
    fun floorConnectionsOverlayAndJumps() {
        js("SC26._internals.showView('map')")
        js("SC26._internals.setLayer('west3', {fit: true})")
        waitFor("west3 with stairs/escalators/elevators") { debug().getString("layer") == "west3" && debug().getInt("connectors") > 10 }
        assertTrue(debug().getJSONArray("portals").toString().contains("skybridge-w3"))
        // the overview sheet: diagram floors open that floor
        tap("#btnConn")
        waitFor("connections sheet") { debug().getBoolean("sheetOpen") }
        assertTrue(js("document.getElementById('sheetBody').textContent").contains("Skybridge"))
        screenshot("07-floor-connections")
        tap("#sheetBody [data-goto='west4']")
        waitFor("on west4") { debug().getString("layer") == "west4" && !debug().getBoolean("sheetOpen") }
        // layer flips before the SVG has loaded; wait for West 4's own markers (one escalator)
        waitFor("west4 markers") { js("document.querySelectorAll('#markerLayer .marker.conn.k-esc').length") == "1" }
        // the West 4 escalator lines up with one on West 3: jump there
        js("SC26._internals.openConnector(Array.from(document.querySelectorAll('#markerLayer .marker.conn')).find(m => m.classList.contains('k-esc')).dataset.conn)")
        waitFor("escalator sheet") { debug().getBoolean("sheetOpen") }
        tap("#sheetBody [data-goto='west3']")
        waitFor("jumped to west3") { debug().getString("layer") == "west3" && debug().getDouble("scale") >= 2.2 }
        screenshot("08-escalator-jump")
    }

    @Test
    fun boothSheetShowsExhibitorLogoSummaryAndWebsite() {
        js("SC26._internals.showView('map')")
        js("SC26._internals.setLayer('south1', {fit: true})")
        js("SC26._internals.openLocation('bS100')")
        waitFor("booth sheet") { debug().getBoolean("sheetOpen") }
        assertTrue(js("document.querySelector('#sheetBody h3').textContent").contains("Argonne"))
        // the bundled logo actually decodes in the WebView (WebP via the asset loader)
        waitFor("logo decoded") { js("(function(){ const i = document.querySelector('#sheetBody img.exh-logo'); return !!i && i.complete && i.naturalWidth > 0; })()") == "true" }
        assertTrue(js("document.querySelector('#sheetBody .exh-desc').textContent").length > 40)
        assertEquals("https://www.anl.gov", js("document.querySelector('#sheetBody .exh-web').dataset.url"))
        screenshot("09-booth-exhibitor")
        // a shared booth lists each exhibitor by name
        js("SC26._internals.openLocation('b3651')")
        waitFor("shared booth") { js("document.querySelectorAll('#sheetBody .exh').length") == "2" }
        assertTrue(js("document.getElementById('sheetBody').textContent").contains("StarLight"))
    }

    private fun layerOf(loc: String): String = js("SC26._internals.locLayer(${JSONObject.quote(loc)})")

    @Test
    fun mapWorksWithLocationTurnedOff() {
        shell("cmd location set-location-enabled false")
        waitFor("gps off reported") { debug().getString("gps") == "off" }
        js("SC26._internals.showView('map')")
        waitFor("svg rendered") { debug().getBoolean("svg") }
        val d = debug()
        assertTrue(d.getString("notice").contains("Location is off"))
        assertEquals("GPS off", js("document.getElementById('gpsPill').textContent"))
        assertTrue("map must have floor chips", js("document.querySelectorAll('#floorChips .chip').length").toInt() == 7)
        // the map stays interactive with location off
        tap("#floorChips [data-layer='west3']")
        waitFor("floor switch") { debug().getString("layer") == "west3" }
        screenshot("05-map-gps-off")

        // turning it back on recovers
        shell("cmd location set-location-enabled true")
        waitFor("gps back") { debug().getString("gps") != "off" }
    }

    @Test
    fun gpsFixShowsBlueDotOnFloorPlan() {
        tap(".tabs [data-view='map']")
        waitFor("svg") { debug().getBoolean("svg") }
        // GPS position of room W375de (HPC Unites Plenary hall) from the layer georeference
        val geo = JSONObject(js("SC26._internals.geoOfLocation('rW375de')"))
        // feed fixes until the app receives one (provider registration can take a moment)
        waitFor("fix delivered", 20_000) {
            mockFix(geo.getDouble("lat"), geo.getDouble("lon"))
            debug().getString("gps") == "ok"
        }
        // GPS has no floor: from another building, "locate" jumps to the West building (exhibit level W3)
        js("SC26._internals.setLayer('south1')")
        waitFor("on south1") { debug().getString("layer") == "south1" }
        tap("#btnLocate")
        waitFor("on west3 with dot") { debug().getString("layer") == "west3" && debug().optJSONObject("you")?.optBoolean("inside") == true }
        // ...and when already in the right building it keeps the chosen floor
        js("SC26._internals.setLayer('West1')")
        tap("#btnLocate")
        SystemClock.sleep(500)
        assertEquals("West1", debug().getString("layer"))
        assertTrue(debug().getJSONObject("you").getBoolean("inside"))
        js("SC26._internals.setLayer('west3')")
        waitFor("west3 again") { debug().getString("layer") == "west3" && debug().optJSONObject("you") != null }
        val you = debug().getJSONObject("you")
        val dx = you.getDouble("x") - geo.getDouble("x"); val dy = you.getDouble("y") - geo.getDouble("y")
        assertTrue("dot near W375de: $you vs $geo", Math.hypot(dx, dy) < 2)
        assertTrue(js("document.getElementById('youDot').hidden") == "false")
        assertTrue(js("document.getElementById('gpsPill').textContent").contains("±"))
        screenshot("06-map-gps-dot")

        // Far away (downtown Chicago): map still shows, with a distance notice
        waitFor("far fix", 20_000) {
            mockFix(41.8826, -87.6226, 15f)
            debug().optJSONObject("fix")?.optDouble("lat", 0.0)?.let { it > 41.88 } == true
        }
        waitFor("distance notice") { debug().getString("notice").contains("from McCormick Place") }
        assertTrue(debug().getBoolean("svg"))
        screenshot("07-map-far-away")
    }

    // ---------------- multi-touch ----------------

    /** CSS-pixel point inside the WebView -> screen pixels. */
    private fun toScreen(cssX: Double, cssY: Double): Pair<Float, Float> {
        var out = Pair(0f, 0f)
        scenario.onActivity { a ->
            val loc = IntArray(2); a.webView.getLocationOnScreen(loc)
            val d = a.resources.displayMetrics.density
            out = Pair((loc[0] + cssX * d).toFloat(), (loc[1] + cssY * d).toFloat())
        }
        return out
    }

    private fun touch(action: Int, downTime: Long, pts: List<Pair<Float, Float>>) {
        val n = pts.size
        val props = Array(n) { i -> MotionEvent.PointerProperties().apply { id = i; toolType = MotionEvent.TOOL_TYPE_FINGER } }
        val coords = Array(n) { i -> MotionEvent.PointerCoords().apply { x = pts[i].first; y = pts[i].second; pressure = 1f; size = 1f } }
        val ev = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, n, props, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
        instr.uiAutomation.injectInputEvent(ev, true)
        ev.recycle()
    }

    /** Two-finger pinch around (cx,cy) in screen px, finger 0 starting exactly at [start0]. */
    private fun pinch(start0: Pair<Float, Float>, start1: Pair<Float, Float>, factor: Float, steps: Int = 20) {
        val cx = (start0.first + start1.first) / 2; val cy = (start0.second + start1.second) / 2
        fun at(p: Pair<Float, Float>, f: Float) = Pair(cx + (p.first - cx) * f, cy + (p.second - cy) * f)
        val t0 = SystemClock.uptimeMillis()
        touch(MotionEvent.ACTION_DOWN, t0, listOf(start0))
        SystemClock.sleep(20)
        touch(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), t0, listOf(start0, start1))
        for (i in 1..steps) {
            val f = 1f + (factor - 1f) * i / steps
            touch(MotionEvent.ACTION_MOVE, t0, listOf(at(start0, f), at(start1, f)))
            SystemClock.sleep(16)
        }
        val end = listOf(at(start0, factor), at(start1, factor))
        touch(MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), t0, end)
        SystemClock.sleep(10)
        touch(MotionEvent.ACTION_UP, t0, listOf(end[0]))
    }

    @Test
    fun pinchZoomWorksEvenStartingOnAMarker() {
        js("SC26.setNow('2026-11-15T12:00:00Z')") // Sunday 6am: dense West 1 markers in the next block
        tap(".tabs [data-view='map']")
        waitFor("svg") { debug().getBoolean("svg") }
        js("SC26._internals.setLayer('West1')")
        waitFor("markers") { debug().getString("layer") == "West1" && debug().getJSONArray("markers").length() > 5 }
        SystemClock.sleep(300)
        // finger 0 on a marker near the middle of the viewport, finger 1 on bare map
        val m = JSONObject(js("""(function(){var vp=document.getElementById('mapViewport').getBoundingClientRect();
            var best=null,bd=1e9;document.querySelectorAll('#markerLayer .marker .count').forEach(function(c){var r=c.getBoundingClientRect();
            var x=r.left+r.width/2,y=r.top+r.height/2;var d=Math.hypot(x-(vp.left+vp.width/2),y-(vp.top+vp.height/2));if(d<bd){bd=d;best={x:x,y:y}}});
            best.vx=vp.left+vp.width/2;best.vy=vp.top+vp.height/2;return best})()"""))
        val onMarker = toScreen(m.getDouble("x"), m.getDouble("y"))
        val other = toScreen(m.getDouble("vx") - (m.getDouble("x") - m.getDouble("vx")) , m.getDouble("vy") + 120.0)
        val s0 = debug().getDouble("scale")

        pinch(onMarker, other, 2.0f)
        waitFor("zoomed in") { debug().getDouble("scale") > s0 * 1.6 }
        SystemClock.sleep(400)
        assertFalse("pinch must not be treated as a tap", debug().getBoolean("sheetOpen"))
        screenshot("08-pinch-zoomed")

        val s1 = debug().getDouble("scale")
        pinch(onMarker, other, 0.5f)
        waitFor("zoomed out") { debug().getDouble("scale") < s1 * 0.7 }
        assertFalse(debug().getBoolean("sheetOpen"))

        // a plain single tap on a marker still opens it
        // pick a marker whose centre is really on top (visible, not covered by another marker)
        val m2 = JSONObject(js("""(function(){var cs=document.querySelectorAll('#markerLayer .marker .count');
            for(var i=0;i<cs.length;i++){var r=cs[i].getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
              var top=document.elementFromPoint(x,y);if(top&&top.closest('.marker')===cs[i].closest('.marker'))return {x:x,y:y,loc:cs[i].closest('.marker').dataset.loc}}
            return null})()"""))
        val p = toScreen(m2.getDouble("x"), m2.getDouble("y"))
        val t0 = SystemClock.uptimeMillis()
        touch(MotionEvent.ACTION_DOWN, t0, listOf(p)); SystemClock.sleep(50); touch(MotionEvent.ACTION_UP, t0, listOf(p))
        waitFor("sheet opened by tap") { debug().getBoolean("sheetOpen") }
        assertTrue(js("document.getElementById('sheetBody').textContent").isNotEmpty())
    }
}
