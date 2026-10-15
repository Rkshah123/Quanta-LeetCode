# Quanta for Windows

The Quanta desktop application. It is the same frontend the website serves —
the same `index.html`, the same pages, the same catalog — loaded from disk
instead of from a web server, and pointed at the same deployed Quanta API and
the same TiDB database.

It is not a wrapper around a URL and it is not a reduced copy. Nothing was
rewritten: `electron/` is new, and the rest of the project is untouched.

---

## Install and run

**The installer**

```
release\Quanta-Setup-1.0.0.exe
```

Double-click it. It installs per-user, so no administrator rights are needed,
and it offers to change the install location. It creates:

- a **Quanta** desktop shortcut
- a **Quanta** entry in the Start Menu
- an icon on both, taken from `leeticon.png`

Uninstall from Windows Settings → Apps, or from the installer's own
"Apps & features" entry.

**Running from source**

```bash
npm install
npm run desktop          # opens the app
npm run desktop:assets   # only needed after changing the website
npm run desktop:build    # produces release\Quanta-Setup-<version>.exe
```

---

## How it reaches the data

The app is served from its own origin, `app://quanta`, out of `electron-app/`.

Anything the page requests under `/api` is forwarded by the Electron main
process to the deployed Quanta API:

```
app://quanta/api/problems  →  https://quanta-api-2i9a.onrender.com/api/problems
```

That indirection is there for a real reason. The API sends CORS headers only to
origins it recognises — `quanta-leetcode.vercel.app` is on that list, a desktop
app is not — so a direct cross-origin call from the app fails. Routing through
the main process makes every request same-origin, which removes the problem
rather than widening the API's allow-list.

It also means **the desktop app holds no database credentials**. It never talks
to MySQL and never has a password; it uses the public HTTPS API the website
uses, which applies its own access control server-side.

Code execution goes the same way. `/api/run` is forwarded to the deployed API
and its Judge0 integration, so **the Lab does not need a compiler server
running on your PC**. That is the `quantaRunServerUrl` setting you may have
pointed at a LAN address for the Android app — the desktop shell sets it to the
app's own origin, because an absolute address cannot work here.

### Pointing it somewhere else

```bash
QUANTA_API_URL=https://your-api.example.com npm run desktop:build
```

---

## What is where

| Path | What it is |
|---|---|
| `electron/main.js` | Main process: window, protocol, API forwarding, security |
| `electron/preload.js` | The entire renderer bridge — about 40 lines |
| `electron-app/` | The packaged copy of the website. Generated; not in git |
| `release/` | The installer. Generated; not in git |
| `scripts/build-electron-assets.js` | Builds `electron-app/` from the website |

`electron-app/` is derived from `index.html` at build time rather than listed by
hand. The Android build learned this the hard way: it once copied nine named
files, every module added since was silently left out, and because `lab-notes.js`
initialises Mock, Companies, Arena, Debugger and Review during start-up, one
missing file stopped the whole app rather than hiding a single page.

---

## Security

| Setting | Value | Why |
|---|---|---|
| `contextIsolation` | `true` | The page cannot reach the preload's scope |
| `nodeIntegration` | `false` | No `require`, no `fs`, no child processes in the page |
| `sandbox` | `true` | The renderer is sandboxed by the OS |
| `webviewTag` | `false` | No embedded webviews |
| `webSecurity` | default on | Same-origin policy applies |

Verified from inside the running app: `window.process` is `undefined`, and
`require("fs")` is refused. (Electron does expose a small browser-side `require`
shim to the page, as it does in every Electron app — it exposes almost nothing,
and the filesystem is not in it.)

Other measures:

- the path handler refuses any request that would climb out of the packaged
  directory;
- every link that is not part of the app opens in your default browser, checked
  twice — once in the page, once in the main process;
- camera, microphone and geolocation are denied outright;
- only one window, and a second launch focuses the first.

---

## Data and storage

Storage is `localStorage` under `app://quanta`, exactly as the website uses it.
Progress, favourites, notes, revision and settings are the same keys and the
same shapes the website writes, so they are preserved and synchronised through
the same API.

**This storage is separate from the website's.** The website's data lives under
`https://quanta-leetcode.vercel.app`; the desktop app's lives under
`app://quanta`. Because the same API and database sit behind both, anything you
change in one is visible in the other once it has synced — but the desktop app
does not inherit the browser's local state, and first launch starts from the
database.

The desktop shell sets `quantaApiBaseUrl` to its own origin on every start. An
address saved by an earlier build cannot work here, so rather than leave every
request failing, it is moved to `quantaApiBaseLastSeen` first.

---

## What was tested

`scripts/` and the suite in the temp folder were run against **both** the
website and the packaged app, requiring identical answers — catalog contents,
search results, problem statements, offered languages, execution output, Mock
validation, and every page opening.

See the report below for results and limitations.