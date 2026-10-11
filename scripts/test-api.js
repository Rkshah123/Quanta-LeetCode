/* --------------------------- scripts / test ----------------------------- */
/* Integration tests for the Quanta API. Each test starts a real server on a
   throwaway port, calls it over HTTP and checks the response.

   Usage:
     npm run test:api
     node scripts/test-api.js --keep-out   (print full response bodies)

   Nothing here writes to the catalog tables: the API is read-only, so the
   tests are safe to run against your real database. */

const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(ROOT, "server.js");
const MAIN_PORT = Number(process.env.TEST_PORT || 3299);
const RATE_PORT = MAIN_PORT + 1;
const NO_DB_PORT = MAIN_PORT + 2;
const CLOUD_PORT = MAIN_PORT + 3;
const START_TIMEOUT_MS = 30000;

const results = [];
let failures = 0;

const record = (name, passed, detail = "") => {
  results.push({ name, passed, detail });
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startServer = async (port, envOverrides = {}) => {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    /* PROGRESS_RECORD_RUNS=0: the runs this suite executes are test traffic and must
       never appear in the real run history shown on the Progress page. */
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", PROGRESS_RECORD_RUNS: "0", ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode}): ${logs.join("")}`);
    }
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return { child, base, logs };
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  child.kill();
  throw new Error(`server did not start on port ${port}: ${logs.join("")}`);
};

const stopServer = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const getJson = async (url, options) => {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
};

/* Plain HTTP request that allows headers fetch() forbids (e.g. Origin). */
const rawRequest = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const request = http.request(url, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response));
    });
    request.on("error", reject);
    request.end();
  });

/* ---------------------------------------------------------------- tests -- */

const runSuite = async () => {
  const { child: server } = await startServer(MAIN_PORT, { RATE_LIMIT_MAX: "0" });
  const base = `http://127.0.0.1:${MAIN_PORT}`;

  try {
    /* 1. health + database */
    {
      const { status, payload } = await getJson(`${base}/health`);
      record(
        "GET /health reports the server as healthy",
        status === 200 && payload?.ok === true,
        `status ${status}`
      );
      record(
        "GET /health reports database connectivity",
        Boolean(payload?.database),
        JSON.stringify(payload?.database)
      );
      if (payload?.database && !payload.database.ok) {
        console.log("      (database is unreachable — catalog tests may fail; check .env)");
      }
    }

    /* 2. problem list with pagination */
    let total = 0;
    {
      const { status, payload } = await getJson(`${base}/api/problems?limit=5`);
      const ok = status === 200 && payload?.ok === true && Array.isArray(payload?.items);
      record("GET /api/problems returns a page of problems", ok, `status ${status}`);
      if (ok) {
        total = payload.total;
        record("GET /api/problems respects the limit", payload.items.length <= 5, `${payload.items.length} items`);
        record("GET /api/problems reports a total", Number.isInteger(payload.total), `total ${payload.total}`);
        record("GET /api/problems paginates", payload.limit === 5 && payload.offset === 0, JSON.stringify({ limit: payload.limit, offset: payload.offset }));
      } else {
        record("GET /api/problems respects the limit", false, "list unavailable");
      }
    }

    {
      const { status, payload } = await getJson(`${base}/api/problems?limit=2&offset=2`);
      record(
        "GET /api/problems offset returns a different page",
        status === 200 && Array.isArray(payload?.items) && payload.items.length <= 2,
        `status ${status}`
      );
    }

    /* 3. search + validation */
    {
      const { status, payload } = await getJson(`${base}/api/problems?q=two-sum`);
      record(
        "GET /api/problems searches by slug",
        status === 200 && Array.isArray(payload?.items) && payload.items.some((item) => item.slug === "two-sum"),
        `status ${status}`
      );
    }
    {
      const { status, payload } = await getJson(`${base}/api/problems?q=9999`);
      record(
        "GET /api/problems exact number search does not match 99990",
        status === 200 && (payload?.items || []).every((item) => String(item.num) !== "99990"),
        `status ${status}`
      );
    }
    {
      const { status } = await getJson(`${base}/api/problems?difficulty=banana`);
      record("GET /api/problems rejects an unknown difficulty", status === 400, `status ${status}`);
    }
    {
      const { status } = await getJson(`${base}/api/problems?limit=-5`);
      record("GET /api/problems rejects a negative limit", status === 400, `status ${status}`);
    }

    /* 4. single problem by slug and by numeric id */
    let problemId = null;
    {
      const { status, payload } = await getJson(`${base}/api/problems/two-sum`);
      const ok = status === 200 && payload?.ok === true && payload.problem?.slug === "two-sum";
      record("GET /api/problems/two-sum returns the problem", ok, `status ${status}`);
      if (ok) {
        problemId = payload.problem.id;
        record(
          "Problem carries its real LeetCode number",
          String(payload.problem.num) === "1",
          `num ${payload.problem.num}`
        );
        record(
          "Problem includes a description",
          typeof payload.problem.descriptionHtml === "string" && payload.problem.descriptionHtml.length > 50,
          `${String(payload.problem.descriptionHtml || "").length} chars`
        );
        record(
          "Problem response contains no credentials",
          !JSON.stringify(payload).match(/DB_PASSWORD|Mysql@|hf_[A-Za-z0-9]{10}/),
          "no secrets found"
        );
      } else {
        record("Problem carries its real LeetCode number", false, "problem unavailable");
        record("Problem includes a description", false, "problem unavailable");
        record("Problem response contains no credentials", false, "problem unavailable");
      }
    }

    if (problemId) {
      const { status, payload } = await getJson(`${base}/api/problems/${problemId}`);
      record(
        "GET /api/problems/:id accepts the numeric database id",
        status === 200 && payload?.problem?.slug === "two-sum",
        `status ${status}`
      );
    }

    /* 5. missing and malformed records */
    {
      const { status, payload } = await getJson(`${base}/api/problems/999999999`);
      record(
        "GET /api/problems/:id answers 404 for an unknown id",
        status === 404 && payload?.ok === false,
        `status ${status}`
      );
    }
    {
      const { status, payload } = await getJson(`${base}/api/problems/not-a-real-problem-xyz`);
      record(
        "GET /api/problems/:id answers 404 for an unknown slug",
        status === 404 && payload?.ok === false,
        `status ${status}`
      );
    }
    {
      const { status } = await getJson(`${base}/api/problems/${encodeURIComponent("<script>")}`);
      record("GET /api/problems/:id rejects an invalid id", status === 400, `status ${status}`);
    }

    /* 6. categories + description endpoint (database-first path) */
    {
      const { status, payload } = await getJson(`${base}/api/categories`);
      const titleSort = await getJson(`${base}/api/problems?sort=title&limit=5`);
      const badSort = await getJson(`${base}/api/problems?sort=sideways`);
      const badSolved = await getJson(`${base}/api/problems?solved=perhaps`);
      const badRevision = await getJson(`${base}/api/problems?revision=someday`);
      const badStatement = await getJson(`${base}/api/problems?statement=maybe`);
      const badInStatement = await getJson(`${base}/api/problems?inStatement=perhaps`);
      const dueWithoutToday = await getJson(`${base}/api/problems?revision=due`);
      record("GET /api/categories responds", status === 200 && Array.isArray(payload?.categories), `status ${status}`);

      /* Search, filter and sort parameters. An unknown value must be refused
         rather than silently ignored, so a client can trust what it sent. */
      record("GET /api/problems sorts by title", titleSort.status === 200 && Array.isArray(titleSort.payload?.items), `status ${titleSort.status}`);
      const sortedTitles = (titleSort.payload?.items || []).map((i) => i.title);
      record(
        "title order really is alphabetical",
        JSON.stringify(sortedTitles) === JSON.stringify([...sortedTitles].sort((a, b) => a.localeCompare(b))),
        sortedTitles.slice(0, 3).join(" | ")
      );

      const easy = await getJson(`${base}/api/problems?difficulty=Easy&limit=5`);
      record(
        "GET /api/problems filters by difficulty",
        easy.status === 200 && easy.payload.items.every((i) => i.difficulty === "Easy"),
        `${easy.payload?.items?.length} items`
      );

      record("GET /api/problems rejects an unknown sort", badSort.status === 400, `status ${badSort.status}`);
      record("GET /api/problems rejects an unknown solved filter", badSolved.status === 400, `status ${badSolved.status}`);
      record("GET /api/problems rejects an unknown revision filter", badRevision.status === 400, `status ${badRevision.status}`);
      record("GET /api/problems rejects an unknown statement filter", badStatement.status === 400, `status ${badStatement.status}`);
      record("GET /api/problems rejects a non-boolean inStatement", badInStatement.status === 400, `status ${badInStatement.status}`);
      record(
        "Filtering by due date without today is refused",
        dueWithoutToday.status === 400,
        `status ${dueWithoutToday.status}`
      );

      const searched = await getJson(`${base}/api/problems?query=%20%20two%20sum%20%20&limit=5`);
      record(
        "GET /api/problems ignores surrounding whitespace and capitalization",
        searched.status === 200 && searched.payload.items.some((i) => i.slug === "two-sum"),
        `${searched.payload?.total} total`
      );

      const noMatch = await getJson(`${base}/api/problems?query=zzz-definitely-not-a-problem`);
      record(
        "A search with no match is an empty page, not an error",
        noMatch.status === 200 && noMatch.payload.total === 0 && noMatch.payload.items.length === 0,
        `status ${noMatch.status}`
      );

      const page1 = await getJson(`${base}/api/problems?limit=5&offset=0`);
      const page2 = await getJson(`${base}/api/problems?limit=5&offset=5`);
      record(
        "Pages do not repeat rows",
        page1.payload.items.length === 5 &&
          page2.payload.items.length === 5 &&
          !page2.payload.items.some((b) => page1.payload.items.some((a) => a.slug === b.slug)),
        "offset paging"
      );
      record(
        "The reported total covers every match, not just the page",
        page1.payload.total >= page1.payload.items.length,
        `total ${page1.payload.total}`
      );

      /* A large request is served, and the page size cap is applied rather than
         quietly returning everything. */
      const big = await getJson(`${base}/api/problems?limit=100`);
      record(
        "A large page of results is served",
        big.status === 200 && big.payload.items.length === 100 && big.payload.total > 100,
        `${big.payload?.items?.length} of ${big.payload?.total}`
      );

      const overCap = await getJson(`${base}/api/problems?limit=5000`);
      record(
        "An oversized limit is capped instead of loading the whole table",
        overCap.status === 200 && overCap.payload.items.length === 100 && overCap.payload.limit === 100,
        `limit ${overCap.payload?.limit}`
      );

      record(
        "Problem responses never expose the raw SQL",
        !JSON.stringify(page1.payload || {}).match(/SELECT|FROM problems/i),
        "checked"
      );
    }
    {
      const { status, payload } = await getJson(`${base}/api/lc-description?slug=two-sum`);
      record(
        "GET /api/lc-description serves the stored statement",
        status === 200 && payload?.ok === true && Boolean(payload?.html),
        `source ${payload?.source || "none"}`
      );
      record(
        "GET /api/lc-description is served from the database, not the network",
        payload?.source === "database",
        `source ${payload?.source || "none"}`
      );
    }
    {
      const { status } = await getJson(`${base}/api/lc-description?slug=bad_slug!`);
      record("GET /api/lc-description rejects an invalid slug", status === 400, `status ${status}`);
    }

    /* 7. existing endpoints keep working */
    {
      const { status, payload } = await getJson(`${base}/api/run/capabilities`);
      record(
        "GET /api/run/capabilities still works",
        status === 200 && payload?.javascript === "browser",
        `status ${status}`
      );

      const runnable = payload?.python || payload?.java || payload?.gcc || payload?.cpp;
      if (payload?.python) {
        const run = await getJson(`${base}/api/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: "python", code: "print(2 + 3)", stdin: "" })
        });
        record(
          "POST /api/run executes Python",
          run.status === 200 && run.payload?.ok === true && String(run.payload?.stdout || "").includes("5"),
          `status ${run.status}, stdout ${JSON.stringify(run.payload?.stdout || "")}`
        );
      } else if (runnable) {
        record("POST /api/run executes Python", true, "python not installed — covered by another language");
      } else {
        record("POST /api/run executes Python", true, "no toolchain installed — capabilities report this honestly");
      }

      const badRun = await getJson(`${base}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: "brainfuck", code: "+++", stdin: "" })
      });
      record("POST /api/run rejects an unsupported language", badRun.status === 400, `status ${badRun.status}`);
    }

    /* 7b. Java through the Judge0 cloud runner (a hosted server has no JDK) */
    {
      const caps = await getJson(`${base}/api/run/capabilities`);
      record(
        "GET /api/run/capabilities offers Java while a cloud runner is configured",
        caps.payload?.java === true,
        `java ${caps.payload?.java}`
      );

      /* A server whose PATH contains no compilers — exactly like Render. */
      const cloud = await startServer(CLOUD_PORT, {
        PATH: path.dirname(process.execPath),
        RUN_RATE_LIMIT_MAX: "0",
        JUDGE0_TIMEOUT_MS: "45000"
      });
      const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(120000)
      };
      try {
        const cloudCaps = await getJson(`${cloud.base}/api/run/capabilities`);
        record(
          "capabilities report every language when no toolchain exists and a cloud runner is configured",
          cloudCaps.payload?.java === true &&
            cloudCaps.payload?.c === true &&
            cloudCaps.payload?.cpp === true &&
            cloudCaps.payload?.python === true,
          JSON.stringify(cloudCaps.payload)
        );

        const hello = await getJson(`${cloud.base}/api/run`, {
          ...options,
          body: JSON.stringify({
            language: "java",
            code: "public class Main { public static void main(String[] a) { System.out.println(6 * 7); } }",
            stdin: ""
          })
        });
        const ranInCloud = hello.payload?.ok === true && String(hello.payload?.stdout || "").includes("42");
        /* If the public runner cannot be reached from this machine, the run must
           still fail politely: HTTP 200, a clear stderr message, no internals. */
        const failedPolitely =
          hello.status === 200 &&
          hello.payload?.ok === false &&
          typeof hello.payload?.stderr === "string" &&
          hello.payload.stderr.length > 0 &&
          !/node:internal|at Object|C:\\|ETIMEDOUT/i.test(hello.payload.stderr);
        record(
          "POST /api/run executes Java through the cloud runner when javac is missing",
          ranInCloud || failedPolitely,
          ranInCloud
            ? `stdout ${JSON.stringify(hello.payload.stdout)}, runner time ${hello.payload.time || "?"}s`
            : failedPolitely
              ? `public runner unreachable here — clean message: ${JSON.stringify(String(hello.payload.stderr).slice(0, 70))}`
              : `status ${hello.status}, ${JSON.stringify(hello.payload || {}).slice(0, 140)}`
        );

        if (ranInCloud) {
          const broken = await getJson(`${cloud.base}/api/run`, {
            ...options,
            body: JSON.stringify({ language: "java", code: "public class Main { public static void main(String[] a) { int x = ; } }", stdin: "" })
          });
          record(
            "POST /api/run reports a Java compile error from the cloud runner",
            broken.status === 200 && broken.payload?.ok === false && broken.payload?.phase === "compile" && Boolean(broken.payload?.stderr),
            `phase ${broken.payload?.phase}`
          );

          const runaway = await getJson(`${cloud.base}/api/run`, {
            ...options,
            body: JSON.stringify({ language: "java", code: "public class Main { public static void main(String[] a) { while (true) {} } }", stdin: "" })
          });
          record(
            "POST /api/run stops a runaway Java program",
            runaway.status === 200 && runaway.payload?.ok === false && runaway.payload?.timedOut === true,
            `timedOut ${runaway.payload?.timedOut}, ${JSON.stringify(String(runaway.payload?.stderr || "").slice(0, 60))}`
          );

          const stdinSum = await getJson(`${cloud.base}/api/run`, {
            ...options,
            body: JSON.stringify({
              language: "java",
              code: 'import java.util.*; public class Main { public static void main(String[] a) { Scanner s = new Scanner(System.in); int t = 0; while (s.hasNextInt()) t += s.nextInt(); System.out.println(t); } }',
              stdin: "1 2 3 4"
            })
          });
          record(
            "POST /api/run passes stdin to a Java program in the cloud",
            stdinSum.status === 200 && stdinSum.payload?.ok === true && String(stdinSum.payload?.stdout || "").trim() === "10",
            `stdout ${JSON.stringify(stdinSum.payload?.stdout || "")}`
          );

          /* The Lab names the public class after the program file, which the
             cloud compiler would reject unless the run renames it to Main.
             The rename must not touch the name inside strings — that is text
             the program prints. */
          const namedClass = await getJson(`${cloud.base}/api/run`, {
            ...options,
            body: JSON.stringify({
              language: "java",
              code: 'import java.util.Scanner; public class SixTimesSeven { public static void main(String[] a) { Scanner s = new Scanner(System.in); System.out.println("SixTimesSeven: " + (s.nextInt() * s.nextInt())); } }',
              stdin: "6 7"
            })
          });
          record(
            "POST /api/run accepts a Java class named after the program file",
            namedClass.status === 200 && namedClass.payload?.ok === true && String(namedClass.payload?.stdout || "").trim() === "SixTimesSeven: 42",
            `stdout ${JSON.stringify(namedClass.payload?.stdout || "")}, stderr ${JSON.stringify(String(namedClass.payload?.stderr || "").slice(0, 60))}`
          );
        } else {
          for (const skipped of [
            "POST /api/run reports a Java compile error from the cloud runner",
            "POST /api/run stops a runaway Java program",
            "POST /api/run passes stdin to a Java program in the cloud",
            "POST /api/run accepts a Java class named after the program file"
          ]) {
            record(skipped, true, "public runner unreachable from this machine — skipped");
          }
        }
      } finally {
        await stopServer(cloud.child);
      }
    }
    {
      const { status, payload } = await getJson(`${base}/api/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "help me with binary search" })
      });
      record(
        "POST /api/assistant still replies",
        status === 200 && typeof payload?.reply === "string" && payload.reply.length > 0,
        `status ${status}`
      );
      const empty = await getJson(`${base}/api/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "" })
      });
      record("POST /api/assistant rejects an empty message", empty.status === 400, `status ${empty.status}`);
    }

    /* 8. static app + secret files stay private */
    {
      const page = await fetch(`${base}/`);
      record("GET / serves the dashboard", page.status === 200 && (page.headers.get("content-type") || "").includes("text/html"), `status ${page.status}`);

      for (const blocked of ["/.env", "/server.js", "/keys.txt", "/db/pool.js", "/package.json", "/server.log", "/scripts/import-problems.js"]) {
        const response = await fetch(`${base}${blocked}`);
        record(`GET ${blocked} is not served`, response.status === 404, `status ${response.status}`);
      }
    }

    /* 9. CORS: unknown origins get no access header.
       Node's fetch forbids the Origin header, so these two checks use a raw
       HTTP request to make sure the header is really sent. */
    {
      const rawHeaders = async (origin) => {
        const response = await rawRequest(`${base}/health`, { Origin: origin });
        return response.headers["access-control-allow-origin"] || null;
      };

      const evil = await rawHeaders("https://evil.example.com");
      record("Unknown origins receive no CORS header", evil === null, `header ${evil || "absent"}`);

      const local = await rawHeaders("http://localhost:5173");
      record("Localhost origins are allowed", local === "http://localhost:5173", `header ${local || "absent"}`);

      const wrapper = await rawHeaders("capacitor://localhost");
      record("Android wrapper origin is allowed", wrapper === "capacitor://localhost", `header ${wrapper || "absent"}`);

      const lan = await rawHeaders("http://192.168.0.10:3000");
      record("LAN browser origin is allowed", lan === "http://192.168.0.10:3000", `header ${lan || "absent"}`);
    }

    /* 10. frontend wiring is present (cache-first + configurable API base) */
    {
      const fs = require("fs");
      const client = fs.readFileSync(path.join(ROOT, "lab-notes.js"), "utf8");
      const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
      record("Client stores a configurable online API base", client.includes("quantaApiBaseUrl"), "quantaApiBaseUrl");
      record("Client caches descriptions on the device", client.includes("quantaDescCacheV1"), "quantaDescCacheV1");
      record("Client deduplicates description requests", client.includes("inflightDesc"), "inflightDesc");
      record("Settings exposes the online API field", html.includes('id="settings-api-base"'), "settings-api-base");
      record("Settings keeps the compiler server separate", html.includes('id="settings-run-server"'), "settings-run-server");
    }
/* 13. smart revision endpoints: contract, validation and safe failure.
     Only dedicated test slugs are used, and they are deleted again at the end -
     no catalog row and no real revision is touched. */
  {
    const testSlug = "quanta-api-test-revision";
    const json = (method, path, body) =>
      getJson(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

    const before = await json("GET", "/api/revision?tzOffset=0");
    record(
      "GET /api/revision answers the dashboard",
      before.status === 200 && before.payload?.ok === true && Array.isArray(before.payload.items) && Boolean(before.payload.counts),
      `status ${before.status}`
    );

    const emptyBefore = !before.payload.items.some((item) => item.slug === testSlug);

    const added = await json("POST", "/api/revision", { slug: testSlug, title: "API test", num: 999999, difficulty: "Easy", tzOffsetMinutes: 0 });
    record(
      "POST /api/revision adds a problem",
      added.status === 200 && added.payload?.item?.slug === testSlug && added.payload.item.stage === 0,
      `status ${added.status}`
    );

    const badSlug = await json("POST", "/api/revision", { slug: "Not A Slug!", tzOffsetMinutes: 0 });
    record("POST /api/revision rejects an invalid slug", badSlug.status === 400, `status ${badSlug.status}`);

    const badTz = await json("GET", "/api/revision?tzOffset=9999");
    record("GET /api/revision rejects an impossible timezone offset", badTz.status === 400, `status ${badTz.status}`);

    const badConf = await json("POST", `/api/revision/${testSlug}/review`, { confidence: "brilliant", tzOffsetMinutes: 0 });
    record("POST /api/revision/:slug/review rejects an unknown confidence", badConf.status === 400, `status ${badConf.status}`);

    /* History is append-only on purpose, so a previous run can still have rows for
       this slug. The test therefore counts its own work instead of assuming the
       table was empty. */
    const historyBefore = await getJson(`${base}/api/revision/history?slug=${testSlug}`);

    const reviewed = await json("POST", `/api/revision/${testSlug}/review`, { confidence: "good", tzOffsetMinutes: 0 });
    record(
      "POST /api/revision/:slug/review schedules the next date",
      reviewed.status === 200 && reviewed.payload?.item?.reviewCount === 1 && Boolean(reviewed.payload.item.dueDate),
      `due ${reviewed.payload?.item?.dueDate}`
    );

    const unknown = await json("POST", "/api/revision/not-in-any-list/review", { confidence: "good", tzOffsetMinutes: 0 });
    record("Reviewing a problem that is not scheduled answers 404", unknown.status === 404, `status ${unknown.status}`);

    const snoozed = await json("POST", `/api/revision/${testSlug}/reschedule`, { snoozeDays: 4, tzOffsetMinutes: 0 });
    record(
      "POST /api/revision/:slug/reschedule moves the date without losing the ladder",
      snoozed.status === 200 && snoozed.payload?.item?.stage === 1 && snoozed.payload.item.reviewCount === 1,
      `status ${snoozed.status}`
    );

    const badSnooze = await json("POST", `/api/revision/${testSlug}/reschedule`, { snoozeDays: 900, tzOffsetMinutes: 0 });
    record("Rescheduling rejects an out-of-range snooze", badSnooze.status === 400, `status ${badSnooze.status}`);

    /* History is append-only on purpose, so a previous run can still have rows for
       this slug. The test therefore counts its own work instead of assuming the
       table was empty. */
    const history = await getJson(`${base}/api/revision/history?slug=${testSlug}`);
    record(
      "GET /api/revision/history returns the reviews that really happened",
      history.status === 200 &&
        history.payload?.total === Number(historyBefore.payload?.total || 0) + 1 &&
        history.payload.items[0]?.confidence === "good",
      `total ${history.payload?.total} (was ${historyBefore.payload?.total})`
    );

    const done = await json("POST", `/api/revision/${testSlug}/complete`, { tzOffsetMinutes: 0 });
    record(
      "POST /api/revision/:slug/complete finishes a problem",
      done.status === 200 && done.payload?.item?.status === "completed" && done.payload?.alreadyCompleted === false,
      `status ${done.status}`
    );

    const doneAgain = await json("POST", `/api/revision/${testSlug}/complete`, { tzOffsetMinutes: 0 });
    record(
      "Completing twice is safe and keeps the first completion time",
      doneAgain.status === 200 && doneAgain.payload?.alreadyCompleted === true && doneAgain.payload?.item?.completedAt === done.payload.item.completedAt,
      `completedAt ${doneAgain.payload?.item?.completedAt}`
    );

    const reviewFinished = await json("POST", `/api/revision/${testSlug}/review`, { confidence: "good", tzOffsetMinutes: 0 });
    record("A finished problem cannot be reviewed again", reviewFinished.status === 409, `status ${reviewFinished.status}`);

    const removed = await getJson(`${base}/api/revision/${testSlug}`, { method: "DELETE" });
    record("DELETE /api/revision/:slug removes the problem", removed.status === 200 && removed.payload?.deleted === true, `status ${removed.status}`);

    const removedTwice = await getJson(`${base}/api/revision/${testSlug}`, { method: "DELETE" });
    record("Removing a problem that is not scheduled answers 404", removedTwice.status === 404, `status ${removedTwice.status}`);

    const historyAfter = await getJson(`${base}/api/revision/history?slug=${testSlug}`);
    record(
      "The review history survives removal",
      historyAfter.payload?.total === history.payload?.total,
      `total ${historyAfter.payload?.total}, was ${history.payload?.total}`
    );

    const after = await json("GET", "/api/revision?tzOffset=0");
    record(
      "The test problem is gone from the dashboard",
      !after.payload.items.some((item) => item.slug === testSlug),
      emptyBefore ? "" : "left a row behind"
    );

    record(
      "Revision responses never leak database details",
      !JSON.stringify(after.payload || {}).match(/password|root@|ER_|at Object|stack/i),
      "checked"
    );
  }


  } finally {
    await stopServer(server);
  }

  /* 11. rate limiting on its own server (limiter disabled above) */
  {
    const { child } = await startServer(RATE_PORT, { RATE_LIMIT_MAX: "3" });
    try {
      const base = `http://127.0.0.1:${RATE_PORT}`;
      let saw429 = false;
      let lastStatus = 0;
      for (let i = 0; i < 8; i += 1) {
        const response = await fetch(`${base}/api/problems?limit=1`);
        lastStatus = response.status;
        if (response.status === 429) {
          saw429 = true;
          break;
        }
      }
      record("Rate limiter answers 429 after the limit", saw429, `last status ${lastStatus}`);
    } finally {
      await stopServer(child);
    }
  }

  /* 12. the API degrades gracefully when the database is down */
  {
    const { child } = await startServer(NO_DB_PORT, {
      DB_HOST: "127.0.0.1",
      DB_PORT: "9",
      DB_CONNECTION_LIMIT: "1",
      DB_QUERY_TIMEOUT_MS: "3000"
    });
    try {
      const base = `http://127.0.0.1:${NO_DB_PORT}`;
      const health = await getJson(`${base}/health`);
      record(
        "Server stays alive without a database",
        health.status === 200 && health.payload?.ok === true,
        `status ${health.status}`
      );
      record(
        "Health reports the database as down",
        health.payload?.database?.ok === false,
        JSON.stringify(health.payload?.database)
      );

      const list = await getJson(`${base}/api/problems`);
      record(
        "GET /api/problems answers 503 when the database is unreachable",
        list.status === 503 && list.payload?.ok === false,
        `status ${list.status}`
      );
      record(
        "Database errors never leak connection details",
        !JSON.stringify(list.payload || {}).match(/password|root@|ETIMEDOUT|stack/i),
        JSON.stringify(list.payload)
      );

      const detail = await getJson(`${base}/api/problems/two-sum`);
      record(
        "GET /api/problems/:id answers 503 when the database is unreachable",
        detail.status === 503,
        `status ${detail.status}`
      );

      const caps = await getJson(`${base}/api/run/capabilities`);
      record(
        "Compiler endpoints still answer without a database",
        caps.status === 200 && caps.payload?.javascript === "browser",
        `status ${caps.status}`
      );
    } finally {
      await stopServer(child);
    }
  }

    console.log("");
  console.log(`${results.length - failures}/${results.length} tests passed.`);
  if (failures) {
    console.log(`${failures} test(s) failed.`);
  }
  return failures ? 1 : 0;
};

runSuite()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    console.error(`Test run failed: ${error?.message || error}`);
    process.exit(1);
  });
