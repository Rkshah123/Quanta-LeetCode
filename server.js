const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const express = require("express");
const dotenv = require("dotenv");

dotenv.config({ quiet: true });

const database = require("./db/pool");
const problemsRepo = require("./db/problems");

const app = express();

/* Port resolution: a valid OS environment PORT wins (hosts such as Render or
   Railway inject one and the app must use it), then the PORT in .env, then
   3000. dotenv does not override variables that already exist in the OS
   environment, and the explicit .env read covers the case where it was never
   loaded. Invalid values (0 / non-numeric / out of range) are rejected, so a
   stray PORT=0 can never bind to a random OS-assigned port. */
const parsePortValue = (value) => {
  const n = Number(String(value ?? "").trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};
let envFilePort = null;
try {
  envFilePort = parsePortValue(dotenv.parse(fs.readFileSync(path.join(__dirname, ".env"))).PORT);
} catch {}
const port = parsePortValue(process.env.PORT) ?? envFilePort ?? 3000;
const maxAssistantMessageLength = Number(process.env.MAX_ASSISTANT_MESSAGE_LENGTH || 1200);

const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 20000);
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 5000);
const MAX_CODE_LENGTH = Number(process.env.MAX_CODE_LENGTH || 100000);
const MAX_STDIN_LENGTH = Number(process.env.MAX_STDIN_LENGTH || 20000);
const MAX_OUTPUT_BYTES = 200 * 1024;

/* --------------------------- cloud run fallback -------------------------- */
/* Some hosts (a free container) have no JDK. When a language cannot be
   compiled locally, the run is submitted to a Judge0 instance instead. The
   free public instance https://ce.judge0.com needs no key; set JUDGE0_URL=""
   to switch this off, or point it at your own/private instance. An optional
   JUDGE0_TOKEN is sent as a Bearer header and never leaves the server. */
const JUDGE0_URL = String(process.env.JUDGE0_URL ?? "https://ce.judge0.com").trim().replace(/\/+$/, "");
const JUDGE0_TOKEN = String(process.env.JUDGE0_TOKEN || "").trim();
const JUDGE0_TIMEOUT_MS = Number(process.env.JUDGE0_TIMEOUT_MS || 60000);
/* Judge0 language ids for exactly the languages Quanta supports. */
const JUDGE0_LANGUAGE_IDS = Object.freeze({ c: 103, cpp: 105, java: 91, python: 100 });

/* ------------------------------ assistant ------------------------------ */

const getAssistantFallback = (message) => {
  const normalized = String(message || "").toLowerCase();
  if (normalized.includes("binary search")) {
    return "Binary search works on sorted data by halving the search range each step. Track low, high, and mid carefully.";
  }
  if (normalized.includes("array")) {
    return "For array problems, start with constraints, then consider two pointers, prefix sums, hashing, sorting, or binary search.";
  }
  if (normalized.includes("string")) {
    return "String problems often become easier with frequency maps, sliding windows, two pointers, or careful character indexing.";
  }
  if (normalized.includes("dp") || normalized.includes("dynamic programming")) {
    return "Dynamic programming needs a state, transition, base case, and iteration order. Write those before coding.";
  }
  if (normalized.includes("graph")) {
    return "Graph problems usually start with representation, visited state, and choosing BFS, DFS, Dijkstra, or topological sort.";
  }
  return "Break the problem into inputs, constraints, pattern, edge cases, and then code the smallest correct solution first.";
};

/* --------------------------- code run support -------------------------- */

const RUN_LANGUAGES = new Set(["c", "cpp", "java", "python"]);

const toolAvailability = new Map();

const checkTool = (command, args = ["--version"]) => {
  if (!toolAvailability.has(command)) {
    toolAvailability.set(
      command,
      new Promise((resolve) => {
        let child;
        try {
          child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
        } catch {
          resolve(false);
          return;
        }

        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // no-op
          }
          resolve(false);
        }, 4000);

        child.on("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
      })
    );
  }
  return toolAvailability.get(command);
};

const resolvePythonCommand = async () => {
  if (await checkTool("python3", ["--version"])) return "python3";
  if (await checkTool("python", ["--version"])) return "python";
  return "";
};

const getRunCapabilities = async () => ({
  c: Boolean(await checkTool("gcc")) || judge0Configured("c"),
  cpp: Boolean(await checkTool("g++")) || judge0Configured("cpp"),
  java:
    (Boolean(await checkTool("javac")) && Boolean(await checkTool("java", ["-version"]))) ||
    judge0Configured("java"),
  python: Boolean(await resolvePythonCommand()) || judge0Configured("python")
});

const truncate = (text) => {
  const value = String(text || "");
  if (value.length <= MAX_OUTPUT_BYTES) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, MAX_OUTPUT_BYTES)}\n...[output truncated]`,
    truncated: true
  };
};

/* Is a cloud runner available for this language on this server? */
const judge0Configured = (language) => Boolean(JUDGE0_URL && JUDGE0_LANGUAGE_IDS[language]);

const JUDGE0_STATUS = Object.freeze({ QUEUED: 1, PROCESSING: 2, ACCEPTED: 3, TIME_LIMIT: 5, COMPILE_ERROR: 6 });

const judge0Headers = () => {
  const headers = { "Content-Type": "application/json" };
  if (JUDGE0_TOKEN) headers.Authorization = `Bearer ${JUDGE0_TOKEN}`;
  return headers;
};

/* Turns an HTTP status from the runner into a message a student can act on. */
const judge0HttpError = (status) => {
  if (status === 429) return "The free Judge0 instance is rate-limiting requests. Wait a few seconds and run again.";
  if (status === 401 || status === 403) return "The Judge0 instance refused this request (a key is required, or access was denied).";
  if (status >= 500) return "The Judge0 instance is having server trouble. Please try again shortly.";
  return `The Judge0 instance answered HTTP ${status}.`;
};

/* Submits the code to Judge0 and maps the answer onto Quanta's normal run
   shape, so the editor shows it exactly like a local run. The submission is
   queued (wait=false) and its token is polled until it finishes, the
   JUDGE0_TIMEOUT_MS budget runs out, or the runner answers with an error.
   Never leaks the token; every failure becomes a plain message, never a stack. */
const runOnJudge0 = async (language, code, stdin) => {
  if (!judge0Configured(language)) {
    return { ok: false, phase: "setup", stderr: "No local compiler for this language and no cloud runner configured." };
  }
  const deadline = Date.now() + JUDGE0_TIMEOUT_MS;
  const pollFields = "stdout,stderr,compile_output,message,status,time,memory,token";

  try {
    /* 1. Queue the submission and collect its token. */
    const submit = await fetch(`${JUDGE0_URL}/submissions?base64_encoded=false&wait=false`, {
      method: "POST",
      headers: judge0Headers(),
      body: JSON.stringify({
        source_code: language === "java" ? javaSourceForCloud(code) : code,
        language_id: JUDGE0_LANGUAGE_IDS[language],
        stdin: stdin || ""
      }),
      signal: AbortSignal.timeout(Math.min(JUDGE0_TIMEOUT_MS, 20000))
    });
    if (!submit.ok) return { ok: false, phase: "run", stderr: judge0HttpError(submit.status) };
    const queued = await submit.json();
    const token = typeof queued?.token === "string" ? queued.token : "";
    if (!token) return { ok: false, phase: "run", stderr: "The Judge0 instance did not return a submission token." };

    /* 2. Poll the token until the run leaves the queue. */
    let result = null;
    for (;;) {
      const poll = await fetch(
        `${JUDGE0_URL}/submissions/${encodeURIComponent(token)}?base64_encoded=false&fields=${pollFields}`,
        { headers: judge0Headers(), signal: AbortSignal.timeout(15000) }
      );
      if (!poll.ok) return { ok: false, phase: "run", stderr: judge0HttpError(poll.status) };
      result = await poll.json();
      const statusId = result?.status?.id;
      if (statusId !== JUDGE0_STATUS.QUEUED && statusId !== JUDGE0_STATUS.PROCESSING) break;
      if (Date.now() >= deadline) {
        return {
          ok: false,
          phase: "run",
          stderr: `The cloud run did not finish within ${Math.round(JUDGE0_TIMEOUT_MS / 1000)} seconds.`,
          timedOut: true
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    /* 3. Map the finished result onto the local-run shape. */
    const statusId = result?.status?.id;
    const description = result?.status?.description || "run failed";
    const out = truncate(result?.stdout || "");
    const err = truncate(
      [result?.stderr, result?.compile_output, statusId === JUDGE0_STATUS.COMPILE_ERROR ? result?.message : ""]
        .filter(Boolean)
        .join("\n")
    );
    const accepted = statusId === JUDGE0_STATUS.ACCEPTED;
    return {
      ok: accepted,
      phase: statusId === JUDGE0_STATUS.COMPILE_ERROR ? "compile" : "run",
      stdout: out.text,
      stderr: err.text || (accepted ? "" : `Cloud runner: ${description}.`),
      exitCode: accepted ? 0 : 1,
      truncated: out.truncated || err.truncated,
      timedOut: statusId === JUDGE0_STATUS.TIME_LIMIT,
      time: result?.time,
      memory: result?.memory
    };
  } catch (error) {
    return { ok: false, phase: "run", stderr: `Cloud runner unavailable: ${error?.message || "request failed"}.` };
  }
};

const runProcess = (command, args, options = {}) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        windowsHide: true,
        env: { ...process.env }
      });
    } catch (error) {
      resolve({ stdout: "", stderr: `Could not start ${command}: ${error.message}`, exitCode: 1, timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // no-op
      }
    }, options.timeoutMs || RUN_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES * 2) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES * 2) stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${error.message}`.trim(), exitCode: 1, timedOut: false });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut: killed });
    });

    if (options.stdin) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
  });

const extractJavaPublicClassName = (code) => {
  const match = String(code || "").match(/\bpublic\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
  return match && match[1] ? match[1] : "Main";
};

/* Judge0 compiles the submission as Main.java, so a program whose public
   class carries another name (the Lab names it after the program file) would
   not compile there even though it compiles locally. For the cloud run only,
   that class — and everything referring to it — is renamed to Main. */
const javaSourceForCloud = (code) => {
  const source = String(code || "");
  const className = extractJavaPublicClassName(source);
  if (!className || className === "Main") return source;
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(new RegExp(`\\b${escaped}\\b`, "g"), "Main");
};

const executeRun = async (language, code, stdin) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "leetcode-lab-"));

  try {
    if (language === "c" || language === "cpp") {
      const isCpp = language === "cpp";
      const compiler = isCpp ? "g++" : "gcc";
      const sourceName = isCpp ? "main.cpp" : "main.c";

      /* No local compiler (common on a hosted container) → run in the cloud. */
      if (!(await checkTool(compiler))) return runOnJudge0(language, code, stdin);

      const outputName = process.platform === "win32" ? "prog.exe" : "prog";
      const sourcePath = path.join(workDir, sourceName);
      const outputPath = path.join(workDir, outputName);

      fs.writeFileSync(sourcePath, code, "utf8");

      const stdFlag = isCpp ? "-std=c++17" : "-std=c17";
      const compile = await runProcess(compiler, ["-O2", stdFlag, "-o", outputPath, sourcePath], {
        cwd: workDir,
        timeoutMs: COMPILE_TIMEOUT_MS
      });

      if (compile.exitCode !== 0) {
        const err = truncate(compile.stderr || compile.stdout || "Compilation failed.");
        return { ok: false, phase: "compile", stderr: err.text, truncated: err.truncated, timedOut: compile.timedOut };
      }

      const result = await runProcess(outputPath, [], { cwd: workDir, timeoutMs: RUN_TIMEOUT_MS, stdin });
      const out = truncate(result.stdout);
      const err = truncate(result.stderr);
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        phase: "run",
        stdout: out.text,
        stderr: err.text,
        exitCode: result.exitCode,
        truncated: out.truncated || err.truncated,
        timedOut: result.timedOut
      };
    }

    if (language === "java") {
      /* A hosted server usually has no JDK — Judge0 compiles it instead. */
      if (!(await checkTool("javac"))) return runOnJudge0(language, code, stdin);

      const className = extractJavaPublicClassName(code);
      const sourcePath = path.join(workDir, `${className}.java`);
      fs.writeFileSync(sourcePath, code, "utf8");

      const compile = await runProcess("javac", [sourcePath], { cwd: workDir, timeoutMs: COMPILE_TIMEOUT_MS });
      if (compile.exitCode !== 0) {
        const err = truncate(compile.stderr || compile.stdout || "Compilation failed.");
        return { ok: false, phase: "compile", stderr: err.text, truncated: err.truncated, timedOut: compile.timedOut };
      }

      const result = await runProcess("java", ["-cp", workDir, className], { cwd: workDir, timeoutMs: RUN_TIMEOUT_MS, stdin });
      const out = truncate(result.stdout);
      const err = truncate(result.stderr);
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        phase: "run",
        stdout: out.text,
        stderr: err.text,
        exitCode: result.exitCode,
        truncated: out.truncated || err.truncated,
        timedOut: result.timedOut
      };
    }

    if (language === "python") {
      const pythonCommand = await resolvePythonCommand();
      if (!pythonCommand) return runOnJudge0(language, code, stdin);

      const sourcePath = path.join(workDir, "main.py");
      fs.writeFileSync(sourcePath, code, "utf8");

      const result = await runProcess(pythonCommand, [sourcePath], { cwd: workDir, timeoutMs: RUN_TIMEOUT_MS, stdin });
      const out = truncate(result.stdout);
      const err = truncate(result.stderr);
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        phase: "run",
        stdout: out.text,
        stderr: err.text,
        exitCode: result.exitCode,
        truncated: out.truncated || err.truncated,
        timedOut: result.timedOut
      };
    }

    return { ok: false, phase: "setup", stderr: "Unsupported language." };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // no-op
    }
  }
};

/* ------------------------------- express ------------------------------- */

app.disable("x-powered-by");

/* Render (and most PaaS hosts) terminate TLS in front of the app. Without
   trusting that hop, req.ip is the proxy's address for every visitor — so all
   clients would share one rate-limit bucket and 429 each other — and
   req.protocol would wrongly report http. Only enabled when the platform
   (RENDER=true) or an explicit TRUST_PROXY value says a proxy exists. */
const trustProxySetting = String(process.env.TRUST_PROXY ?? (process.env.RENDER ? "1" : "")).trim();
if (trustProxySetting) {
  const asNumber = Number(trustProxySetting);
  app.set(
    "trust proxy",
    Number.isInteger(asNumber) ? asNumber : trustProxySetting === "true" ? true : trustProxySetting
  );
}

app.use(express.json({ limit: "256kb" }));

/* -------------------------------- CORS -------------------------------- */
/* Same-origin calls need no CORS headers. Anything else must be an origin we
   actually recognise: the Android wrapper (capacitor://localhost /
   https://localhost), localhost, a browser on the same private LAN, or an
   extra origin listed in CORS_ORIGINS (comma separated). Unknown origins get
   no CORS header, so the browser blocks them. */
const extraOrigins = new Set(
  String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean)
);

const isPrivateIpv4 = (host) => {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
};

const isAllowedOrigin = (req, origin) => {
  if (!origin) return true;
  const normalized = origin.replace(/\/+$/, "");
  if (extraOrigins.has(normalized)) return true;
  if (normalized === `${req.protocol}://${req.get("host") || ""}`) return true;
  try {
    const url = new URL(normalized);
    if (url.protocol === "capacitor:" || url.protocol === "ionic:" || url.protocol === "file:") return true;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if ((url.protocol === "http:" || url.protocol === "https:") && isPrivateIpv4(host)) return true;
    return false;
  } catch {
    return false;
  }
};

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  /* Only meaningful over TLS (LAN http:// use is unaffected). */
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");

  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(req, origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

/* --------------------------- static file guard ------------------------- */
/* express.static serves the whole project folder, so source files, secrets
   and build artifacts are refused up front (they must never be downloadable). */
const BLOCKED_DIRS = [
  "/node_modules/",
  "/db/",
  "/scripts/",
  "/backend/",
  "/android-apk/",
  "/.git/",
  "/.freebuff/"
];

const isBlockedPath = (rawPath) => {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  const normalized = `/${String(decoded).replace(/^\/+/, "").toLowerCase()}`;
  if (normalized === "/keys.txt") return true;
  if (normalized.startsWith("/.env")) return true;
  if (/\.(log|sql|keystore|idsig)$/.test(normalized)) return true;
  if (normalized === "/server.js" || normalized === "/package.json" || normalized === "/package-lock.json") {
    return true;
  }
  return BLOCKED_DIRS.some((dir) => normalized === dir || normalized.startsWith(dir));
};

app.use((req, res, next) => {
  if ((req.method === "GET" || req.method === "HEAD") && isBlockedPath(req.path)) {
    res.status(404).end();
    return;
  }
  next();
});

app.get("/keys.txt", (_req, res) => {
  res.status(404).end();
});

app.use(express.static(__dirname, { extensions: ["html"], dotfiles: "ignore" }));

/* ------------------------------ rate limit ----------------------------- */
/* Fixed-window limiter for the public JSON API (in-memory, no dependency).
   Set RATE_LIMIT_MAX=0 to disable. */
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 300);
const rateBuckets = new Map();

const createRateLimit = (maxPerWindow) => (req, res, next) => {
  if (!Number.isFinite(maxPerWindow) || maxPerWindow <= 0) {
    next();
    return;
  }
  const now = Date.now();
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 5000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }
  if (bucket.count > maxPerWindow) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    res.status(429).json({ ok: false, error: "Too many requests. Please wait a moment and try again." });
    return;
  }
  next();
};

const rateLimit = createRateLimit(RATE_LIMIT_MAX);

/* Compiling and running code costs far more than serving JSON, so it gets its
   own tighter per-IP budget (RUN_RATE_LIMIT_MAX, 0 disables). */
const runRateLimit = createRateLimit(Number(process.env.RUN_RATE_LIMIT_MAX || 30));

/* One shared CPU cannot absorb many parallel compilations, so only this many
   runs execute at once; the rest are told to retry instead of queueing up
   processes until the instance times out. */
const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_RUNS || 4);
let activeRuns = 0;

/* ---------------------------- shared helpers --------------------------- */

/* One shape for every database failure: log the detail server-side, answer
   the client with a generic message (never credentials, never a stack). */
const respondDatabaseError = (res, error) => {
  const message = error?.message || String(error);
  if (!database.isConfigured()) {
    res.status(503).json({ ok: false, error: "Database is not configured on this server." });
    return;
  }
  console.error(`[db] ${message}`);
  res.status(503).json({ ok: false, error: "Database unavailable. Please try again shortly." });
};

app.get("/health", async (_req, res) => {
  const databaseStatus = await database.checkDatabase();
  /* Driver messages can name the database host and user (e.g. "Access denied
     for user ..."), so the detail is logged here and the client only ever
     sees a generic flag — the same rule the catalog endpoints follow. */
  if (databaseStatus.error) console.error(`[health] database: ${databaseStatus.error}`);
  const publicStatus = databaseStatus.error
    ? { configured: databaseStatus.configured, ok: false, error: "Connection failed." }
    : databaseStatus;
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    database: publicStatus
  });
});

/* ---------------------- LeetCode problem lookup ----------------------- */

/* Resolves the real LeetCode number, title, and difficulty for a problem
   slug so freshly added problems sort by their actual LeetCode number. */

const LC_LOOKUP_TIMEOUT_MS = 8000;
const lcLookupCache = new Map();

app.get("/api/lc-lookup", rateLimit, async (req, res) => {
  const slug = typeof req.query.slug === "string" ? req.query.slug.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ ok: false, error: "Invalid slug." });
    return;
  }
  if (lcLookupCache.has(slug)) {
    res.json({ ok: true, ...lcLookupCache.get(slug) });
    return;
  }
  try {
    const response = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://leetcode.com" },
      body: JSON.stringify({
        query: "query questionData($titleSlug: String!) { question(titleSlug: $titleSlug) { questionFrontendId title difficulty } }",
        variables: { titleSlug: slug }
      }),
      signal: AbortSignal.timeout(LC_LOOKUP_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`LeetCode responded with HTTP ${response.status}`);
    const payload = await response.json();
    const question = payload?.data?.question;
    if (!question || !question.questionFrontendId) throw new Error("Problem not found on LeetCode.");
    const info = {
      num: String(question.questionFrontendId),
      name: String(question.title || "").trim(),
      difficulty: ["Easy", "Medium", "Hard"].includes(question.difficulty) ? question.difficulty : "Medium"
    };
    lcLookupCache.set(slug, info);
    res.json({ ok: true, ...info });
  } catch (error) {
    res.json({ ok: false, error: error?.message || "Lookup failed." });
  }
});

/* Official LeetCode starter code. Returns the platform's real codeSnippets
   for every supported language so a freshly opened problem shows its actual
   function signature instead of a generic template. */
const lcSkeletonCache = new Map();

app.get("/api/lc-skeleton", rateLimit, async (req, res) => {
  const slug = typeof req.query.slug === "string" ? req.query.slug.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ ok: false, error: "Invalid slug." });
    return;
  }
  if (lcSkeletonCache.has(slug)) {
    res.json({ ok: true, ...lcSkeletonCache.get(slug) });
    return;
  }
  try {
    const response = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://leetcode.com" },
      body: JSON.stringify({
        query:
          "query questionEditorData($titleSlug: String!) { question(titleSlug: $titleSlug) { codeSnippets { lang langSlug code } } }",
        variables: { titleSlug: slug }
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`LeetCode responded with HTTP ${response.status}`);
    const payload = await response.json();
    const snippets = payload?.data?.question?.codeSnippets;
    if (!Array.isArray(snippets) || !snippets.length) throw new Error("No starter code available.");
    /* LeetCode langSlug -> Quanta language id. */
    const LANG_MAP = { javascript: "javascript", java: "java", python3: "python", python: "python", c: "c", cpp: "cpp" };
    const skeletons = {};
    snippets.forEach((snippet) => {
      const mapped = LANG_MAP[snippet?.langSlug];
      if (mapped && typeof snippet.code === "string") skeletons[mapped] = snippet.code;
    });
    if (!Object.keys(skeletons).length) throw new Error("No supported-language starter code available.");
    const result = { skeletons, fetchedAt: Date.now() };
    lcSkeletonCache.set(slug, result);
    res.json({ ok: true, skeletons });
  } catch (error) {
    res.json({ ok: false, error: error?.message || "Skeleton lookup failed." });
  }
});

/* Official problem description (statement, examples, constraints) as HTML,
   for the split problem-solving workspace.

   Order of sources: in-memory cache → Quanta's own MySQL catalog (works even
   when LeetCode is unreachable) → LeetCode live. Whatever arrives from
   LeetCode is written back into the catalog so the database fills itself with
   real problem statements instead of copies of them. */
const lcDescCache = new Map();

app.get("/api/lc-description", rateLimit, async (req, res) => {
  const slug = typeof req.query.slug === "string" ? req.query.slug.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ ok: false, error: "Invalid slug." });
    return;
  }
  if (lcDescCache.has(slug)) {
    res.json({ ok: true, ...lcDescCache.get(slug) });
    return;
  }

  try {
    const stored = await problemsRepo.findProblem({ slug });
    if (stored?.description_html) {
      const result = { html: stored.description_html, fetchedAt: Date.now(), source: "database" };
      lcDescCache.set(slug, result);
      res.json({ ok: true, ...result });
      return;
    }
  } catch {
    /* database unavailable — continue with the live lookup */
  }

  try {
    const response = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://leetcode.com" },
      body: JSON.stringify({
        query: "query questionContent($titleSlug: String!) { question(titleSlug: $titleSlug) { content } }",
        variables: { titleSlug: slug }
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`LeetCode responded with HTTP ${response.status}`);
    const payload = await response.json();
    const content = payload?.data?.question?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("No description available.");
    const result = { html: content, fetchedAt: Date.now(), source: "leetcode" };
    lcDescCache.set(slug, result);
    res.json({ ok: true, html: content, fetchedAt: result.fetchedAt, source: result.source });

    /* Fire-and-forget: store the statement in MySQL for next time. */
    problemsRepo
      .importDescription(slug, content)
      .catch(() => {
        /* catalog write failed — the description still reached the client */
      });
  } catch (error) {
    res.json({ ok: false, error: error?.message || "Description lookup failed." });
  }
});

/* ------------------------- problem catalog API ------------------------- */
/* Read-only endpoints that both the desktop app and the Android app call.
   They never expose credentials, stack traces or connection details. */

app.get("/api/categories", rateLimit, async (_req, res) => {
  try {
    const categories = await problemsRepo.listCategories();
    res.json({
      ok: true,
      categories: categories.map((row) => ({ id: row.id, slug: row.slug, name: row.name }))
    });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

app.get("/api/problems", rateLimit, async (req, res) => {
  const { query: search, difficulty, category, limit, offset, num } = req.query;

  if (search !== undefined && (typeof search !== "string" || search.length > 100)) {
    res.status(400).json({ ok: false, error: "Invalid search query." });
    return;
  }
  const difficultyValue = difficulty === undefined ? "" : String(difficulty);
  if (difficultyValue && !["all", "Easy", "Medium", "Hard", "easy", "medium", "hard"].includes(difficultyValue)) {
    res.status(400).json({ ok: false, error: "Difficulty must be Easy, Medium, Hard or all." });
    return;
  }
  if (category !== undefined && (typeof category !== "string" || category.length > 60)) {
    res.status(400).json({ ok: false, error: "Invalid category." });
    return;
  }
  if (num !== undefined && !/^\d{1,7}$/.test(String(num))) {
    res.status(400).json({ ok: false, error: "Invalid problem number." });
    return;
  }
  if (limit !== undefined && (!/^\d{1,4}$/.test(String(limit)) || Number(limit) < 1)) {
    res.status(400).json({ ok: false, error: "Invalid limit." });
    return;
  }
  if (offset !== undefined && !/^\d{1,7}$/.test(String(offset))) {
    res.status(400).json({ ok: false, error: "Invalid offset." });
    return;
  }

  try {
    const page = await problemsRepo.listProblems({
      q: typeof search === "string" ? search : "",
      difficulty: difficultyValue,
      category: typeof category === "string" ? category : "",
      lcNum: num !== undefined ? Number(num) : null,
      limit,
      offset
    });
    res.json({ ok: true, ...page });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

/* One problem by its stable ID. `:id` accepts the database primary key
   (digits) or the LeetCode slug ("two-sum"), which is what the apps use. */
app.get("/api/problems/:id", rateLimit, async (req, res) => {
  const raw = String(req.params.id || "").trim();
  if (!raw || raw.length > 191) {
    res.status(400).json({ ok: false, error: "Invalid problem id." });
    return;
  }
  const isNumeric = /^\d+$/.test(raw);
  if (!isNumeric && !/^[a-z0-9][a-z0-9._-]*$/i.test(raw)) {
    res.status(400).json({ ok: false, error: "Invalid problem id." });
    return;
  }

  try {
    const problem = await problemsRepo.getProblemDetail(
      isNumeric ? { id: Number(raw) } : { slug: raw.toLowerCase() }
    );
    if (!problem) {
      res.status(404).json({ ok: false, error: "Problem not found." });
      return;
    }
    res.json({ ok: true, problem });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

app.get("/api/run/capabilities", runRateLimit, async (_req, res) => {
  const capabilities = await getRunCapabilities();
  res.json({ javascript: "browser", ...capabilities });
});

app.post("/api/run", runRateLimit, async (req, res) => {
  const language = typeof req.body?.language === "string" ? req.body.language.trim().toLowerCase() : "";
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const stdin = typeof req.body?.stdin === "string" ? req.body.stdin.slice(0, MAX_STDIN_LENGTH) : "";

  if (!RUN_LANGUAGES.has(language)) {
    res.status(400).json({ ok: false, error: "Unsupported language. JavaScript runs locally in the browser." });
    return;
  }
  if (!code.trim()) {
    res.status(400).json({ ok: false, error: "Code is empty." });
    return;
  }
  if (code.length > MAX_CODE_LENGTH) {
    res.status(413).json({ ok: false, error: "Code is too long." });
    return;
  }

  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    res.setHeader("Retry-After", "5");
    res.status(503).json({ ok: false, error: "All run slots are busy. Please try again in a moment." });
    return;
  }
  activeRuns += 1;
  try {
    const result = await executeRun(language, code, stdin);
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, phase: "server", stderr: error?.message || "Run failed." });
  } finally {
    activeRuns -= 1;
  }
});

app.post("/api/assistant", runRateLimit, (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";

  if (!message) {
    res.status(400).json({ error: "Message is required." });
    return;
  }

  if (message.length > maxAssistantMessageLength) {
    res.status(413).json({ error: "Message is too long." });
    return;
  }

  res.json({ reply: getAssistantFallback(message), source: "local-fallback" });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ ok: false, error: "Not found." });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    res.status(400).json({ error: "Invalid JSON body." });
    return;
  }
  if (error?.type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large." });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Internal server error." });
});

/* Listen on every interface by default so a phone on the same Wi-Fi can reach
   the server at the PC's LAN IP (set HOST to pin it to one interface). */
const host = process.env.HOST || "0.0.0.0";
const server = app.listen(port, host, () => {
  console.log(`Server running on http://localhost:${port} (listening on ${host})`);
  database
    .checkDatabase()
    .then((status) => {
      const name = database.describeConfig().database;
      if (status.configured) {
        console.log(
          status.ok
            ? `Database OK — ${name} (latency ${status.latencyMs}ms)`
            : `Database unreachable: ${status.error}`
        );
      } else {
        console.log("Database not configured — catalog API will answer 503.");
      }
    })
    .catch(() => {
      /* health probe failed — already reported through /health */
    });
});

server.on("error", (err) => {
  console.error(`Server failed to start on port ${port}: ${err.message}`);
  process.exit(1);
});

/* Close the MySQL pool before exiting so in-flight queries finish cleanly. */
let shuttingDown = false;
const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);
  server.close(() => {
    database
      .closePool()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
