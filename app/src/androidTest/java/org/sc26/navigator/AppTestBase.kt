package org.sc26.navigator

import android.Manifest
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.location.Location
import android.location.LocationManager
import android.location.provider.ProviderProperties
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Shared helpers for the instrumented tests: launching, JS evaluation, shell, mock GPS.
 *
 * The tests wipe the app's saved state and toggle location / airplane mode / Wi-Fi / data, so they only
 * run on emulators. To run them on a real device anyway, pass
 * `-Pandroid.testInstrumentationRunnerArguments.allowRealDevice=true`.
 */
abstract class AppTestBase {

    /** Runs before any subclass @Before (JUnit runs superclass @Before methods first). */
    @Before
    fun onlyOnEmulatorUnlessAllowed() {
        val allowed = InstrumentationRegistry.getArguments().getString("allowRealDevice") == "true"
        assumeTrue("skipping on a real device (would wipe saved state / toggle radios)", allowed || isEmulator())
    }

    private fun isEmulator() =
        Build.FINGERPRINT.contains("generic") || Build.HARDWARE in setOf("ranchu", "goldfish") ||
            Build.PRODUCT.startsWith("sdk") || Build.MODEL.contains("Emulator")

    @get:Rule
    val perms: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION,
    )

    protected val instr get() = InstrumentationRegistry.getInstrumentation()
    protected val ctx: Context get() = instr.targetContext
    protected lateinit var scenario: ActivityScenario<MainActivity>
    protected val launched get() = ::scenario.isInitialized
    protected val lm get() = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager

    protected fun shell(cmd: String): String {
        val pfd = instr.uiAutomation.executeShellCommand(cmd)
        return android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd).bufferedReader().readText()
    }

    /** Fresh state (no saved checks, permission prompt already shown) and a launched activity. */
    protected fun launchApp() {
        ctx.getSharedPreferences("sc26", Context.MODE_PRIVATE).edit().clear().putBoolean("askedLocation", true).commit()
        scenario = ActivityScenario.launch(MainActivity::class.java)
        waitFor("app ready") { js("SC26.debug().ready") == "true" }
    }

    protected fun installMockGps() {
        shell("appops set ${ctx.packageName} android:mock_location allow")
        removeMockGps()
        lm.addTestProvider(
            LocationManager.GPS_PROVIDER, false, false, false, false, true, true, true,
            ProviderProperties.POWER_USAGE_LOW, ProviderProperties.ACCURACY_FINE,
        )
        lm.setTestProviderEnabled(LocationManager.GPS_PROVIDER, true)
    }

    protected fun removeMockGps() {
        try { lm.removeTestProvider(LocationManager.GPS_PROVIDER) } catch (_: Exception) {}
    }

    protected fun mockFix(lat: Double, lon: Double, acc: Float = 8f) {
        val l = Location(LocationManager.GPS_PROVIDER).apply {
            latitude = lat; longitude = lon; accuracy = acc; altitude = 180.0
            time = System.currentTimeMillis(); elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
        }
        lm.setTestProviderLocation(LocationManager.GPS_PROVIDER, l)
    }

    protected fun js(expr: String): String {
        var out = "null"
        val latch = CountDownLatch(1)
        scenario.onActivity { a ->
            a.webView.evaluateJavascript("(function(){try{return JSON.stringify($expr)}catch(e){return 'ERR:'+e}})()") {
                out = it; latch.countDown()
            }
        }
        assertTrue("js timeout: $expr", latch.await(10, TimeUnit.SECONDS))
        // evaluateJavascript returns a JSON-encoded string of our JSON string
        val json = if (out == "null") "null" else JSONArray("[$out]").getString(0)
        // unwrap plain strings so callers get raw text; objects/arrays/numbers stay JSON
        return if (json.startsWith("\"")) JSONArray("[$json]").getString(0) else json
    }

    protected fun debug(): JSONObject = JSONObject(js("SC26.debug()"))

    protected fun waitFor(what: String, timeoutMs: Long = 15_000, cond: () -> Boolean) {
        val end = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < end) {
            if (try { cond() } catch (_: Exception) { false }) return
            SystemClock.sleep(200)
        }
        throw AssertionError("timed out waiting for $what; state=${try { debug() } catch (e: Exception) { e }}")
    }

    protected fun tap(css: String) {
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, css)).perform(webClick())
    }

    protected fun screenshot(name: String) {
        SystemClock.sleep(400)
        val bmp: Bitmap = instr.uiAutomation.takeScreenshot() ?: return
        val dir = File(ctx.getExternalFilesDir(null), "screens").apply { mkdirs() }
        FileOutputStream(File(dir, "$name.png")).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
