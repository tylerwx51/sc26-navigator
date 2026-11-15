# SC26 Navigator: notes for agents

See README.md for what the app is and how to build and test it. Everything runs inside `nix develop`.

## Shipping a fix to Tyler's phone (during SC26, 15–20 Nov 2026)

Tyler is at the conference with the phone (Pixel 6) on a different network. There is **no adb access**. The only update path is GitHub Releases:

1. Fix on a branch, run `node --test tests/core.test.mjs` (and the emulator tests via `scripts/emulator.sh` + `gradle connectedDebugAndroidTest` when the change touches native code or UI flows).
2. Merge into `main` (fast-forward/rebase, keep history linear) and run **`scripts/publish.sh`** from `main` inside `nix develop`. Use `--dry-run` first if unsure.
   It tests, builds, checks the signing cert / versionCode / no-INTERNET, pushes `main`, and creates Release `v1.0.<commit count>` with asset `sc26-navigator.apk`.
3. Tell Tyler the version. On the phone, **Obtainium** (tracks `github.com/tylerwx51/sc26-navigator`) shows the update; the fallback is opening
   https://github.com/tylerwx51/sc26-navigator/releases/latest/download/sc26-navigator.apk in Chrome.

Rules:
- `versionCode` = `git rev-list --count HEAD`. Publish only from `main`, never rewrite published `main` history (the count must keep growing).
- The app must stay offline: no `INTERNET` permission (the publish script enforces it).
- One fix = one release is fine; Tyler would rather get small frequent updates than wait.

## Signing key (critical)

The installed app is signed by `~/.config/sc26-navigator/signing.keystore` (cert SHA-256 `787365129f…c29a912`, alias `androiddebugkey`, password `android`). It is deliberately **not in the public repo**. A release signed with any other key can't update the phone; the only fix is uninstalling, which wipes Tyler's ★ checked sessions. If the keystore is missing, stop and ask; don't generate a new one.

GitHub token for `gh`: `~/.config/sc26-navigator/gh-token` (public_repo scope, used as `GH_TOKEN`).
