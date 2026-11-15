package org.sc26.navigator

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.graphics.Color
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.FrameLayout
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.window.OnBackInvokedDispatcher
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * Thin native shell: hosts the bundled (offline) web UI and feeds it GPS fixes.
 * The map and schedule never depend on location being available.
 */
class MainActivity : Activity() {

    companion object {
        const val TAG = "SC26"
        const val START_URL = "https://appassets.androidplatform.net/assets/www/index.html"
        private const val REQ_LOCATION = 42
        private const val PREFS = "sc26"
        private const val KEY_STATE = "state"

        /**
         * Test hook: when non-null, replaces the device's location providers. `emptyList()` simulates a
         * device (or emulator) with no GPS/network location hardware at all. Never set in production.
         */
        @Volatile var providerOverride: List<String>? = null
    }

    lateinit var webView: WebView
        private set
    private lateinit var locationManager: LocationManager
    private val main = Handler(Looper.getMainLooper())
    private var pageReady = false
    private var listening = false
    private var lastStatus: String? = null
    private var lastFix: Location? = null

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) = deliverFix(location)
        override fun onProviderEnabled(provider: String) = refreshLocation()
        override fun onProviderDisabled(provider: String) = refreshLocation()
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    }

    private val providersReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = refreshLocation()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        if (BuildConfigCompat.isDebuggable(this)) WebView.setWebContentsDebuggingEnabled(true)

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            settings.textZoom = 100
            addJavascriptInterface(Bridge(), "Native")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assetLoader.shouldInterceptRequest(request.url)
                        // anything that is not a bundled asset is refused: the app is fully offline
                        ?: WebResourceResponse("text/plain", "utf-8", 404, "Offline", emptyMap(), null)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val url = request.url
                    if (url.host == "appassets.androidplatform.net") return false
                    openExternal(url.toString())
                    return true
                }

                override fun onPageFinished(view: WebView, url: String) {
                    pageReady = true
                    lastStatus?.let { pushStatus(it, force = true) }
                    lastFix?.let { deliverFix(it) }
                }
            }
        }
        // targetSdk 35 is edge-to-edge: keep the UI clear of status/navigation bars and cutouts.
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.WHITE)
            addView(webView)
            setOnApplyWindowInsetsListener { v, insets ->
                if (Build.VERSION.SDK_INT >= 30) {
                    val b = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                    v.setPadding(b.left, b.top, b.right, b.bottom)
                } else {
                    @Suppress("DEPRECATION")
                    v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                }
                insets
            }
        }
        setContentView(root)
        webView.loadUrl(START_URL)

        // Ask for location once on first launch; afterwards the GPS pill in the UI re-asks.
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!hasPermission() && !prefs.getBoolean("askedLocation", false)) {
            prefs.edit().putBoolean("askedLocation", true).apply()
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), REQ_LOCATION)
        }

        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() = handleBack()

    private fun handleBack() {
        webView.evaluateJavascript("window.SC26 && window.SC26.onBack()") { consumed ->
            if (consumed != "true") finish()
        }
    }

    override fun onResume() {
        super.onResume()
        registerReceiver(providersReceiver, IntentFilter(LocationManager.PROVIDERS_CHANGED_ACTION))
        refreshLocation()
    }

    override fun onPause() {
        super.onPause()
        try { unregisterReceiver(providersReceiver) } catch (_: IllegalArgumentException) {}
        stopLocation()
    }

    // ---------------- location ----------------

    private fun hasPermission() =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun usableProviders(): List<String> {
        providerOverride?.let { return it }
        val all = try { locationManager.allProviders } catch (_: Exception) { emptyList() }
        return listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { it in all }
    }

    private fun locationEnabled(): Boolean =
        if (Build.VERSION.SDK_INT >= 28) locationManager.isLocationEnabled
        else usableProviders().any { locationManager.isProviderEnabled(it) }

    /** Re-evaluate permission / settings and (re)start listening. Safe to call any time. */
    @SuppressLint("MissingPermission")
    fun refreshLocation() {
        val providers = usableProviders()
        when {
            providers.isEmpty() -> { stopLocation(); pushStatus("unavailable") }
            !hasPermission() -> { stopLocation(); pushStatus("denied") }
            !locationEnabled() -> { stopLocation(); lastFix = null; pushStatus("off") }
            else -> {
                if (!listening) {
                    for (p in providers) {
                        try {
                            if (locationManager.isProviderEnabled(p)) {
                                locationManager.requestLocationUpdates(p, 2000L, 1f, listener, Looper.getMainLooper())
                            }
                        } catch (e: Exception) { Log.w(TAG, "requestLocationUpdates($p) failed", e) }
                    }
                    listening = true
                    val recent = providers.mapNotNull {
                        try { locationManager.getLastKnownLocation(it) } catch (_: Exception) { null }
                    }.filter { System.currentTimeMillis() - it.time < 10 * 60_000 }.maxByOrNull { it.time }
                    if (recent != null) deliverFix(recent) else pushStatus("searching")
                } else if (lastFix == null) pushStatus("searching")
            }
        }
    }

    private fun stopLocation() {
        if (listening) {
            try { locationManager.removeUpdates(listener) } catch (_: Exception) {}
            listening = false
        }
    }

    private fun deliverFix(loc: Location) {
        // prefer GPS over a coarser network fix unless the GPS one is stale
        val prev = lastFix
        if (prev != null && loc.provider != prev.provider && loc.accuracy > prev.accuracy &&
            loc.time - prev.time < 15_000) return
        lastFix = loc
        lastStatus = "ok"
        if (!pageReady) return
        val js = JSONObject()
            .put("lat", loc.latitude).put("lon", loc.longitude)
            .put("acc", if (loc.hasAccuracy()) loc.accuracy.toDouble() else 30.0)
            .put("time", loc.time).put("provider", loc.provider ?: "")
        webView.evaluateJavascript("window.SC26 && window.SC26.onLocation($js)", null)
    }

    private fun pushStatus(status: String, force: Boolean = false) {
        if (status == lastStatus && !force) return
        lastStatus = status
        if (!pageReady) return
        if (status == "ok" && lastFix != null) return
        webView.evaluateJavascript("window.SC26 && window.SC26.onLocationStatus(${JSONObject.quote(status)})", null)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_LOCATION) refreshLocation()
    }

    private fun openExternal(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) { Log.w(TAG, "no browser", e) }
    }

    // ---------------- JS bridge ----------------

    inner class Bridge {
        private val prefs get() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        @JavascriptInterface fun getState(): String = prefs.getString(KEY_STATE, "") ?: ""

        @JavascriptInterface fun saveState(json: String) { prefs.edit().putString(KEY_STATE, json).apply() }

        @JavascriptInterface fun startLocation() { main.post { refreshLocation() } }

        @JavascriptInterface fun requestLocation() {
            main.post {
                if (hasPermission()) refreshLocation()
                else requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), REQ_LOCATION)
            }
        }

        @JavascriptInterface fun openLocationSettings() {
            main.post { startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)) }
        }

        @JavascriptInterface fun openUrl(url: String) {
            if (url.startsWith("https://")) main.post { openExternal(url) }
        }
    }
}

object BuildConfigCompat {
    fun isDebuggable(ctx: Context) =
        (ctx.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
}
