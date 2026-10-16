# The toolchain half of android-apk/build.sh, for a machine with no bash.
#
# Same steps, same order, same arguments - javac, d8, aapt2 compile, aapt2 link,
# jar, fixzip, zipalign, apksigner, then the checks. Run from android-apk.
# Not "Stop". The Android tools write ordinary progress and deprecation notes to
# stderr, and under Stop a single javac note about a deprecated API aborts the
# build before it starts. Every step below checks $LASTEXITCODE itself, which
# is the thing that actually says whether a command worked.
$ErrorActionPreference = "Continue"

$SDK = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$BT = Join-Path $SDK "build-tools\36.0.0"
$PLATFORM = Join-Path $SDK "platforms\android-36\android.jar"
$KEYSTORE = "quanta.keystore"
$KS_PASS = "pass:quanta123"
$VERSION_CODE = 12
$VERSION_NAME = "1.6.4"

# The previous APK shipped as versionCode 11. Android refuses to install an
# update whose versionCode is not higher, so this has to exceed what is already
# on the device - read from the installed package rather than assumed.
$aapt2 = Join-Path $BT "aapt2.exe"
$installed = (& $aapt2 dump badging Quanta.apk 2>$null | Select-String "versionCode='(\d+)'")
if ($installed) {
  $cur = [int]$installed.Matches[0].Groups[1].Value
  if ($VERSION_CODE -le $cur) {
    Write-Output "ERROR: VERSION_CODE $VERSION_CODE is not higher than the packaged $cur"
    exit 1
  }
  Write-Output "    versionCode $VERSION_CODE > packaged $cur"
}

Write-Output "==> Cleaning build dir"
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path build\obj, build\dex | Out-Null

Write-Output "==> Compiling Java"
javac -source 8 -target 8 -bootclasspath $PLATFORM -d build\obj app\src\main\java\com\khan\quanta\MainActivity.java 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Output "ERROR: javac failed"; exit 1 }
$classes = Get-ChildItem build\obj\com\khan\quanta\*.class
if (-not $classes) { Write-Output "ERROR: javac produced no classes"; exit 1 }
Write-Output "    $($classes.Count) class file(s)"

Write-Output "==> Dexing"
& (Join-Path $BT "d8.bat") --release --min-api 24 --lib $PLATFORM --output build\dex (Get-ChildItem build\obj\com\khan\quanta\*.class | ForEach-Object { $_.FullName })
if ($LASTEXITCODE -ne 0) { Write-Output "ERROR: d8 failed"; exit 1 }

Write-Output "==> Compiling resources"
& $aapt2 compile --dir app\src\main\res -o build\res.zip
if ($LASTEXITCODE -ne 0) { Write-Output "ERROR: aapt2 compile failed"; exit 1 }

Write-Output "==> Linking APK (with assets)"
& $aapt2 link -o build\base.apk -I $PLATFORM --manifest app\src\main\AndroidManifest.xml --min-sdk-version 24 --target-sdk-version 36 --version-code $VERSION_CODE --version-name $VERSION_NAME -A app\src\main\assets build\res.zip
if ($LASTEXITCODE -ne 0) { Write-Output "ERROR: aapt2 link failed"; exit 1 }

Write-Output "==> Adding classes.dex"
jar -uf build\base.apk -C build\dex classes.dex
if ($LASTEXITCODE -ne 0) { Write-Output "ERROR: jar failed"; exit 1 }

Write-Output "==> Fixing zip entry names (forward slashes)"
python fixzip.py build\base.apk build\quanta-slashfix.apk
if ($LASTEXITCODE -ne 0) { Write-Output "ERROR: fixzip failed"; exit 1 }

Write-Output "==> Aligning"
& (Join-Path $BT "zipalign.exe") -f -p 4 build\quanta-slashfix.apk build\quanta-aligned.apk
if ($LASTEXITCODE -ne 0) { Write-Output "ERROR: zipalign failed"; exit 1 }

Write-Output "==> Signing"
& (Join-Path $BT "apksigner.bat") sign --ks $KEYSTORE --ks-key-alias quanta --ks-pass $KS_PASS --key-pass $KS_PASS --out Quanta.apk build\quanta-aligned.apk
if ($LASTEXITCODE -ne 0) { Write-Output "ERROR: apksigner failed"; exit 1 }

& (Join-Path $BT "apksigner.bat") verify Quanta.apk
if ($LASTEXITCODE -ne 0) { Write-Output "ERROR: signature did not verify"; exit 1 }

Write-Output ""
Write-Output "==> Final check on the packaged APK"
& $aapt2 dump badging Quanta.apk | Select-Object -First 1

Write-Output "DONE: $((Resolve-Path Quanta.apk).Path)  v$VERSION_NAME (code $VERSION_CODE)  $([math]::Round((Get-Item Quanta.apk).Length/1MB,1)) MB"
