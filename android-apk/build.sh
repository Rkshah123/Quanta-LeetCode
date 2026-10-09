#!/usr/bin/env bash
# Quanta APK build script — rebuilds Quanta.apk from the current website files.
# Usage: ./build.sh   (run from the android-apk folder)
set -e

SDK="${LOCALAPPDATA}/Android/Sdk"
BT="$SDK/build-tools/36.0.0"
PLATFORM="$SDK/platforms/android-36/android.jar"
KEYSTORE=quanta.keystore
KS_PASS=pass:quanta123
# Compiler server (runs Java/C/C++/Python) — LAN address of this PC only.
LAN_IP="${QUANTA_LAN_IP:-192.168.0.5}"
# Online API (problem database) — hosted HTTPS backend, empty by default so a
# LAN IP is never baked in as the permanent online endpoint.
#   QUANTA_API_URL=https://quanta-api.onrender.com ./build.sh
API_URL="${QUANTA_API_URL:-}"

echo "==> Syncing web app into assets"
cp ../index.html ../style.css ../script.js ../lab-notes.js ../lab-notes.css ../manifest.json ../leeticon.png ../image.jpg app/src/main/assets/
mkdir -p app/src/main/assets/vendor/monaco
cp -r ../vendor/monaco/min app/src/main/assets/vendor/monaco/

case "$API_URL" in
  *\"*) echo "ERROR: QUANTA_API_URL must not contain double quotes" >&2; exit 1;;
esac

echo "==> Injecting wrapper bootstrap (LAN_IP=$LAN_IP, API_URL=${API_URL:-<not set>})"
# Insert the wrapper bootstrap right before the main script.js tag, if not already present.
if ! grep -q "quantaRunServerUrl" app/src/main/assets/index.html; then
  node -e "
    const fs = require('fs');
    const p = 'app/src/main/assets/index.html';
    let html = fs.readFileSync(p, 'utf8');
    const bootstrap = '  <script>\\n' +
      '    // Quanta Android wrapper: default the compiler-server to the PC running the dashboard.\\n' +
      '    (function () {\\n' +
      '      try {\\n' +
      '        var isWrapper = /QuantaAndroid\\\\/[0-9]/.test(navigator.userAgent);\\n' +
      '        if (isWrapper) { document.documentElement.classList.add("quanta-native-shell"); }\\n' +
      '        if (isWrapper && !localStorage.getItem(\"quantaRunServerUrl\")) {\\n' +
      '          localStorage.setItem(\"quantaRunServerUrl\", \"http://${LAN_IP}:3000\");\\n' +
      '        }\\n' +
      '        if (isWrapper && \"${API_URL}\" && !localStorage.getItem(\"quantaApiBaseUrl\")) {\\n' +
      '          localStorage.setItem(\"quantaApiBaseUrl\", \"${API_URL}\");\\n' +
      '        }\\n' +
      '      } catch (e) {}\\n' +
      '    })();\\n' +
      '  </script>\\n';
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
  --version-code 1 --version-name "1.0.0" \
  -A app/src/main/assets build/res.zip

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
echo "DONE: $(pwd)/Quanta.apk ($(du -h Quanta.apk | cut -f1))"
