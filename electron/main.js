"use strict";
/* Electron main process for Quanta.
 *
 * The point of this file is to load the *existing* Quanta frontend from disk -
 * the same index.html the website serves - and give it one thing it cannot
 * have on its own: the address of the deployed Quanta API, so it reaches the
 * same Render backend and the same TiDB database as the website.
 *
 * No database credentials live here. The app never talks to MySQL; it uses the
 * public HTTPS API the website already uses, which applies its own access
 * control server-side.
 */
const { app, BrowserWindow, shell, protocol, net, session, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

/* The deployed Quanta API. This is the same address the website and the Android
   build use - it is a public HTTPS endpoint, not a secret. Overridable at build
   time so a fork can point elsewhere without editing code. */
const API_BASE = process.env.QUANTA_API_URL || "https://quanta-api-2i9a.onrender.com";

/* Where the packaged frontend lives, relative to the app root. Built by
   scripts/build-electron-assets.js before packaging. */
const APP_DIR = path.join(__dirname, "..", "electron-app");

const isDev = !app.isPackaged;

/* Quanta's own pages are served from the app:// scheme; anything else - a
   LeetCode link, a company site - belongs in the user's browser. */
const APP_SCHEME = "app";
const APP_ORIGIN = `${APP_SCHEME}://quanta`;

/* Everything the frontend needs, served from disk.
   standard + secure make it a normal web origin: relative URLs, localStorage
   and fetch all behave, which a bare file:// URL would not give us. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

let mainWindow = null;

function resolveAsset(urlPath) {
  /* Never let a crafted path climb out of the packaged directory. */
  const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const target = path.normalize(path.join(APP_DIR, clean));
  if (!target.startsWith(path.normalize(APP_DIR))) return null;

  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;

  /* A missing path is the app's own routing: hand back the shell, exactly as
     the website's server does. */
  const shellFile = path.join(APP_DIR, "index.html");
  return fs.existsSync(shellFile) ? shellFile : null;
}

/* Read straight off disk rather than handing back a file:// URL.

   A file:// URL cannot reach inside an asar archive, which is where
   electron-builder puts this by default, so a packaged build would serve
   nothing. Reading the bytes works in both cases - packed or unpacked - and
   keeps the asar intact. */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);

    /* Everything under /api goes to the deployed Quanta API - exactly what
       vercel.json does for the website. It is proxied rather than called
       straight from the page because the renderer is served from app://, and
       the API only sends CORS headers to origins it recognises: a browser page
       on quanta-leetcode.vercel.app is allowed, a desktop app is not, so every
       direct call failed. Forwarding from the main process makes the page's
       requests same-origin, which removes the problem instead of widening the
       API's allow-list. It is also what keeps database credentials out of the
       desktop build - the app never holds any. */
    if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/health") {
      return proxyToApi(request, url);
    }

    const file = resolveAsset(url.pathname);
    if (!file) return new Response("Not found", { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
          "cache-control": "no-cache"
        }
      });
    } catch (err) {
      return new Response("Unreadable", { status: 500 });
    }
  });
}

/* The one outbound path in the whole application. */
async function proxyToApi(request, url) {
  const target = `${API_BASE}${url.pathname}${url.search}`;
  try {
    const init = {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries())
    };
    /* Electron will not send a streamed body unless told it is one. */
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await request.arrayBuffer();
      init.duplex = "half";
    }
    const upstream = await net.fetch(target, init);

    const headers = new Headers();
    const type = upstream.headers.get("content-type");
    if (type) headers.set("content-type", type);
    headers.set("cache-control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    /* An unreachable API is a state the page can render, not a reason to show
       a browser error page. */
    return new Response(
      JSON.stringify({ ok: false, error: "Quanta API unreachable", detail: String(err && err.message) }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: "#060d0b",
    title: "Quanta",
    icon: path.join(__dirname, "..", "leeticon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      /* The three settings that decide whether a page can reach the machine it
         is running on. All three are the safe way round. */
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  /* Anything that wants a new window - "Open in Website", a LeetCode link -
     goes to the default browser instead of opening inside the app. */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(APP_ORIGIN) || url.startsWith("app://")) {
      mainWindow.loadURL(url);
      return { action: "deny" };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  /* The same for a navigation the page attempts rather than a window it opens. */
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  /* Nothing in Quanta needs a camera, a microphone or a location. Denying them
     outright is cheaper than arguing with a prompt. */
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  /* The only channel the page has. Every message is checked here; the renderer
     is never trusted to have done it. */
  installBridge();
}

/* One channel, for one thing: open a link in the default browser.
   The page cannot start a process, read a file or reach the network under any
   other route, because the renderer has no Node at all. */
function installBridge() {
  const { ipcMain } = require("electron");

  ipcMain.handle("quanta:open-external-check", (_event, url) => /^https?:\/\//i.test(String(url || "")));

  ipcMain.on("quanta:open-external", (_event, url) => {
    /* Checked again here. Anything that is not a web address is dropped, so a
       compromised or mistaken page cannot use this to launch something else. */
    if (/^https?:\/\//i.test(String(url || ""))) shell.openExternal(url);
  });

  ipcMain.on("quanta:fatal", (_event, message) => {
    dialog.showErrorBox("Quanta", `Something went wrong while loading.\n\n${String(message || "").slice(0, 400)}`);
  });
}

/* One window only. A second launch focuses the window already open rather than
   starting a rival process that would fight over the same database records. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerAppProtocol();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* A crash while loading should say so rather than showing a blank window. */
app.on("render-process-gone", (_event, _contents, details) => {
  dialog.showErrorBox("Quanta", `The window stopped unexpectedly.\n\n${details.reason}`);
});

module.exports = { API_BASE, APP_DIR, isDev };