# Quanta

A personal coding workspace: problem tracker with full statements, a multi-language Code Lab, notes, and a study assistant — running from one Node/Express server on your PC, from a hosted API on the internet, or fully offline from the Android app.

## What you get

- **Problem catalog** — 782 problems seeded from the app, with real LeetCode numbers, titles, difficulties and statements stored in MySQL.
- **Online + offline** — statements are fetched from Quanta's database first, saved on the device afterwards, and shown instantly from that saved copy whenever there is no internet; a bundled offline pack covers all 679 stored statements even on a fresh device with no server anywhere.
- **Code Lab** — Java, JavaScript, Python, C and C++ in a Monaco editor, with JavaScript running locally in a sandboxed worker and the rest compiled on your PC — or in the free Judge0 cloud runner when the server has no compiler (a hosted server has no JDK).
- **Notes workspace** — topics, sections, rich-text tools, find/replace, export.
- **Assistant** — local fallback endpoint (safe, no external calls).
- **One API, two clients** — the desktop browser and the Android app call the same Express API.

## Architecture

```
Desktop browser ─┐                                ┌─→ MySQL (local, or hosted with TLS)
Android app ─────┼─→ Express API (LAN or HTTPS) ──┤
                 │        /api/problems/*         └─→ LeetCode (live, for statements
                 │        /api/run, /api/assistant     not yet in the catalog)
                 └─→ /health
```

Two addresses, deliberately separate:

| Setting | Purpose | Where |
|---|---|---|
| **Online API (problem database)** | Statements and catalog (`/api/problems`) | Settings → Connection |
| **Compiler server** | Java / C / C++ / Python execution | Settings → Connection |

Leave both empty when the app is served from the same machine as the server. On a phone, the compiler server points at your PC's LAN address and the online API points at the hosted HTTPS backend; if the PC does not answer, runs automatically fall back to the online API.

## Project layout

```
server.js               Express API + static hosting
db/pool.js              MySQL connection pool, TLS, health probe
db/migrate.js           versioned migrations (npm run migrate)
db/migrations/          *.sql, additive only
db/problems.js          catalog repository (parameterized queries)
scripts/import-problems.js   repeatable catalog import from LeetCode
scripts/verify-catalog.js    compare catalog against LeetCode's index
scripts/test-api.js     integration test suite (npm run test:api)
android-apk/            APK wrapper, build.sh, keystore
render.yaml             optional Render blueprint
```

---

## Technology stack

**23 named technologies — 6 languages plus 17 libraries, platforms and tools:**

| Category | Technologies | Count |
|---|---|---|
| Languages | JavaScript, HTML5, CSS3, SQL, Shell, Python (build helper) | 6 |
| Server runtime | Node.js ≥ 20, npm, Express 5, mysql2, dotenv | 5 |
| Data | MySQL 9.4 (local), TiDB Cloud Serverless (hosted, MySQL protocol + TLS) | 2 |
| Editor / client persistence | Monaco Editor, browser localStorage | 2 |
| Hosting | Vercel (static frontend), Render (API), GitHub (source) | 3 |
| Android packaging | WebView wrapper + Android SDK build-tools (aapt2, zipalign, apksigner) | 4 |
| Quality | `node --check` syntax gate, integration suite (`scripts/test-api.js`) | 2 |
| Code execution | Local toolchains (javac, gcc, g++, python3), free Judge0 CE cloud runner, browser sandbox for JavaScript | (environment) |

The frontend is deliberately framework-free: no React, no bundler, no browser-side `node_modules`. The browser downloads `index.html`, two stylesheets and two scripts (Monaco comes from a CDN) — which is why Vercel needs no build step.

## How Quanta works

### Pages (single-page app)

| Page | What it holds |
|---|---|
| **Quanta Lab** (home) | 782-problem catalog: search, difficulty chips, status filter, progress chip; list ⇄ detail split with a draggable divider; detail = statement (Notes tab) + workspace (Code tab: language select, Monaco, stdin, Run/Save, per-language code); maximized mode; add-problem dialog |
| **Notes** | Per-language notes: title, rich-text editor, section list, find/replace, word count, save, export (.html / .txt), delete |
| **Lab** | Multi-program Code Lab: create / rename / delete programs as tabs, language picker (Java, JavaScript, Python, C, C++), Monaco editor, stdin, Run, save-to-file, font size A− / A+, auto-save; editor ⇄ output panes split by a draggable divider (stacked on phones with an Editor / Output switch) |
| **Settings** | Theme, glow, editor font, default language, tab size, word wrap, line numbers, Monaco theme, minimap, layout reset, connection (Online API + Compiler server, each with Save / Test), backup export, reset dashboard |
| **About** | Build date, live stats (problems / solved / programs / notes), refresh, quick links, contact |

Around them: the mobile nav drawer (≤ 760 px), the add-problem and exit-confirm dialogs, and toasts.

### Request flow (online)

```
browser ──► quanta-leetcode.vercel.app              static: index.html + CSS + JS
   │                 │ vercel.json rewrites /api/* and /health
   ▼                 ▼
localStorage     quanta-api-2i9a.onrender.com ────► TiDB Cloud (MySQL over TLS)
   │                 │
   │                 ├─ /api/problems, /api/lc-description → catalog, live LeetCode fallback (written back)
   │                 ├─ /api/run → local toolchain if present, else Judge0 (submit → token → poll → result)
   │                 └─ /health
   └─ programs, notes, per-problem code, settings, statement cache (quantaDescCacheV1, newest 400), bundled offline statements (offline-pack.js, 679)
```

### Run flow (the Run button)

1. `GET /api/run/capabilities` (cached in memory) reports what the configured compiler server can execute. A custom `http://` address gets a short probe timeout so a switched-off PC cannot stall Run for a minute.
2. **JavaScript** runs in a sandboxed Web Worker in the browser — it works even when no server is reachable.
3. **Java / C / C++ / Python** go to `POST /api/run` on the configured compiler server (the PC on the same Wi-Fi: fastest, unlimited, works with no internet):
   - **Local toolchain present (your PC, `npm start`)** → compiled and executed on the spot; temp files are removed afterwards.
   - **No toolchain (Render's container)** → the free public Judge0 CE instance: submitted with `wait=false`, the returned token is polled until the program finishes or `JUDGE0_TIMEOUT_MS` elapses. Compile errors return `phase: "compile"`, timeouts `timedOut: true`, and rate limits / HTTP failures return plain-language messages. A Java class not named `Main` is renamed to `Main` for the cloud run only — string literals and comments are never touched.
4. **If the configured server cannot take the job** (PC off, wrong address, or no toolchain for that language), the client automatically retries on a *different* runner — the **Online API** address (hosted API → Judge0), or on the website this origin's own runner. That second step is what lets a phone run all four compiled languages with the laptop off, as long as there is internet. Only when both runners fail does Run report it, naming both addresses.
5. Every mode answers with the same shape: `{ ok, phase, stdout, stderr, exitCode, truncated, timedOut, time?, memory? }`.

### Statement flow

1. Opening a problem checks the device cache (`quantaDescCacheV1`).
2. On a miss, `GET /api/problems/:id` / `/api/lc-description?slug=` answers from the catalog first and falls back to LeetCode live.
3. A statement fetched live is written back into the catalog, so every device benefits next time.
4. If **both network sources fail** (airplane mode, no server anywhere), the bundled `offline-pack.js` — every one of the 679 stored statements, shipped inside the app and loaded lazily only at this point — provides the copy, labelled **Bundled with the app** and saved into the device cache for next time.
5. Only when even the bundle has no entry (103 problems never had a stored statement) does the app show an explicit *"Description unavailable right now"* — never a blank pane, never an invented statement.

### Where data lives

| Data | Lives in | Scope |
|---|---|---|
| Catalog + statements (782 rows, 679 statements stored) | MySQL (TiDB Cloud hosted) | every device |
| Programs, notes, per-problem code, goals | browser localStorage | per device, per origin |
| Settings, split-pane sizes, statement cache | browser localStorage | per device, per origin |
| Code runs | nowhere | runs are never stored |

### Which mode am I in?

| Mode | Address | Statements | Java / C / C++ / Python | JavaScript |
|---|---|---|---|---|
| **Laptop, online** | `https://quanta-leetcode.vercel.app` | ✅ catalog + live LeetCode | ✅ Render → toolchain or Judge0 | ✅ browser |
| **Laptop, offline** | `npm start` → `http://localhost:3000` | ✅ from your local database | ✅ compiled on your PC | ✅ browser |
| **Phone, online (PC off)** | APK with internet | ✅ hosted API + bundled pack | ✅ auto-fallback → hosted API → Judge0 | ✅ browser |
| **Phone, offline (LAN)** | APK with the PC running on the same Wi-Fi | ✅ bundled pack + already-read ones (the PC's database too, if Online API is empty) | ✅ compiled on your PC | ✅ browser |
| **Phone, offline (no PC)** | APK, no internet anywhere | ✅ bundled pack (679) + already-read ones (up to 400) | ❌ needs a compiler somewhere — there is no device or network to compile on | ✅ browser |

Keep **Settings → Online API** and **Settings → Compiler server** empty in the normal setup: empty means "this app's own server", which is exactly right on localhost and on Vercel (the rewrite makes it same-origin).

## Responsive layout

A fixed-viewport shell: top bar and nav stay put while the active page scrolls inside its own container. Breakpoints: **1500 / 1221 / 1101 / 980 / 901 / 761 / 640 / 480 / 380 px** (plus hover and reduced-motion queries).

| Width | Navigation | Quanta Lab | Lab |
|---|---|---|---|
| ≥ 1101 px | nav row | list ⇄ detail, draggable | editor ⇄ output, draggable |
| 901–1100 px | nav row | list ⇄ detail | stacked, draggable row divider |
| 761–900 px | nav row | single column (list ⇄ detail swap) | stacked |
| ≤ 760 px | burger + slide-in drawer | single column | stacked + Editor / Output switch |

Verified at **1920×1080, 1600×900, 1366×768, 1280×720, 1024×768, 768×1024 and 390×844**: no horizontal scrolling, nothing overflowing the viewport, the nav row fits, the drawer opens / navigates / closes correctly, and the console stays clean.

Split-pane sizes persist in localStorage as `quantaSplitSizesV2`. Only a **live drag** changes the stored preference; restoring clamps the *display* against the current track, so a window that is briefly short (mobile URL bar, a snapped window) can never ratchet the saved layout narrower. Legacy `quantaSplitSizesV1` values are dropped on load because they may already be ratcheted. Double-click a divider — or press Settings → **Reset layout** — to return to the CSS defaults.

---

## 1. Install dependencies

Requirements: Node.js 18+ (this machine has Node 24) and npm.

```bash
npm install
```

If PowerShell blocks npm scripts on your machine:

```powershell
npm.cmd install
```

## 2. Install and configure MySQL locally

This machine already has MySQL 9.4 installed and running as the `MySQL94` Windows service. To check:

```powershell
Get-Service *mysql*
```

If it is missing, download the MySQL Community ZIP archive, unzip it, and initialize it:

```powershell
mysqld --initialize-insecure --basedir=C:\mysql --datadir=C:\mysql\data
mysqld --install MySQL94
net start MySQL94
```

## 3. Create the database and apply migrations

The database `Quanta-Leetcode` already exists on this machine and is used as-is. If it is ever missing, create it first:

```sql
CREATE DATABASE IF NOT EXISTS `Quanta-Leetcode`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;
```

Then apply the schema:

```bash
npm run migrate            # apply pending migrations
npm run migrate -- --status   # show what is applied, changes nothing
```

Migrations are additive (`CREATE TABLE IF NOT EXISTS`), recorded in `schema_migrations`, and never drop, truncate or delete data. Re-running is harmless.

Tables created: `problems`, `problem_examples`, `categories`, `problem_categories`, `schema_migrations`.

> The database name contains a hyphen, so it must always be written as `` `Quanta-Leetcode` `` inside SQL. `.env` needs no quoting for it.

## 4. Configure `.env`

```powershell
copy .env.example .env
```

Then fill in your own values:

| Variable | Meaning |
|---|---|
| `PORT` | Server port (default `3000`; the OS value wins, so hosting providers can inject it) |
| `HOST` | Interface to listen on (default `0.0.0.0`, so phones on the LAN can connect) |
| `DB_HOST`, `DB_PORT` | MySQL address (default `localhost`, `3306`) |
| `DB_USER`, `DB_PASSWORD` | MySQL credentials |
| `DB_NAME` | Database name (default `Quanta-Leetcode`) |
| `DB_SSL` | `true` for hosted MySQL with TLS |
| `DB_SSL_CA` | Path to the provider's CA bundle |
| `RATE_LIMIT_MAX` | Requests per minute per IP for `/api/*` (`0` disables) |
| `RUN_RATE_LIMIT_MAX` | Requests per minute per IP for `/api/run` and `/api/assistant` (default `30`) |
| `MAX_CONCURRENT_RUNS` | How many code runs may execute at once (default `4`) |
| `JUDGE0_URL` | Cloud runner used when a language has no local compiler (default `https://ce.judge0.com`, `""` disables) |
| `JUDGE0_TOKEN` | Optional Bearer token for a private or RapidAPI Judge0 instance — never sent to clients |
| `JUDGE0_TIMEOUT_MS` | How long a cloud run may take (default `60000`) |
| `TRUST_PROXY` | Hops to trust from `X-Forwarded-For` (auto-enabled on Render) |
| `CORS_ORIGINS` | Extra browser origins allowed to call the API, comma separated |

> **Important:** dotenv treats `#` as the start of a comment. If your password contains `#` or `$`, quote it: `DB_PASSWORD="Mysql@#123"`. An unquoted value is silently truncated and every connection fails with "Access denied".

`.env` is gitignored. Never commit it.

## 5. Import problem data

The catalog is imported from your own app data and verified against LeetCode's official problem index. Nothing is invented: problems LeetCode does not know are imported without a statement, and the app says so instead of making one up.

```bash
npm run import:problems                     # seed list from lab-notes.js + statements
npm run import:problems -- --no-descriptions   # metadata only (one request, fast)
npm run import:problems -- --from backups\leetcode-dashboard-backup-2026-01-01.json
npm run import:problems -- --limit 20
npm run import:problems -- --refresh-descriptions
```

Results on this machine: **782 catalog rows, 679 statements stored** (~3 MB).

Re-running is safe: existing rows are updated, existing statements are never overwritten unless you pass `--refresh-descriptions`.

Statements also trickle in by themselves — every statement the app fetches live from LeetCode is written back into the catalog for next time.

## 6. Run and test the API locally

```bash
npm start            # http://localhost:3000
```

On start you should see:

```
Server running on http://localhost:3000 (listening on 0.0.0.0)
Database OK — Quanta-Leetcode (latency 1ms)
```

Verify with the test suite (starts real servers on throwaway ports, read-only against your data):

```bash
npm run test:api
```

## 7. Test from a phone on the same Wi-Fi

1. Find the PC's LAN address: `ipconfig` → IPv4 Address (for example `192.168.1.5`).
2. The server already listens on every interface, so nothing else is needed on the server side.
3. Allow Node through Windows Firewall (Private networks is enough):
   - **Windows Security → Firewall & network protection → Allow an app through firewall → Change settings → Allow another app → Node.js JavaScript Runtime**, tick **Private**.
   - Or a one-off rule:
     ```powershell
     netsh advfirewall firewall add rule name="Quanta dev server" dir=in action=allow protocol=TCP localport=3000
     ```
4. On the phone, open `http://<PC-IP>:3000` in the browser, or use the APK.
5. Settings → Connection:
   - **Compiler server** = `http://<PC-IP>:3000` → **Test** (lists the available toolchains).
   - **Online API** = leave empty (same server) → **Test** shows `API online — database OK`.

## 8. Create a hosted MySQL database

Local MySQL only answers on your own network, and only while the PC is on. For anything else you need a database on the internet.

Recommended: **TiDB Cloud Serverless** — MySQL protocol compatible, so the existing `mysql2` code works unchanged, with a TLS endpoint and a free tier.

1. Sign up at `tidbcloud.com` → create a **Serverless** project.
2. Copy the connection parameters: host, port (usually `4000`), user, password. Download the provider's CA bundle if one is offered.
3. Create the database:
   ```sql
   CREATE DATABASE IF NOT EXISTS `Quanta-Leetcode`
     DEFAULT CHARACTER SET utf8mb4
     DEFAULT COLLATE utf8mb4_unicode_ci;
   ```
4. Apply the schema from your PC by pointing `.env` at it temporarily:
   ```powershell
   $env:DB_HOST="gateway01.<region>.tidbcloud.com"; $env:DB_PORT="4000"
   $env:DB_USER="..."; $env:DB_PASSWORD="..."; $env:DB_SSL="true"
   npm run migrate
   npm run import:problems
   ```
5. **Verify the limits before you rely on it** — free tiers change. Check the provider's current storage allowance, connection count, and inactivity policy on their pricing page, and confirm the connection works:
   ```bash
   npm run test:api
   ```

Alternatives with a free entry point: Aiven for MySQL (trial), AWS RDS (12-month free tier), Railway or Fly with a MySQL add-on. Postgres-only services (Supabase, Neon) will not work without a code change, because this backend speaks MySQL.

## 9. Deploy the Express backend

Render is the simplest fit: it runs the same `server.js`, and `render.yaml` describes the service.

1. Push this repository to GitHub (confirm `.env` is **not** in the pushed files — it is gitignored).
2. In Render: **New → Blueprint** → pick the repo → it reads `render.yaml`.
3. Type the database values in the service's **Environment** tab (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL=true`). They are stored by Render, never in git.
4. Deploy. The service exposes `https://<name>.onrender.com`; `/health` must report `"ok": true`.
5. **After every later push**, make sure the service actually picked it up: open the service in Render and check that "Last successfully deployed commit" matches your newest commit on GitHub. If it does not, click **Manual Deploy → Deploy latest commit** (a few seconds of clicking). Push-triggered deploys depend on Render's GitHub webhook reaching your account; when it does not, the manual button is the reliable path and the result is identical.

Alternatives: Railway (`railway up`), Fly (`fly launch`), or any host that runs `npm start` and injects `PORT`.

## 10. Production environment variables

Set these on the hosting provider (dashboard or CLI), not in `.env`:

```
DB_HOST=gateway01.<region>.tidbcloud.com
DB_PORT=4000
DB_USER=<user>
DB_PASSWORD=<password>
DB_NAME=Quanta-Leetcode
DB_SSL=true
RATE_LIMIT_MAX=300
RUN_RATE_LIMIT_MAX=30
MAX_CONCURRENT_RUNS=4
CORS_ORIGINS=
```

Do not set `HOST` (the default `0.0.0.0` is what the provider needs). `PORT` is injected by the provider and now takes priority over `.env`. On Render, `TRUST_PROXY` is enabled automatically (Render terminates TLS in front of your app); on another host behind a proxy, set `TRUST_PROXY=1` yourself — without it every visitor shares one rate-limit bucket.

After the first deploy, apply the schema and import the catalog once against the hosted database (step 8.4), because the hosting container has no MySQL client of its own.

## 11. Set the public API URL in Quanta

1. Open Quanta → **Settings → Connection → Online API (problem database)**.
2. Enter `https://<your-service>.onrender.com` → **Save** → **Test** → `API online — database OK`.
3. Statements now come from the hosted database on any network, and keep working on the PC when the phone is on mobile data.

The **Compiler server** field is independent and still points at your PC's LAN address, so code execution keeps working on the same Wi-Fi and stays off on other networks.

## 11b. Deploy the web app to Vercel (optional)

The frontend is plain HTML/CSS/JavaScript — no framework, no build step — so Vercel hosts it as a static site. Two files in the repo do the work:

- `vercel.json` rewrites `/api/*` and `/health` to the Render backend, so the app keeps using its normal same-origin API address. No Settings entry is needed on any device.
- `.vercelignore` keeps the backend (`server.js`, `db/`, `scripts/`), the 72 MB `android-apk/` folder, `.env*` and `keys.txt` off the public site.

**Vercel → New Project → import `Rkshah123/Quanta-LeetCode`, then:**

| Setting | Value |
|---|---|
| Framework Preset | **Other** |
| Root Directory | `.` |
| Build Command | *(leave empty — there is nothing to build)* |
| Output Directory | `.` |
| Install Command | *(leave empty)* |
| Environment Variables | *(none — the API address lives in `vercel.json`)* |
| Node Version | *(not used)* |

Commit the repo first: `vercel.json` and `.vercelignore` must be on GitHub for Vercel to see them.

**Live deployment:** `https://quanta-leetcode.vercel.app` — project `quanta-leetcode`, connected to `Rkshah123/Quanta-LeetCode` (branch `main`), so every push redeploys automatically. The earlier `quanta-leet-code.vercel.app` address is kept as a redirect.

**CORS (one line, only for the direct-connect fallback):** the proxied setup is same-origin, so CORS is not involved. If you ever point **Settings → Online API** straight at Render from the Vercel site instead, add your Vercel domain on Render:

```
CORS_ORIGINS=https://quanta-leetcode.vercel.app
```

**What works on Vercel, and what still needs the PC:**

| Feature | On Vercel |
|---|---|
| Problem list, search, difficulty filter, pagination | ✅ via the Render API |
| Full problem statements | ✅ from TiDB Cloud |
| Notes, per-problem code, goals (stored in the browser) | ✅ unchanged, per device |
| Run **C / C++ / Python** | ✅ Render's container has those compilers |
| Run **Java** | ✅ Render has no JDK, so the run goes to the free Judge0 cloud runner (~2 s) |
| Refresh / deep link | ✅ `vercel.json` serves `index.html` for unknown paths |

**Code execution (Run button):** the server compiles locally whenever the toolchain exists (your PC), and automatically falls back to the free public Judge0 instance for any language it cannot compile — that is what makes **Java work on Render**, where there is no JDK. Nothing about a run is stored, and `JUDGE0_TOKEN`, if you use one, never leaves the server. Set `JUDGE0_URL=""` to switch the cloud runner off, or point it at your own instance.

`localhost` and the LAN setup keep working exactly as before — Vercel is an extra host, not a replacement.

## 12. Rebuild and install the Android APK

`android-apk/Quanta.apk` was **not** rebuilt for these changes. The web app inside the APK picks them up on the next build, and the new Settings field works there too.

```bash
cd android-apk
QUANTA_LAN_IP=<your-pc-ip> QUANTA_API_URL=https://<your-service>.onrender.com ./build.sh
```

- `QUANTA_LAN_IP` only sets the **compiler-server** default. It is never used as the online endpoint.
- `QUANTA_API_URL` sets the **online API** default inside the wrapper; it is optional, and Settings can override it at any time.
- The manifest already allows internet access and cleartext HTTP for local addresses, so both `https://…` and `http://192.168.x.x:3000` work.
- `fixzip.py`, the keystore and the signing steps are unchanged (keystore password `quanta123`).

Then install over USB: copy `android-apk/Quanta.apk` to the phone, allow "install unknown apps", open it. The same keystore must sign every future update.

## 13. Test on a different Wi-Fi network or mobile data

1. On the PC, stop the server (`npm start` no longer running).
2. On the phone (mobile data or a friend's Wi-Fi), open the app: statements must still load from the hosted API.
3. In Settings → Connection, the **Online API** Test must still say `API online — database OK`, while the **Compiler server** Test fails — that is expected, because the PC is not reachable from outside your network.
4. Back on your own Wi-Fi, the compiler server works again.

## 14. Test offline mode

1. With the app open on a problem, turn on airplane mode (or stop both the server and the internet).
2. Re-open a problem you have already read: it appears instantly with **Saved on this device**.
3. Open a problem you have never read: on the app (and the website) its statement comes from the bundled pack, labelled **Bundled with the app**; for the 103 problems that never had a stored statement you get an explicit "Description unavailable right now" message — never a blank pane and never a fake statement.
4. Notes, Code Lab programs and JavaScript runs keep working fully offline; Java / C / C++ / Python runs report that no runner answered (a compiled language needs a compiler somewhere — offline there is none) instead of hanging.

The cache lives in `localStorage` under `quantaDescCacheV1` (newest 400 statements). Cached statements are refreshed in the background after 7 days, without blocking the view.

## 15. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Access denied for user 'root'@'localhost'` | `.env` password contains `#` or `$` and was truncated. Quote it: `DB_PASSWORD="…"`. |
| `Database unavailable` on `/health` | Wrong `DB_HOST`/`DB_PORT`, MySQL service stopped, or the hosted database asleep. `npm run migrate -- --status` shows the same error with more detail. |
| `ECONNREFUSED` with the hosted DB | TLS required: set `DB_SSL=true`, and `DB_SSL_CA` if the provider supplies a CA bundle. |
| Phone cannot open `http://<PC-IP>:3000` | Windows Firewall: allow Node.js on Private networks (step 7). Also check both devices are on the same SSID and that the router is not isolating clients ("AP/client isolation"). |
| Statements do not load on mobile data | The Online API URL is missing or wrong, or the host is asleep. Test it in Settings; free hosts wake in ~30s. |
| First hosted request is very slow | Free hosting services sleep after inactivity. The second request is fast. |
| `npm` blocked by execution policy | Use `npm.cmd` (or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`). |
| Statements show as unavailable although online | A stale or wrong Online API value. Clear the field to fall back to the app's own server, then Test. |
| Duplicate statements after importing twice | Not possible: rows are keyed by unique slug and imports are idempotent. |
| APK does not reflect new code | The APK embeds a snapshot of the web files. Rebuild it (step 12). |

---

## API reference

| Endpoint | Notes |
|---|---|
| `GET /health` | `{ ok, uptime, timestamp, database: { configured, ok, latencyMs } }` |
| `GET /api/problems?q=&difficulty=&category=&num=&limit=&offset=` | Search + pagination (max 100 per page) |
| `GET /api/problems/:id` | By database id (digits) or LeetCode slug; includes the statement |
| `GET /api/categories` | Category list |
| `GET /api/lc-description?slug=` | Statement from the catalog, falling back to LeetCode |
| `GET /api/lc-lookup?slug=` | Live LeetCode metadata |
| `GET /api/lc-skeleton?slug=` | Live LeetCode starter code |
| `GET /api/run/capabilities` | Which languages this server can execute |
| `POST /api/run` | `{ language, code, stdin }` → compile/run |
| `POST /api/assistant` | `{ message }` → reply (local fallback) |

Errors use one shape: `{ ok: false, error: "…" }`, with `400` for bad input, `404` for unknown records, `429` when rate limited, `503` when the database is unreachable. Credentials, stack traces and connection details are never returned.

Security notes: database credentials live only in the backend `.env` or the host's environment; every query is parameterized; `/api/*` is rate limited per IP (code execution has a tighter budget and a concurrency cap); `/health` reports database failures generically instead of echoing driver errors; CORS is restricted to the Android wrapper, localhost, private LAN origins and any extra origin in `CORS_ORIGINS`; `server.js`, `db/`, `scripts/`, `.env*`, `keys.txt` and `*.log` are never served statically.

## Quality commands

```bash
npm run check      # syntax check of all JavaScript
npm run migrate -- --status
npm run import:problems -- --dry-run
npm run test:api   # integration tests against a real server + database
```

`npm run test:api` covers: health and database reporting, pagination and search, invalid input, missing records, numeric id and slug lookup, statement delivery from the database, run/assistant endpoints, static file protection, CORS rules, the client-side cache wiring, rate limiting, graceful behaviour when the database is down, and the full **cloud-runner** path — a second server started with its `PATH` reduced to Node's own directory (exactly the situation on Render, where no compiler exists) driving Java through Judge0: a real run, a compile error, a runaway loop hitting the time limit, stdin, and a class whose name differs from `Main`. All tests currently pass (**59/59**).

`scripts/verify-catalog.js` compares the catalog against LeetCode's official index and reports any row that disagrees; `--repair` rewrites those fields with LeetCode's own values.

## Assistant endpoint

The assistant currently returns local fallback replies only. Adding a hosted model needs two things: put the key in the backend environment (`HF_API_KEY` in `.env`, or the provider's dashboard after deploying) and implement the call in `server.js` where `getAssistantFallback` is used today. The key must stay on the server — never in `index.html`, `lab-notes.js` or the APK.
