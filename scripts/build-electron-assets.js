#!/usr/bin/env node
"use strict";
/* Builds the desktop app's own copy of the Quanta frontend.
 *
 * Reads the asset list out of index.html rather than keeping a list by hand.
 * The Android build learned this the hard way: it once copied nine named files,
 * every module added since was silently left out, and because lab-notes.js
 * initialises Mock, Companies, Arena, Debugger and Review during start-up, one
 * missing file stopped the whole app rather than hiding a single page.
 *
 * Usage:  node scripts/build-electron-assets.js
 * Env:    QUANTA_API_URL   the deployed Quanta API to point the packaged app at
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "electron-app");

const API_URL = process.env.QUANTA_API_URL || "https://quanta-api-2i9a.onrender.com";

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/* Every script and stylesheet the page actually loads, in document order. */
const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
const styles = [...html.matchAll(/<link[^>]*\srel="stylesheet"[^>]*\shref="([^"]+)"/g)].map((m) => m[1]);

/* Query strings are cache-busting for the web; they mean nothing on disk. */
const clean = (list) => [...new Set(list.map((s) => s.split("?")[0]).filter(Boolean))];

const scriptsNeeded = clean(scripts);
const stylesNeeded = clean(styles);

/* The page does not reference itself, nor the manifest, the offline catalog or
   the two images it shows - so they are named here rather than discovered. */
const extraFiles = ["index.html", "manifest.json", "offline-pack.js", "image.jpg", "leeticon.png"];

console.log("==> Working out what the desktop app needs");
console.log(`    scripts: ${scriptsNeeded.length}   stylesheets: ${stylesNeeded.length}`);
for (const f of [...scriptsNeeded, ...stylesNeeded]) console.log(`      - ${f}`);

/* Monaco loads more of its own tree at runtime from paths it works out for
   itself, so the whole directory is copied rather than file by file. */
const monacoScripts = scriptsNeeded.filter((s) => s.startsWith("vendor/monaco/"));
const monacoRoot = path.join(ROOT, "vendor", "monaco", "min");

console.log("\n==> Copying the frontend into electron-app/");
/* Wiped first. A file left over from a previous build would be packaged and
   served even though nothing references it any more. */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let missing = 0;
const copy = (rel) => {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) {
    console.error(`    MISSING: ${rel}`);
    missing += 1;
    return;
  }
  const to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

for (const rel of [...extraFiles, ...stylesNeeded, ...scriptsNeeded.filter((s) => !s.startsWith("vendor/monaco/"))]) {
  copy(rel);
}

if (!fs.existsSync(monacoRoot)) {
  if (monacoScripts.length) {
    console.error(`    MISSING: vendor/monaco/min is required by ${monacoScripts[0]}`);
    missing += 1;
  }
} else {
  fs.cpSync(monacoRoot, path.join(OUT, "vendor", "monaco", "min"), { recursive: true });
  const count = fs.readdirSync(path.join(OUT, "vendor", "monaco", "min")).length;
  console.log(`    monaco tree copied (${count} top-level entries)`);
}

if (missing) {
  console.error(`\nFAILED: ${missing} file(s) the page needs are missing.`);
  console.error("Refusing to package a desktop app that would not start.");
  process.exit(1);
}

console.log("\n==> Pointing the packaged app at the deployed API");
/* The page is pointed at its own origin, unconditionally.

   lab-notes.js reads this value and builds every API URL from it, so setting it
   to the app's own origin makes each request same-origin, and the Electron
   main process forwards anything under /api to the deployed API. A direct
   cross-origin call fails, because the API sends CORS headers only to origins
   it recognises and a desktop app is not one of them.

   Unconditional on purpose. An address saved by an earlier build, or typed into
   Settings by hand, would be used instead and every call would fail - there is
   no value a reader can enter that works here, because the shell serves only
   its own origin. What they had is kept under quantaApiBaseLastSeen rather than
   thrown away, so nothing they set is lost. */
let packaged = fs.readFileSync(path.join(OUT, "index.html"), "utf8");
const bootstrap =
  "  <script>\n" +
  "    // Quanta desktop shell.\n" +
  "    //\n" +
  "    // Points the app at its own origin, so every request the page makes is\n" +
  "    // same-origin. The desktop shell forwards anything under /api to\n" +
  `    // ${API_URL} - the deployed API the website uses. A direct\n` +
  "    // cross-origin call would fail: the API sends CORS headers only to\n" +
  "    // origins it recognises.\n" +
  "    //\n" +
  "    // Set every time, not only when empty: an address from an earlier build\n" +
  "    // cannot work here, and leaving it in place would fail every request.\n" +
  "    (function () {\n" +
  "      try {\n" +
  "        var previous = localStorage.getItem(\"quantaApiBaseUrl\");\n" +
  "        if (previous && previous !== location.origin) {\n" +
  "          localStorage.setItem(\"quantaApiBaseLastSeen\", previous);\n" +
  "        }\n" +
  "        localStorage.setItem(\"quantaApiBaseUrl\", location.origin);\n" +
  "        // Code execution too. Without this, getRunServerBase() falls back\n" +
  "        // to app://localhost:3000 for a server that is not there, and Run\n" +
  "        // reports a compiler that cannot be reached. Routed here, /api/run\n" +
  "        // reaches the deployed API and its Judge0 integration - so the Lab\n" +
  "        // does not need a compiler server running on this PC.\n" +
  "        localStorage.setItem(\"quantaRunServerUrl\", location.origin);\n" +
  "        document.documentElement.classList.add(\"quanta-desktop\");\n" +
  "      } catch (e) { /* storage unavailable */ }\n" +
  "    })();\n" +
  "  </script>\n";
/* Matched on the tag rather than on its query, so the version bump cannot move
   the insertion point out from under it. */
const scriptTag = /(  <script src="script\.js)([^"]*)("\><\/script>)/;
if (!scriptTag.test(packaged)) {
  console.error("FAILED: could not find the script.js tag to insert the bootstrap before.");
  process.exit(1);
}
packaged = packaged.replace(scriptTag, bootstrap + "$1$2$3");
fs.writeFileSync(path.join(OUT, "index.html"), packaged);
console.log(`    api requests proxied to ${API_URL}`);

console.log("\n==> Stamping the version into the packaged app");
/* version.js is what the About panel reads, and it must be the version actually
   being shipped rather than the one left in the source tree. */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const versionFile = path.join(OUT, "version.js");
if (fs.existsSync(versionFile)) {
  const before = fs.readFileSync(versionFile, "utf8");
  /* Whether the line exists and whether it already says the right thing are two
     different questions, and the old check could not tell them apart.

     It treated "the replacement changed nothing" as "the line is missing", so
     the build failed precisely when the two versions already agreed - which is
     the one case that should pass silently. Syncing package.json to version.js,
     so the About page could not report one number on the website and a
     different one in the desktop app, made the stamp a no-op and broke the very
     build that packages it. */
  const VERSION_LINE = /window\.QUANTA_VERSION\s*=\s*"[^"]*"/;
  if (!VERSION_LINE.test(before)) {
    console.error("    FAILED: could not find the QUANTA_VERSION line to rewrite.");
    process.exit(1);
  }
  const stamped = before.replace(VERSION_LINE, `window.QUANTA_VERSION = "${pkg.version}"`);
  fs.writeFileSync(versionFile, stamped);
  console.log(`    About page will report ${pkg.version}`);
} else {
  console.log("    (no version.js in the asset list; nothing to stamp)");
}

const total = fs.readdirSync(OUT, { recursive: true })
  .filter((f) => {
    try { return fs.statSync(path.join(OUT, f)).isFile(); } catch { return false; }
  });
console.log(`\nDONE: ${total.length} files in electron-app/  ->  ${OUT}`);