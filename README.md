<img src="assets/icon.svg" width="64" height="64" alt="">

# SC26 Navigator

An offline Android app for SC26 (Supercomputing 2026, McCormick Place, Chicago, 15–20 Nov 2026). It combines the full conference schedule with the venue floor plans and shows your GPS position on them.

- **Schedule:** all 412 program sessions (with talks, speakers and rooms). You can browse by day, search, and filter by type. Tap ☆ to check a session.
- **Map:** 7 floor plans (West 1–4, South 1, Lakeside 3, overview). Rooms with matching events are highlighted and get a count marker. Tap a marker or room to see its events.
  - Filters: **All events / ★ Checked**, combined with **Any time / This block / Next block / pick a block**. A block is a venue-local half day (AM = 00:00–12:00, PM = 12:00–24:00). "Next block" is the next half day that has events.
  - Each floor button shows how many filtered events are on that floor.
  - **Floor connections:** stairs, escalators and elevators are drawn as coloured icons. Stairs show once you zoom in. Tap one to jump to the matching spot on another floor; matches use georeferenced position, ±~10 m. Blue ⇄ pills mark the links between buildings (Skybridge W3 → South, Grand Concourse → Lakeside 3, North Building L1). The ⇅ button opens a diagram of how all the floors and buildings connect.
- **Booths:** tapping an exhibit-hall booth shows the exhibitor's logo, a short summary of what they do, and a button that opens their website in the browser. This covers all 623 booths on the map, from 579 exhibitors.
- **GPS:** a blue dot with an accuracy circle on the floor plan. GPS can't tell floors apart, so the dot shows on whichever floor of that building you're viewing, and ◎ switches building if needed. If location is off, denied or unavailable, the map still works and a short notice explains why. If you're away from the venue, it shows the distance.
- **My Plan:** checked sessions by day, with overlapping sessions flagged.
- **Offline:** the app has no `INTERNET` permission. Schedule JSON, map SVGs and the UI are bundled assets served through `WebViewAssetLoader`. Checked items are stored in SharedPreferences.

## Layout

| Path | What |
| --- | --- |
| `app/src/main/java/.../MainActivity.kt` | Native shell: WebView, GPS (`LocationManager`, GPS + network), JS bridge, state storage |
| `app/src/main/assets/www/` | UI (`index.html`, `app.css`, `js/app.js`), pure logic (`js/core.js`), data (`data/*.json`), floor plans (`maps/*.svg`) |
| `tools/update_data.sh` | Re-downloads the program and Mapplic venue map from sc26.conference-program.com and regenerates the data |
| `tools/build_connectors.py` | Finds the stairs/escalator/elevator icons on each floor plan by matching them against the plan's legend, and adds the hand-placed links between buildings → `data/connectors.json` |
| `tools/build_exhibitors.py` | Merges the conference's organizations page into the curated `tools/src/exhibitors.json` (name, booths, website, hand-written <50-word summary) and writes `data/exhibitors.json` |
| `tools/fetch_logos.py` | Fetches each exhibitor's site icon (apple-touch-icon / favicon, with fallbacks) and saves a 96 px WebP to `www/logos/` (sources in `tools/src/logo_sources.json`) |
| `tools/georef_fit.py` | Fits each floor-plan SVG to its OpenStreetMap building footprint (similarity transform, ~8–12 m RMS) → `tools/src/georef.json` |
| `tests/core.test.mjs` | Node unit tests (blocks, filters, conflicts, georeferencing, data sanity) |
| `app/src/androidTest/` | Instrumented emulator tests (Espresso-Web + mock GPS provider + toggling location off). `OfflineTest` cold-starts the app with airplane mode on, Wi-Fi and mobile data off, and then location off, GPS on without internet, or no location hardware at all. |

## Build & test (all deps via Nix)

```sh
nix develop                       # JDK 17, Gradle 8, Android SDK 35 + emulator + system image, node, python
node --test tests/core.test.mjs   # unit tests
./scripts/emulator.sh             # create + boot headless API 35 emulator (KVM)
ANDROID_SERIAL=emulator-5554 gradle connectedDebugAndroidTest  # emulator only (tests wipe app data; they skip on real phones)
gradle assembleRelease            # app/build/outputs/apk/release/app-release.apk (signed with ~/.config/sc26-navigator/signing.keystore)
adb install -r app/build/outputs/apk/release/app-release.apk
```

The instrumented tests wipe saved state and toggle radios and location, so they skip on real phones. Pass `-Pandroid.testInstrumentationRunnerArguments.allowRealDevice=true` to run them on a phone anyway. They also pass with Gradle `--offline` once dependencies are cached.

## Releases & updates

`scripts/publish.sh` (from `main`) builds, verifies and publishes a GitHub Release. The version is `1.0.<commit count>`. Install or update on a phone with [Obtainium](https://github.com/ImranR98/Obtainium) pointed at this repo, or via the [latest APK](https://github.com/tylerwx51/sc26-navigator/releases/latest/download/sc26-navigator.apk).

Data snapshot: program generated 2026-11-14 18:13 CST. Run `tools/update_data.sh` inside `nix develop` to refresh, then rebuild.

Map and program data © SC26 / Linklings / Mapplic; building footprints © OpenStreetMap contributors (ODbL).
