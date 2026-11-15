#!/usr/bin/env bash
# Build, verify and publish a release APK to GitHub Releases. The phone picks it up
# through Obtainium (or the stable link below). Run inside `nix develop`.
#
#   scripts/publish.sh            # tests + build + verify + push main + GitHub Release
#   scripts/publish.sh --dry-run  # everything except the push and the Release
#
# Stable download link (always the newest release):
#   https://github.com/tylerwx51/sc26-navigator/releases/latest/download/sc26-navigator.apk
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
REPO=tylerwx51/sc26-navigator
# SHA-256 of the signing cert of the app installed on the phone. Must never change.
EXPECTED_CERT=787365129f93473948259ad99104489ce43a7b1c72451440f21054becc29a912
KEYSTORE="${SC26_KEYSTORE:-$HOME/.config/sc26-navigator/signing.keystore}"

die() { echo "publish: $*" >&2; exit 1; }

# gh auth: a public_repo-scoped token. `gh auth login` refuses it (wants repo,read:org),
# so it's passed via GH_TOKEN instead.
if [ -z "${GH_TOKEN:-}" ] && [ -f "$HOME/.config/sc26-navigator/gh-token" ]; then
  GH_TOKEN=$(<"$HOME/.config/sc26-navigator/gh-token"); export GH_TOKEN
fi
[ -n "${GH_TOKEN:-}" ] || [ "$DRY" = 1 ] || die "no GitHub token (~/.config/sc26-navigator/gh-token or GH_TOKEN)"

[ -f "$KEYSTORE" ] || die "signing keystore missing at $KEYSTORE (see CLAUDE.md, 'Signing key')"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "publish from main only (versionCode = commit count on main)"
[ -z "$(git status --porcelain)" ] || die "working tree not clean; commit first"

git fetch -q origin main
if ! git merge-base --is-ancestor origin/main HEAD; then
  die "origin/main has commits that HEAD lacks; pull/rebase first"
fi

CODE=$(git rev-list --count HEAD)
VERSION="1.0.$CODE"
TAG="v$VERSION"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  die "$TAG already released; make a new commit first"
fi

echo "== unit tests"
node --test tests/core.test.mjs

echo "== build $TAG (versionCode $CODE)"
gradle -q assembleRelease
APK=app/build/outputs/apk/release/app-release.apk

echo "== verify signature + version"
CERT=$("$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --print-certs "$APK" \
  | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
[ "$CERT" = "$EXPECTED_CERT" ] || die "APK signed with wrong key ($CERT); it would not update the phone"
BADGING=$("$ANDROID_HOME/build-tools/35.0.0/aapt2" dump badging "$APK")
echo "${BADGING%%$'\n'*}"
grep -q "versionCode='$CODE'" <<<"$BADGING" || die "versionCode mismatch"
grep -q "versionName='$VERSION'" <<<"$BADGING" || die "versionName mismatch"
PERMS=$("$ANDROID_HOME/build-tools/35.0.0/aapt2" dump permissions "$APK")
if grep -q "android.permission.INTERNET" <<<"$PERMS"; then
  die "APK requests INTERNET; the app is offline by design"
fi

OUT=$(mktemp -d)
cp "$APK" "$OUT/sc26-navigator.apk"

PREV=$(git describe --tags --abbrev=0 2>/dev/null || true)
NOTES="$OUT/notes.md"
{
  echo "Install: open this page on the phone and tap **sc26-navigator.apk**, or let Obtainium update it."
  echo
  echo "## Changes"
  if [ -n "$PREV" ]; then git log --no-merges --format='- %s' "$PREV..HEAD"; else git log --no-merges --format='- %s'; fi
} > "$NOTES"

if [ "$DRY" = 1 ]; then
  echo "== dry run OK: $OUT/sc26-navigator.apk ($TAG); notes:"; cat "$NOTES"; exit 0
fi

echo "== push + release"
git push -q origin main
gh release create "$TAG" "$OUT/sc26-navigator.apk" -R "$REPO" --target "$(git rev-parse HEAD)" \
  --title "SC26 Navigator $VERSION" --notes-file "$NOTES"
git fetch -q --tags origin

# Bonus: if the phone happens to be on USB here, update it directly too.
if adb get-state >/dev/null 2>&1; then
  echo "== adb device found; installing"
  adb install -r "$OUT/sc26-navigator.apk"
fi
echo "published $TAG: https://github.com/$REPO/releases/tag/$TAG"
