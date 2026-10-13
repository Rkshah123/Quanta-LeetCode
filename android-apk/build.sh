#!/usr/bin/env bash
# Quanta APK build script — rebuilds Quanta.apk from the current website files.
# Usage: ./build.sh   (run from the android-apk folder)
#
# Env:
#   QUANTA_API_URL   online API base, e.g. https://quanta-api-2i9a.onrender.com
#   QUANTA_LAN_IP    LAN address of the PC running the code compiler
#   VERSION_CODE     Android versionCode; must rise for an update to install
#   VERSION_NAME     user-visible version
set -e

SDK="${ANDROID_HOME:-${LOCALAPPDATA}/Android/Sdk}"
BT="$SDK/build-tools/36.0.0"
PLATFORM="$SDK/platforms/android-36/android.jar"
KEYSTORE=quanta.keystore
KS_PASS=pass:quanta123

# Compiler server (runs Java/C/C++/Python) — LAN address of this PC only.
LAN_IP="${QUANTA_LAN_IP:-192.168.0.5}"
# Online API (problem database). Empty by default so a LAN IP is never baked in
# as the permanent online endpoint; pass the hosted API to make the APK useful
# online, where the Contests and catalog pages need it.
API_URL="${QUANTA_API_URL:-}"

# Bumped for this release. Android refuses to install an update whose
# versionCode is not higher than the installed one, and both the previous APK and
# the one this replaces shipped as 1.
VERSION_CODE="${VERSION_CODE:-2}"
VERSION_NAME="${VERSION_NAME:-1.1.0}"

ASSETS=app/src/main/assets

echo "==> Working out which files the app actually needs"
# Derived from index.html rather than listed by hand.
#
# The previous version of this script copied nine named files. Every feature
# added since then was silently left out of the APK, and because
# lab-notes.js calls initMock(), initCompanies(), initArena(), initDebugger()
# and initReview() during start-up, a missing module made the whole app fail to
# initialise rather than just hiding one page. A hand-written list cannot survive
# that; a list read out of the page's own script tags can.
#
# Query strings (?v=42) are stripped: they are cache-busting for the web and
# mean nothing to the asset manager.
mapfile -t SCRIPTS < <(grep -o '<script src="[^"]*"' ../index.html \
  | sed 's/.*src="//; s/"$//; s/?.*$//' | grep -v '^$')
mapfile -t STYLES < <(grep -o '<link[^>]*rel="stylesheet"[^>]*>' ../index.html \
  | sed 's/.*href="//; s/".*//; s/?.*$//' | grep -v '^$')

echo "    scripts: ${#SCRIPTS[@]}   stylesheets: ${#STYLES[@]}"
for s in "${SCRIPTS[@]}" "${STYLES[@]}"; do echo "      - $s"; done

echo "==> Syncing web app into assets"
# Wipe first. A stale asset from a previous build would otherwise be packaged
# and served even though nothing references it any more.
rm -rf "$ASSETS"
mkdir -p "$ASSETS"

# index.html, the manifest and the offline catalog are not referenced by a src
# or href in the page, so they are named explicitly.
cp ../index.html "$ASSETS/index.html"
cp ../manifest.json "$ASSETS/manifest.json"
cp ../image.jpg "$ASSETS/image.jpg"
cp ../leeticon.png "$ASSETS/leeticon.png"
cp ../offline-pack.js "$ASSETS/offline-pack.js"

MISSING=0
for asset in "${SCRIPTS[@]}" "${STYLES[@]}"; do
  case "$asset" in
    # Monaco's loader pulls in more files at runtime from paths it derives
    # itself, so its tree is copied whole rather than file by file.
    vendor/monaco/*)
      mkdir -p "$ASSETS/vendor/monaco"
      if [ ! -d "../vendor/monaco/min" ]; then
        echo "ERROR: ../vendor/monaco/min is missing but index.html needs $asset" >&2
        MISSING=$((MISSING + 1))
      fi
      ;;
    *)
      if [ ! -f "../$asset" ]; then
        echo "ERROR: index.html references $asset but it does not exist" >&2
        MISSING=$((MISSING + 1))
      else
        mkdir -p "$ASSETS/$(dirname "$asset")"
        cp "../$asset" "$ASSETS/$asset"
      fi
      ;;
  esac
done

if [ "$MISSING" -ne 0 ]; then
  echo "" >&2
  echo "FAILED: $MISSING asset(s) referenced by index.html are missing." >&2
  echo "Refusing to package an APK that would not start." >&2
  exit 1
fi

echo "==> Copying the Monaco editor tree"
mkdir -p "$ASSETS/vendor/monaco"
cp -r ../vendor/monaco/min "$ASSETS/vendor/monaco/"

echo "==> Injecting wrapper bootstrap (LAN_IP=$LAN_IP, API_URL=${API_URL:-<not set>})"
# Insert the wrapper bootstrap right before the main script.js tag, if not already present.
if ! grep -q "quantaRunServerUrl" "$ASSETS/index.html"; then
  node -e "
    const fs = require('fs');
    const p = '$ASSETS/index.html';
    let html = fs.readFileSync(p, 'utf8');
    const bootstrap = '  <script>\n' +
      '    // Quanta Android wrapper: default the compiler-server to the PC running the dashboard.\n' +
      '    (function () {\n' +
      '      try {\n' +
      '        var isWrapper = /QuantaAndroid\\\\/[0-9]/.test(navigator.userAgent);\n' +
      '        if (isWrapper) { document.documentElement.classList.add(\"quanta-native-shell\"); }\n' +
      '        if (isWrapper && !localStorage.getItem(\"quantaRunServerUrl\")) {\n' +
      '          localStorage.setItem(\"quantaRunServerUrl\", \"http://${LAN_IP}:3000\");\n' +
      '        }\n' +
      '        if (isWrapper && \"${API_URL}\" && !localStorage.getItem(\"quantaApiBaseUrl\")) {\n' +
      '          localStorage.setItem(\"quantaApiBaseUrl\", \"${API_URL}\");\n' +
      '        }\n' +
      '      } catch (e) {}\n' +
      '    })();\n' +
      '  </script>\n';
    /* script tags carry cache-busting query strings (?v=NN); match the tag
       regardless of its query so the bootstrap always gets injected. */
    const re = /(  <script src=\"script\.js)([^\"]*)(\"\><\/script\>)/;
    if (!re.test(html)) { console.error('script.js tag not found'); process.exit(1); }
    html = html.replace(re, bootstrap + '\$1\$2\$3');
    fs.writeFileSync(p, html);
    console.log('    bootstrap injected');
  "
else
  echo "    bootstrap already present"
fi

echo "==> Verifying every asset the page needs is packaged"
# The check above proves the source files exist. This proves they are IN the
# packaged asset directory, which is a different thing and the one that has
# actually gone wrong before.
PACKAGED_MISSING=0
for asset in "${SCRIPTS[@]}" "${STYLES[@]}"; do
  case "$asset" in
    vendor/monaco/*)
      [ -f "$ASSETS/vendor/monaco/${asset#vendor/monaco/}" ] || {
        echo "ERROR: $asset is referenced but not in the assets directory" >&2
        PACKAGED_MISSING=$((PACKAGED_MISSING + 1))
      }
      ;;
    *)
      [ -f "$ASSETS/$asset" ] || {
        echo "ERROR: $asset is referenced but not in the assets directory" >&2
        PACKAGED_MISSING=$((PACKAGED_MISSING + 1))
      }
      ;;
  esac
done
for required in index.html manifest.json image.jpg leeticon.png offline-pack.js; do
  [ -f "$ASSETS/$required" ] || {
    echo "ERROR: $required is missing from the assets directory" >&2
    PACKAGED_MISSING=$((PACKAGED_MISSING + 1))
  }
done
if [ "$PACKAGED_MISSING" -ne 0 ]; then
  echo "FAILED: $PACKAGED_MISSING packaged asset(s) missing. Not building." >&2
  exit 1
fi
echo "    all $((${#SCRIPTS[@]} + ${#STYLES[@]} + 5)) referenced assets present"

case "$API_URL" in
  *\"*) echo "ERROR: QUANTA_API_URL must not contain double quotes" >&2; exit 1;;
esac

echo "==> Cleaning build dir"
rm -rf build
mkdir -p build/obj build/dex

echo "==> Compiling Java"
javac -source 8 -target 8 -bootclasspath "$PLATFORM" \
  -d build/obj app/src/main/java/com/khan/quanta/MainActivity.java 2>/dev/null

echo "==> Dexing"
"$BT/d8.bat" --release --min-api 24 --lib "$PLATFORM" \
  --output build/dex build/obj/com/khan/quanta/*.class

echo "==> Compiling resources"
"$BT/aapt2.exe" compile --dir app/src/main/res -o build/res.zip

echo "==> Linking APK (with assets)"
"$BT/aapt2.exe" link -o build/base.apk -I "$PLATFORM" \
  --manifest app/src/main/AndroidManifest.xml \
  --min-sdk-version 24 --target-sdk-version 36 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -A "$ASSETS" build/res.zip

echo "==> Adding classes.dex"
jar -uf build/base.apk -C build/dex classes.dex

echo "==> Fixing zip entry names (forward slashes)"
python fixzip.py build/base.apk build/quanta-slashfix.apk

echo "==> Aligning"
"$BT/zipalign.exe" -f -p 4 build/quanta-slashfix.apk build/quanta-aligned.apk

echo "==> Signing"
"$BT/apksigner.bat" sign \
  --ks "$KEYSTORE" --ks-key-alias quanta \
  --ks-pass "$KS_PASS" --key-pass "$KS_PASS" \
  --out Quanta.apk build/quanta-aligned.apk

"$BT/apksigner.bat" verify Quanta.apk

echo ""
echo "==> Final check on the packaged APK"
"$BT/aapt2.exe" dump badging Quanta.apk | head -1
APK_BADGING_MISSING=0
while read -r asset; do
  [ -z "$asset" ] && continue
  if ! unzip -l Quanta.apk "assets/$asset" 2>/dev/null | grep -q "assets/$asset"; then
    echo "ERROR: $asset is NOT in the built APK" >&2
    APK_BADGING_MISSING=$((APK_BADGING_MISSING + 1))
  fi
done < <(printf '%s\n' "${SCRIPTS[@]}" "${STYLES[@]}")
if [ "$APK_BADGING_MISSING" -ne 0 ]; then
  echo "FAILED: $APK_BADGING_MISSING asset(s) missing from the APK itself." >&2
  exit 1
fi
echo "    every referenced asset is present in the APK"

echo ""
echo "DONE: $(pwd)/Quanta.apk ($(du -h Quanta.apk | cut -f1))  v$VERSION_NAME (code $VERSION_CODE)"
