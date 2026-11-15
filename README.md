<img src="assets/icon.svg" width="64" height="64" alt="">

# SC26 Navigator

An offline Android app for SC26 (Supercomputing 2026, McCormick Place, Chicago, 15–20 Nov 2026). It combines the full conference schedule with the venue floor plans and shows your GPS position on them.

- **Schedule:** all 412 program sessions (with talks, speakers and rooms). You can browse by day, search, and filter by type. Tap ☆ to check a session.
- **Map:** 7 floor plans (West 1–4, South 1, Lakeside 3, overview). Rooms with matching events are highlighted and get a count marker. Tap a marker or room to see its events.
  - Filters: **All events / ★ Checked**, combined with **Any time / This block / Next block / pick a block**. A block is a venue-local half day (AM = 00:00–12:00, PM = 12:00–24:00). "Next block" is the next half day that has events.
  - Each floor button shows how many filtered events are on that floor.
- **GPS:** a blue dot with an accuracy circle on the floor plan. GPS can't tell floors apart, so the dot shows on whichever floor of that building you're viewing, and ◎ switches building if needed. If location is off, denied or unavailable, the map still works and a short notice explains why. If you're away from the venue, it shows the distance.
- **My Plan:** checked sessions by day, with overlapping sessions flagged.
- **Offline:** the app has no `INTERNET` permission. Schedule JSON, map SVGs and the UI are bundled assets served through `WebViewAssetLoader`. Checked items are stored in SharedPreferences.

## Layout

| Path | What |
| --- | --- |
| `app/src/main/java/.../MainActivity.kt` | Native shell: WebView, GPS (`LocationManager`, GPS + network), JS bridge, state storage |
| `app/src/main/assets/www/` | UI (`index.html`, `app.css`, `js/app.js`), pure logic (`js/core.js`), data (`data/*.json`), floor plans (`maps/*.svg`) |
| `tools/update_data.sh` | Re-downloads the program and Mapplic venue map from sc26.conference-program.com and regenerates the data |
| `tools/georef_fit.py` | Fits each floor-plan SVG to its OpenStreetMap building footprint (similarity transform, ~8–12 m RMS) → `tools/src/georef.json` |
| `tests/core.test.mjs` | Node unit tests (blocks, filters, conflicts, georeferencing, data sanity) |
| `app/src/androidTest/` | Instrumented emulator tests (Espresso-Web + mock GPS provider + toggling location off). `OfflineTest` cold-starts the app with airplane mode on, Wi-Fi and mobile data off, and then location off, GPS on without internet, or no location hardware at all. |

## Build & test (all deps via Nix)

```sh
nix develop                       # JDK 17, Gradle 8, Android SDK 35 + emulator + system image, node, python
node --test tests/core.test.mjs   # unit tests
./scripts/emulator.sh             # create + boot headless API 35 emulator (KVM)
ANDROID_SERIAL=emulator-5554 gradle connectedDebugAndroidTest  # emulator only (tests wipe app data; they skip on real phones)
gradle assembleRelease            # app/build/outputs/apk/release/app-release.apk (debug-key signed)
adb install -r app/build/outputs/apk/release/app-release.apk
```

The instrumented tests wipe saved state and toggle radios and location, so they skip on real phones. Pass `-Pandroid.testInstrumentationRunnerArguments.allowRealDevice=true` to run them on a phone anyway. They also pass with Gradle `--offline` once dependencies are cached.

Data snapshot: program generated 2026-11-14 18:13 CST. Run `tools/update_data.sh` inside `nix develop` to refresh, then rebuild.

Map and program data © SC26 / Linklings / Mapplic; building footprints © OpenStreetMap contributors (ODbL).
