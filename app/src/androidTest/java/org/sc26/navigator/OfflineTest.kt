package org.sc26.navigator

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The app must be fully usable with no internet, no Wi-Fi, no mobile data and no GPS, including on an
 * emulator. Each test cuts the relevant radios / location *before* launching the app (cold start).
 * Like all tests here, they are skipped on real devices unless `allowRealDevice=true` (see [AppTestBase]).
 */
@RunWith(AndroidJUnit4::class)
class OfflineTest : AppTestBase() {

    @After
    fun tearDown() {
        if (launched) scenario.close()
        MainActivity.providerOverride = null
        removeMockGps()
        setRadios(on = true)
        shell("cmd location set-location-enabled true")
    }

    // ---------------- helpers ----------------

    /** Airplane mode + Wi-Fi + mobile data, all toggled together. */
    private fun setRadios(on: Boolean) {
        shell("cmd connectivity airplane-mode ${if (on) "disable" else "enable"}")
        shell("svc wifi ${if (on) "enable" else "disable"}")
        shell("svc data ${if (on) "enable" else "disable"}")
    }

    private fun goOffline() {
        setRadios(on = false)
        waitFor("airplane mode on") { shell("settings get global airplane_mode_on").trim() == "1" }
        // prove there is really no connectivity (works whether or not the host has internet)
        waitFor("no network", 20_000) { !shell("ping -c 1 -W 1 8.8.8.8").contains("1 received") }
    }

    /** Core features work: data loaded, schedule renders, search, checking, plan, and every floor plan. */
    private fun assertFullyUsable() {
        assertTrue("schedule loaded from bundled assets", js("SC26._internals.sessions().length").toInt() > 300)
        assertTrue("schedule list rendered", js("document.querySelectorAll('#scheduleList [data-check]').length").toInt() > 0)

        // check a session and see it in My Plan
        val id = js("document.querySelector('#scheduleList [data-check]').dataset.check")
        tap("#scheduleList [data-check]")
        waitFor("checked") { debug().getJSONArray("checked").toString().contains(id) }
        tap(".tabs [data-view='plan']")
        waitFor("in plan") { js("document.querySelector('#planList [data-sid]').dataset.sid") == id }

        // every floor plan SVG loads and renders
        tap(".tabs [data-view='map']")
        waitFor("svg") { debug().getBoolean("svg") }
        val layers = JSONArray(js("[...document.querySelectorAll('#floorChips .chip')].map(c => c.dataset.layer)"))
        assertEquals("all floor plans present", 7, layers.length())
        for (i in 0 until layers.length()) {
            val l = layers.getString(i)
            tap("#floorChips [data-layer='$l']")
            waitFor("floor $l rendered") {
                debug().getString("layer") == l &&
                    js("document.querySelector('#mapStage svg')?.getBBox().width > 0") == "true"
            }
        }
    }

    /** Anything that is not a bundled asset is refused, so nothing can hang waiting on the network. */
    private fun assertExternalRequestsBlocked() {
        js("(window.__ext = null, fetch('https://sc26.supercomputing.org/').then(r => __ext = 'status:' + r.status, () => __ext = 'failed'), 1)")
        waitFor("external fetch settles") { js("window.__ext") != "null" }
        assertNotEquals("external request must not succeed", "status:200", js("window.__ext"))
    }

    // ---------------- tests ----------------

    @Test
    fun worksWithNoInternetNoWifiNoDataAndLocationOff() {
        goOffline()
        shell("cmd location set-location-enabled false")
        launchApp()

        waitFor("gps off reported") { debug().getString("gps") == "off" }
        assertFullyUsable()
        assertTrue(debug().getString("notice").contains("Location is off"))
        assertEquals("GPS off", js("document.getElementById('gpsPill').textContent"))
        assertExternalRequestsBlocked()
        screenshot("10-offline-no-location")

        // checked state persists across a restart while still offline
        val checked = debug().getJSONArray("checked").toString()
        scenario.recreate()
        waitFor("ready after restart") { js("SC26.debug().ready") == "true" }
        waitFor("state restored") { debug().getJSONArray("checked").toString() == checked }
    }

    @Test
    fun gpsWorksWithoutInternet() {
        goOffline()
        shell("cmd location set-location-enabled true")
        installMockGps()
        launchApp()

        tap(".tabs [data-view='map']")
        waitFor("svg") { debug().getBoolean("svg") }
        val geo = JSONObject(js("SC26._internals.geoOfLocation('rW375de')"))
        js("SC26._internals.setLayer(${JSONObject.quote(geo.getString("layer"))})")
        waitFor("fix delivered offline", 20_000) {
            mockFix(geo.getDouble("lat"), geo.getDouble("lon"))
            debug().getString("gps") == "ok"
        }
        waitFor("blue dot on the floor plan") { debug().optJSONObject("you")?.optBoolean("inside") == true }
        assertEquals("false", js("document.getElementById('youDot').hidden"))
        screenshot("11-offline-gps-dot")
    }

    @Test
    fun worksOnDeviceWithNoGpsHardware() {
        goOffline()
        MainActivity.providerOverride = emptyList() // emulate a device/emulator with no location providers
        launchApp()

        waitFor("no gps reported") { debug().getString("gps") == "unavailable" }
        assertEquals("No GPS", js("document.getElementById('gpsPill').textContent"))
        assertFullyUsable()
        assertTrue(debug().getString("notice").contains("No GPS on this device"))
        // tapping locate with no GPS must not break anything
        tap("#btnLocate")
        assertTrue(debug().getBoolean("svg"))
        screenshot("12-offline-no-gps-hardware")
    }

    @Test
    fun mapSurvivesEveryLocationState() {
        goOffline()
        launchApp()
        tap(".tabs [data-view='map']")
        waitFor("svg") { debug().getBoolean("svg") }
        // includes "searching" forever (GPS on but no satellite fix) and permission denied
        for (status in listOf("searching", "denied", "unavailable", "off", "error")) {
            js("SC26.onLocationStatus(${JSONObject.quote(status)})")
            assertEquals(status, debug().getString("gps"))
            tap("#floorChips [data-layer='west3']")
            waitFor("floor switch with gps=$status") { debug().getString("layer") == "west3" && debug().getBoolean("svg") }
            tap("#floorChips [data-layer='West1']")
            waitFor("floor back with gps=$status") { debug().getString("layer") == "West1" }
        }
    }
}
