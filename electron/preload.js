"use strict";
/* The one bridge between the page and Electron.
 *
 * Quanta's frontend is ordinary web code and stays that way: no `require`, no
 * `process`, no filesystem, no child processes. This file is the whole surface,
 * and it is deliberately tiny.
 *
 * It deliberately does NOT set the API address. The packaged index.html does
 * that, before any page script runs, by pointing the app at its own origin -
 * Electron then forwards /api to the deployed Quanta API. This file used to set
 * an absolute address of its own, which ran first, won, and put the app back to
 * making cross-origin calls the API would refuse.
 */
const { contextBridge, ipcRenderer } = require("electron");

/* The page is served from disk, so it needs to know it is not in a browser. */
try {
  document.documentElement.classList.add("quanta-desktop");
} catch (e) {
  /* no-op */
}

contextBridge.exposeInMainWorld("quantaDesktop", {
  isDesktop: true,
  platform: process.platform,

  /* Open a link in the reader's own browser. http(s) only, checked here and
     again in the main process; anything else is refused. */
  openExternal(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
    ipcRenderer.send("quanta:open-external", url);
    return true;
  },

  /* A failure worth a dialog rather than a blank window. */
  reportFatal(message) {
    ipcRenderer.send("quanta:fatal", String(message || "").slice(0, 500));
  }
});