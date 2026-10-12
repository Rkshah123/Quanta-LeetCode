const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const express = require("express");
const dotenv = require("dotenv");

dotenv.config({ quiet: true });

const database = require("./db/pool");
const problemsRepo = require("./db/problems");
const progressRepo = require("./db/progress");
const studyRepo = require("./db/study");
const revisionRepo = require("./db/revision");

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
   that class — and everything referring to it — is renamed to Main.

   The rename walks the source like a reader would: it skips string literals,
   character literals and comments, because a class name inside those is text
   the program prints, not code. */
const javaSourceForCloud = (code) => {
  const source = String(code || "");
  const className = extractJavaPublicClassName(source);
  if (!className || className === "Main") return source;

  let out = "";
  let index = 0;
  let mode = "code"; /* code | string | char | line | block */

  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1] || "";

    if (mode === "code") {
      if (ch === '"') {
        mode = "string";
        out += ch;
        index += 1;
      } else if (ch === "'") {
        mode = "char";
        out += ch;
        index += 1;
      } else if (ch === "/" && next === "/") {
        mode = "line";
        out += ch + next;
        index += 2;
      } else if (ch === "/" && next === "*") {
        mode = "block";
        out += ch + next;
        index += 2;
      } else if (/[A-Za-z_$]/.test(ch)) {
        let end = index;
        while (end < source.length && /[\w$]/.test(source[end])) end += 1;
        const word = source.slice(index, end);
        out += word === className ? "Main" : word;
        index = end;
      } else {
        out += ch;
        index += 1;
      }
      continue;
    }

    if (mode === "string" || mode === "char") {
      const closing = mode === "string" ? '"' : "'";
      out += ch;
      index += 1;
      if (ch === "\\" && index < source.length) {
        out += source[index];
        index += 1;
      } else if (ch === closing) {
        mode = "code";
      }
      continue;
    }

    if (mode === "line") {
      out += ch;
      index += 1;
      if (ch === "\n") mode = "code";
      continue;
    }

    /* block comment */
    out += ch;
    index += 1;
    if (ch === "*" && next === "/") {
      out += next;
      index += 1;
      mode = "code";
    }
  }

  return out;
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
  const {
    query: search,
    difficulty,
    category,
    limit,
    offset,
    num,
    sort,
    solved,
    revision,
    statement,
    inStatement,
    today,
    platform,
    topic,
    company
  } = req.query;

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

  /* New filter and sort parameters. An unknown value is refused rather than
     quietly ignored, so a client can trust that the filters it sent were the
     filters that ran. */
  const sortValue = sort === undefined ? "catalog" : String(sort);
  if (!problemsRepo.PROBLEM_SORTS.includes(sortValue)) {
    res.status(400).json({ ok: false, error: `Sort must be one of: ${problemsRepo.PROBLEM_SORTS.join(", ")}.` });
    return;
  }
  const solvedValue = solved === undefined ? "all" : String(solved);
  if (!problemsRepo.PROBLEM_STATUS_FILTERS.includes(solvedValue)) {
    res.status(400).json({ ok: false, error: "Solved must be all, yes or no." });
    return;
  }
  const revisionValue = revision === undefined ? "all" : String(revision);
  if (!problemsRepo.REVISION_FILTERS.includes(revisionValue)) {
    res.status(400).json({ ok: false, error: "Revision must be all, scheduled, due or overdue." });
    return;
  }
  const statementValue = statement === undefined ? "all" : String(statement);
  if (!problemsRepo.STATEMENT_FILTERS.includes(statementValue)) {
    res.status(400).json({ ok: false, error: "Statement must be all, stored or missing." });
    return;
  }
  if (inStatement !== undefined && !["0", "1", "true", "false"].includes(String(inStatement).toLowerCase())) {
    res.status(400).json({ ok: false, error: "inStatement must be true or false." });
    return;
  }

  /* Multi-platform catalog filters. `platform` is validated against the real
     list; `topic` is a free label but is bound as a parameter and matched
     against the JSON topics array, never concatenated. `company` is checked
     against the companies table below, because that table ships empty. */
  const platformValue = platform === undefined ? "" : String(platform);
  if (platformValue && !["all", ...problemsRepo.PLATFORM_FILTERS].includes(platformValue)) {
    res.status(400).json({
      ok: false,
      error: `Platform must be all or one of: ${problemsRepo.PLATFORM_FILTERS.join(", ")}.`
    });
    return;
  }
  if (topic !== undefined && (typeof topic !== "string" || topic.length > 60)) {
    res.status(400).json({ ok: false, error: "Invalid topic." });
    return;
  }
  if (company !== undefined && (typeof company !== "string" || !/^[a-z0-9-]{1,64}$/.test(company))) {
    res.status(400).json({ ok: false, error: "Invalid company." });
    return;
  }
  /* Due/overdue are relative to the caller's today, sent as a calendar day. */
  let todayKey = "";
  if (revisionValue === "due" || revisionValue === "overdue") {
    if (today === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(String(today))) {
      res.status(400).json({ ok: false, error: "Filtering by due date needs today as YYYY-MM-DD." });
      return;
    }
    todayKey = String(today);
  }

  try {
    const page = await problemsRepo.listProblems({
      q: typeof search === "string" ? search : "",
      difficulty: difficultyValue,
      category: typeof category === "string" ? category : "",
      lcNum: num !== undefined ? Number(num) : null,
      sort: sortValue,
      solved: solvedValue,
      revision: revisionValue,
      statement: statementValue,
      inStatement: ["1", "true"].includes(String(inStatement || "").toLowerCase()),
      today: todayKey,
      platform: platformValue,
      topic: typeof topic === "string" ? topic : "",
      company: typeof company === "string" ? company : "",
      limit,
      offset
    });
    res.json({ ok: true, ...page });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

/* What the catalog contains, for the filter panel and the About page.
   Reports real counts per platform, per difficulty and per topic, plus the
   companies that are actually recorded.

   The companies list is empty today, and that is the honest answer: a company
   row asserts that the company asks that problem, no public dataset states
   which companies ask which problems, and guessing would put false
   attributions in front of the user. The endpoint returns the empty list plus
   a note saying why, so the UI can explain it instead of rendering a broken
   control. */
app.get("/api/problems-facets", rateLimit, async (_req, res) => {
  try {
    const { query } = require("./db/pool");

    const totals = await query(
      `SELECT platform, COUNT(*) AS n,
              SUM(difficulty = 'Easy') AS easy,
              SUM(difficulty = 'Medium') AS medium,
              SUM(difficulty = 'Hard') AS hard,
              SUM(description_html IS NOT NULL) AS with_statement
         FROM problems GROUP BY platform ORDER BY n DESC`
    );

    const topicRows = await query(
      `SELECT topics FROM problems WHERE topics IS NOT NULL AND JSON_LENGTH(topics) > 0`
    );
    const topics = {};
    for (const row of topicRows) {
      let list = row.topics;
      if (typeof list === "string") {
        try {
          list = JSON.parse(list);
        } catch {
          list = [];
        }
      }
      if (!Array.isArray(list)) continue;
      for (const topic of list) {
        if (typeof topic === "string" && topic) topics[topic] = (topics[topic] || 0) + 1;
      }
    }

    const companyRows = await query(
      `SELECT c.slug, c.name, COUNT(pc.problem_slug) AS n
         FROM companies c
         LEFT JOIN problem_companies pc ON pc.company_id = c.id
        GROUP BY c.slug, c.name ORDER BY c.name`
    );

    const total = totals.reduce((sum, row) => sum + Number(row.n), 0);

    res.json({
      ok: true,
      total,
      platforms: totals.map((row) => ({
        slug: row.platform || "leetcode",
        count: Number(row.n),
        easy: Number(row.easy || 0),
        medium: Number(row.medium || 0),
        hard: Number(row.hard || 0),
        withStatement: Number(row.with_statement || 0)
      })),
      difficulties: {
        Easy: totals.reduce((s, r) => s + Number(r.easy || 0), 0),
        Medium: totals.reduce((s, r) => s + Number(r.medium || 0), 0),
        Hard: totals.reduce((s, r) => s + Number(r.hard || 0), 0)
      },
      topics: Object.entries(topics)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count]) => ({ name, count })),
      companies: companyRows.map((row) => ({ slug: row.slug, name: row.name, count: Number(row.n) })),
      /* Said out loud so the UI never has to imply otherwise. */
      companiesNote: companyRows.length
        ? null
        : "No company attributions are recorded. Quanta does not guess which company asks which problem, because no permitted public dataset states that."
    });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

/* One problem by its stable ID. `:id` accepts the database primary key
   (digits) or the LeetCode slug ("two-sum"), which is what the apps use. */
/* ----------------------- company-wise preparation ---------------------
   Companies with a real problem count, and the problems behind one.

   Both routes answer honestly when the table is empty, because it ships empty
   on purpose: a company row asserts that company asks that problem, and no
   permitted public dataset says so. The endpoint returns an empty list plus a
   `note` explaining why, so the page can say it rather than look broken. */
app.get("/api/companies", rateLimit, async (req, res) => {
  try {
    const companiesRepo = require("./db/companies");
    const companies = await companiesRepo.listCompanies();
    res.json({
      ok: true,
      companies,
      total: companies.reduce((sum, c) => sum + c.problemCount, 0),
      note: await companiesRepo.companiesEmptyNote()
    });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

/* The problems recorded for one company, with difficulty and topic so the page
   can filter without a second round trip. */
app.get("/api/companies/:slug/problems", rateLimit, async (req, res) => {
  const slug = String(req.params.slug || "").trim();
  if (!slug || slug.length > 64 || !/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ ok: false, error: "Invalid company." });
    return;
  }
  const difficulty = req.query.difficulty === undefined ? "" : String(req.query.difficulty);
  if (difficulty && !["", "all", "Easy", "Medium", "Hard"].includes(difficulty)) {
    res.status(400).json({ ok: false, error: "Difficulty must be Easy, Medium, Hard or all." });
    return;
  }
  const topic = req.query.topic === undefined ? "" : String(req.query.topic);
  if (topic && topic.length > 60) {
    res.status(400).json({ ok: false, error: "Invalid topic." });
    return;
  }

  try {
    const companiesRepo = require("./db/companies");
    const items = await companiesRepo.listCompanyProblems(slug, {
      difficulty: difficulty === "all" ? "" : difficulty,
      topic
    });
    res.json({ ok: true, company: slug, items, total: items.length });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

/* Import a company list the caller already holds - their own team's prep list,
   a course's list, a company's published list. This is deliberately an import
   rather than a scrape: the data is the user's to supply, and Quanta refuses to
   harvest one itself. */
app.post("/api/companies/import", rateLimit, async (req, res) => {
  const body = req.body || {};
  if (typeof body.data !== "string" || !body.data.trim()) {
    res.status(400).json({ ok: false, error: "Send the list as `data`." });
    return;
  }
  if (body.data.length > 500000) {
    res.status(400).json({ ok: false, error: "That file is too large to import at once - split it." });
    return;
  }

  try {
    const companiesRepo = require("./db/companies");
    const parsed = companiesRepo.parseCompanyData(body.data, body.source);
    if (parsed.error) {
      res.status(400).json({ ok: false, error: parsed.error });
      return;
    }
    if (!parsed.rows.length) {
      res.status(400).json({
        ok: false,
        error: "Nothing usable in that. Each row needs a problem slug and a company name.",
        rejected: parsed.rejected.slice(0, 20)
      });
      return;
    }

    const result = await companiesRepo.importCompanyData(parsed.rows, parsed.rows[0].note);
    res.json({
      ok: true,
      ...result,
      /* Rows that were usable but are not in Quanta's catalog. Named so a
         partial import is visible instead of quietly dropping half the file. */
      rejected: parsed.rejected.slice(0, 20)
    });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

/* ============================== contest arena ==============================
   Live contests, standings and rating history, from Codeforces' public API.

   These are the only endpoints here that reach outside this database, so they
   answer differently from the rest: an upstream failure is passed through with
   what Codeforces actually said, because "Codeforces is unreachable" and "this
   handle does not exist" are different facts and the page shows both.

   Responses say where they came from and whether they were served from cache,
   because a countdown built on a five-minute-old contest list is not the same
   thing as a live one, and the page needs to be able to say so. */

/* Upstream failures get their own handler: a database error handler would tell
   the user the database is down, which would be a lie. */
const respondUpstreamError = (res, error) => {
  const message = error?.message || String(error);
  /* A handle that does not exist, or a malformed one, is the caller's problem
     rather than an outage - and saying 502 "could not reach Codeforces" about a
     typo sends the reader looking at the wrong problem. */
  const looksLikeBadInput = /not found|does not have that handle|is not a contest id|letters, digits and underscores/i.test(message);
  console.log(`[codeforces] ${message}`);
  if (looksLikeBadInput) {
    res.status(404).json({ ok: false, error: message, source: "codeforces" });
    return;
  }
  res.status(502).json({
    ok: false,
    error: `Could not reach Codeforces: ${message}`,
    source: "codeforces"
  });
};

/* Live, upcoming and recent rounds, already split by the server so the client
   cannot disagree with itself about what is running. */
app.get("/api/contests", rateLimit, async (_req, res) => {
  try {
    const codeforces = require("./codeforces");
    res.json(await codeforces.getContests());
  } catch (error) {
    respondUpstreamError(res, error);
  }
});

/* One contest: its problems and an analysed slice of its standings.

   Why the analysis happens here rather than in the browser
   -------------------------------------------------------
   Codeforces refuses to page `contest.standings` for anonymous callers, so the
   whole table arrives or nothing does. A busy Div. 2 round is around ten
   thousand rows, each carrying a per-problem result object for every problem -
   measured at 7.8 MB and six seconds for one request. Shipping that to every
   tab to let the client find one row would be indefensible.

   So the table is analysed on the way through and only the slice that can be
   displayed leaves the building: the top rows, or the reader's own row with a
   little context around it, plus the real field size and median. The response
   drops from megabytes to a couple of kilobytes with nothing true removed.

   The handle arrives in the query string, is used to find that one row, and is
   not stored, logged or written anywhere. It is the reader's own handle, sent
   to their own server, for the purpose they asked for. */
app.get("/api/contests/:id", rateLimit, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^\d{1,7}$/.test(id)) {
    res.status(400).json({ ok: false, error: "A contest id is a positive number." });
    return;
  }
  const handle = String(req.query.handle || "").trim();
  if (handle && !/^[A-Za-z0-9_]{1,32}$/.test(handle)) {
    res.status(400).json({ ok: false, error: "A Codeforces handle is letters, digits and underscores, up to 32 characters." });
    return;
  }
  try {
    const codeforces = require("./codeforces");
    /* Which of this contest's problems are already in Quanta's catalog, so the
       page can link straight to one instead of sending the reader off-site.
       Joined on Codeforces' own problem id, never on the title. */
    const { query } = require("./db/pool");
    const catalogProblems = await query(
      `SELECT slug, external_id, rating FROM problems WHERE platform = ?`,
      ["codeforces"]
    );
    const payload = await codeforces.getContest(id);
    const engine = require("./contests");
    const matched = engine.matchToCatalog(payload.problems, catalogProblems);
    const analysed = engine.buildStandings({ problems: payload.problems, rows: payload.rows, contest: payload.contest }, { handle, limit: 25 });

    res.json({
      ok: true,
      cached: payload.cached,
      fetchedAt: payload.fetchedAt,
      source: payload.source,
      contest: payload.contest,
      problems: matched.problems,
      catalog: { inCatalog: matched.inCatalog, total: matched.total },
      plan: engine.contestPlan(matched.problems, { contest: payload.contest }),
      /* The analysed standings. `rows` is the real number of entrants, not the
         number shown, so the page can say "top 25 of 9,709" and mean it. */
      standings: analysed,
      rowCount: analysed.total,
      /* What Codeforces' own penalty arithmetic looks like against the
         published formula, so the decision not to recompute it stays checkable
         rather than merely asserted. Measured on the server because it walks
         every row. */
      penaltyCheck: engine.verifyPenalty({ problems: payload.problems, rows: payload.rows })
    });
  } catch (error) {
    respondUpstreamError(res, error);
  }
});

/* A real Codeforces profile: rank, rating, and the full rating history. */
app.get("/api/codeforces/profile", rateLimit, async (req, res) => {
  const handle = String(req.query.handle || "").trim();
  if (!handle) {
    res.status(400).json({ ok: false, error: "Send a Codeforces handle as ?handle=." });
    return;
  }
  /* Shape checked here as well as in the client module, so a malformed handle
     is answered as the bad request it is. Left to the upstream client it became
     a 404, which reads as "Codeforces has never heard of this person" - true,
     but the wrong diagnosis: the string could not have been a handle at all. */
  if (!/^[A-Za-z0-9_]{1,32}$/.test(handle)) {
    res.status(400).json({
      ok: false,
      error: "A Codeforces handle is letters, digits and underscores, up to 32 characters.",
      source: "quanta"
    });
    return;
  }
  try {
    const codeforces = require("./codeforces");
    res.json(await codeforces.getProfile(handle));
  } catch (error) {
    respondUpstreamError(res, error);
  }
});

/* Whether the cache is doing its job. Diagnostics only - it exposes no user
   data and no upstream credentials, and it is what makes the caching claim
   checkable rather than merely stated. */
app.get("/api/contests-cache", rateLimit, async (_req, res) => {
  try {
    const codeforces = require("./codeforces");
    res.json({ ok: true, ...codeforces.cacheStats() });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Could not read the cache state." });
  }
});

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

/* --------------------------- coding progress ---------------------------- */
/* Progress endpoints. Three different facts are kept apart on purpose:

   - "solved"      what the user marked solved. This app cannot verify
                   algorithmic correctness (JavaScript runs in the browser,
                   other languages run with free-form stdin, never against the
                   problem's test cases), so it is never reported as a verified
                   acceptance.
   - runs          real executions this server performed (Judge0).
   - catalog totals straight from the problems table.

   There is no login system, so every row belongs to the single implicit owner
   in db/progress.js; nothing is ever merged across owners. */

/* Accepts a bounded integer query parameter, otherwise answers 400. */
const readBoundedInt = (value, { min, max, fallback }) => {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
};

app.get("/api/progress/summary", rateLimit, async (req, res) => {
  const tzOffset = readBoundedInt(req.query.tzOffset, { min: -840, max: 840, fallback: 0 });
  const days = readBoundedInt(req.query.days, { min: 30, max: 730, fallback: null });
  const weeks = readBoundedInt(req.query.weeks, { min: 4, max: 26, fallback: null });
  const months = readBoundedInt(req.query.months, { min: 3, max: 12, fallback: null });

  if (tzOffset === null || days === null || weeks === null || months === null) {
    res.status(400).json({ ok: false, error: "Invalid progress query parameters." });
    return;
  }

  try {
    const summary = await progressRepo.getSummary({
      tzOffsetMinutes: tzOffset,
      days: days ?? undefined,
      weeks: weeks ?? undefined,
      months: months ?? undefined
    });
    res.json({ ok: true, ...summary });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

/* Everything currently marked solved - used by the clients to sync their local
   problem list with the database. */
app.get("/api/progress", rateLimit, async (_req, res) => {
  try {
    const items = await progressRepo.listSolved();
    res.json({ ok: true, items, total: items.length });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

/* Paginated solved history, newest first. */
app.get("/api/progress/activity", rateLimit, async (req, res) => {
  const limit = readBoundedInt(req.query.limit, { min: 1, max: 50, fallback: 20 });
  const offset = readBoundedInt(req.query.offset, { min: 0, max: 1000000, fallback: 0 });
  if (limit === null || offset === null) {
    res.status(400).json({ ok: false, error: "Invalid pagination parameters." });
    return;
  }

  try {
    const page = await progressRepo.listActivity({ limit, offset });
    res.json({ ok: true, ...page });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

/* Records the user's own "Mark solved" decision. */
app.post("/api/progress/solved", rateLimit, async (req, res) => {
  const slug = typeof req.body?.slug === "string" ? req.body.slug : "";
  const solved = req.body?.solved;
  const title = typeof req.body?.title === "string" ? req.body.title : "";
  const num = req.body?.num;
  const difficulty = typeof req.body?.difficulty === "string" ? req.body.difficulty : "";

  if (!slug || slug.length > 191) {
    res.status(400).json({ ok: false, error: "A problem slug is required." });
    return;
  }
  if (typeof solved !== "boolean") {
    res.status(400).json({ ok: false, error: "solved must be true or false." });
    return;
  }
  if (title.length > 255) {
    res.status(400).json({ ok: false, error: "Title is too long." });
    return;
  }
  if (num !== undefined && num !== null && !Number.isInteger(Number(num))) {
    res.status(400).json({ ok: false, error: "Problem number must be an integer." });
    return;
  }
  if (difficulty && !["Easy", "Medium", "Hard"].includes(difficulty)) {
    res.status(400).json({ ok: false, error: "Difficulty must be Easy, Medium or Hard." });
    return;
  }

  try {
    const row = await progressRepo.markSolved({
      slug,
      title,
      num: num === null ? undefined : num,
      difficulty,
      solved
    });
    res.json({ ok: true, problem: row });
  } catch (error) {
    if (/valid problem slug/i.test(error?.message || "")) {
      res.status(400).json({ ok: false, error: "That problem slug is not valid." });
      return;
    }
    respondDatabaseError(res, error);
  }
});

/* Best-effort run history. A failure here is logged and dropped: the editor is
   waiting for the run answer and must never see a database error instead.
   PROGRESS_RECORD_RUNS=0 turns the recording off, which the integration test
   server uses so its own executions never land in the real run history. */
const RECORD_RUNS = process.env.PROGRESS_RECORD_RUNS !== "0";

const recordRunAttempt = async (language, body, result) => {
  if (!RECORD_RUNS || !database.isConfigured()) return;
  try {
    const seconds = Number.parseFloat(result?.time);
    await progressRepo.recordRun({
      slug: typeof body?.slug === "string" ? body.slug : "",
      num: body?.num,
      language,
      status: result?.ok ? "Completed" : result?.phase === "compile" ? "Compile Error" : "Failed",
      ok: Boolean(result?.ok),
      durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
    });
  } catch (error) {
    console.error(`[progress] run not recorded: ${error?.message || error}`);
  }
};

/* ------------------------- notes and saved solutions --------------------- */
/* Private working documents: the user's study note for a problem and any number
   of saved solutions. Every read and write is scoped to the single owner in
   db/study.js, so one set of notes can never be seen or changed by another.

   Writes carry the `revision` the client edited. A stale revision is answered
   with 409 and the current server copy, so a slow device can never silently
   overwrite newer work - it becomes a conflict the user resolves. */

const studyErrorStatus = (error) => {
  const message = error?.message || String(error);
  if (/slug is required|code is required/i.test(message)) return 400;
  return 500;
};

app.get("/api/study/note", rateLimit, async (req, res) => {
  const slug = String(req.query.slug || "");
  if (!studyRepo.normalizeSlug(slug)) {
    res.status(400).json({ ok: false, error: "A valid problem slug is required." });
    return;
  }
  try {
    const note = await studyRepo.getNote(slug);
    res.json({ ok: true, note });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

app.put("/api/study/note", rateLimit, async (req, res) => {
  const body = req.body || {};
  const baseRevision = body.baseRevision === undefined ? 0 : Number(body.baseRevision);
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    res.status(400).json({ ok: false, error: "baseRevision must be a whole number." });
    return;
  }
  if (body.tags !== undefined && !Array.isArray(body.tags) && typeof body.tags !== "string") {
    res.status(400).json({ ok: false, error: "tags must be an array of words." });
    return;
  }
  try {
    const result = await studyRepo.saveNote({ ...body, baseRevision });
    if (result.conflict) {
      res.status(409).json({
        ok: false,
        conflict: true,
        reason: result.reason,
        error:
          result.reason === "missing"
            ? "This note no longer exists on the server. Reload to drop your copy, or save it again."
            : "This note changed on another device. Reload to get that version, or save yours again.",
        note: result.server
      });
      return;
    }
    res.json({ ok: true, note: result.note });
  } catch (error) {
    const status = studyErrorStatus(error);
    if (status === 500) {
      respondDatabaseError(res, error);
      return;
    }
    res.status(status).json({ ok: false, error: error?.message || "Invalid note." });
  }
});

app.delete("/api/study/note", rateLimit, async (req, res) => {
  const slug = String(req.query.slug || "");
  if (!studyRepo.normalizeSlug(slug)) {
    res.status(400).json({ ok: false, error: "A valid problem slug is required." });
    return;
  }
  try {
    const removed = await studyRepo.deleteNote(slug);
    if (!removed) {
      res.status(404).json({ ok: false, error: "No note found for this problem." });
      return;
    }
    res.json({ ok: true, deleted: true });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

app.get("/api/study/solutions", rateLimit, async (req, res) => {
  try {
    const page = await studyRepo.listSolutions({
      slug: String(req.query.slug || ""),
      limit: req.query.limit,
      offset: req.query.offset
    });
    res.json({ ok: true, ...page });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

/* Search the user's own notes and saved solutions by text, language or tag. */
app.get("/api/study/search", rateLimit, async (req, res) => {
  const q = req.query.q === undefined ? "" : String(req.query.q);
  if (q.length > 200) {
    res.status(400).json({ ok: false, error: "Search text is too long." });
    return;
  }
  try {
    const items = await studyRepo.searchStudy({
      q,
      language: String(req.query.language || ""),
      tag: String(req.query.tag || ""),
      limit: req.query.limit
    });
    res.json({ ok: true, items, total: items.length });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

app.post("/api/study/solutions", rateLimit, async (req, res) => {
  const body = req.body || {};
  if (typeof body.code !== "string" || !body.code.trim()) {
    res.status(400).json({ ok: false, error: "Code is required." });
    return;
  }
  try {
    const result = await studyRepo.createSolution(body);
    res.status(result.created ? 201 : 200).json({ ok: true, solution: result.solution, created: result.created });
  } catch (error) {
    const status = studyErrorStatus(error);
    if (status === 500) {
      respondDatabaseError(res, error);
      return;
    }
    res.status(status).json({ ok: false, error: error?.message || "Invalid solution." });
  }
});

app.put("/api/study/solutions/:id", rateLimit, async (req, res) => {
  const body = req.body || {};
  const baseRevision = body.baseRevision === undefined ? 0 : Number(body.baseRevision);
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    res.status(400).json({ ok: false, error: "baseRevision must be a whole number." });
    return;
  }
  try {
    const result = await studyRepo.updateSolution(req.params.id, { ...body, baseRevision });
    if (result.notFound) {
      res.status(404).json({ ok: false, error: "That saved solution no longer exists." });
      return;
    }
    if (result.conflict) {
      res.status(409).json({
        ok: false,
        conflict: true,
        error: "This solution changed on another device. Reload to get that version, or save yours again.",
        solution: result.server
      });
      return;
    }
    res.json({ ok: true, solution: result.solution });
  } catch (error) {
    const status = studyErrorStatus(error);
    if (status === 500) {
      respondDatabaseError(res, error);
      return;
    }
    res.status(status).json({ ok: false, error: error?.message || "Invalid solution." });
  }
});

app.delete("/api/study/solutions/:id", rateLimit, async (req, res) => {
  try {
    const removed = await studyRepo.deleteSolution(req.params.id);
    if (!removed) {
      res.status(404).json({ ok: false, error: "That saved solution no longer exists." });
      return;
    }
    res.json({ ok: true, deleted: true });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

/* --------------------------- smart revision API --------------------------- */
/* When each problem should be revisited next. Every read and write is scoped to
   the single owner in db/revision.js.

   `tzOffsetMinutes` (minutes east of UTC) is sent by the client so "due today"
   means the caller's today. Dates are stored as calendar days, so no timezone
   rule can move a review. Scheduling lives in db/revision.js (nextSchedule) and
   is unit-tested there; this layer only validates and delegates. */

app.get("/api/revision", rateLimit, async (req, res) => {
  const tzOffset = req.query.tzOffset === undefined ? 0 : Number(req.query.tzOffset);
  if (!Number.isInteger(tzOffset) || tzOffset < -840 || tzOffset > 840) {
    res.status(400).json({ ok: false, error: "Invalid timezone offset." });
    return;
  }
  try {
    const dashboard = await revisionRepo.getDashboard({ tzOffsetMinutes: tzOffset });
    res.json({ ok: true, ...dashboard });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

app.get("/api/revision/history", rateLimit, async (req, res) => {
  try {
    const page = await revisionRepo.listHistory({
      slug: String(req.query.slug || ""),
      limit: req.query.limit,
      offset: req.query.offset
    });
    res.json({ ok: true, ...page });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

app.post("/api/revision", rateLimit, async (req, res) => {
  const body = req.body || {};
  const tzOffset = body.tzOffsetMinutes === undefined ? 0 : Number(body.tzOffsetMinutes);
  if (!Number.isInteger(tzOffset) || tzOffset < -840 || tzOffset > 840) {
    res.status(400).json({ ok: false, error: "Invalid timezone offset." });
    return;
  }
  if (typeof body.slug !== "string" || body.slug.length > 191) {
    res.status(400).json({ ok: false, error: "A problem slug is required." });
    return;
  }
  if (body.title !== undefined && typeof body.title !== "string") {
    res.status(400).json({ ok: false, error: "Title must be text." });
    return;
  }
  if (body.difficulty && !["Easy", "Medium", "Hard"].includes(body.difficulty)) {
    res.status(400).json({ ok: false, error: "Difficulty must be Easy, Medium or Hard." });
    return;
  }
  try {
    const item = await revisionRepo.addItem({ ...body, tzOffsetMinutes: tzOffset });
    res.json({ ok: true, item });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || "Could not add this problem." });
  }
});

app.post("/api/revision/:slug/review", rateLimit, async (req, res) => {
  const body = req.body || {};
  const tzOffset = body.tzOffsetMinutes === undefined ? 0 : Number(body.tzOffsetMinutes);
  if (!Number.isInteger(tzOffset) || tzOffset < -840 || tzOffset > 840) {
    res.status(400).json({ ok: false, error: "Invalid timezone offset." });
    return;
  }
  if (!revisionRepo.CONFIDENCE.includes(body.confidence)) {
    res.status(400).json({ ok: false, error: "Confidence must be again, difficult, good or easy." });
    return;
  }
  try {
    const result = await revisionRepo.reviewItem(req.params.slug, { ...body, tzOffsetMinutes: tzOffset });
    if (result.notFound) {
      res.status(404).json({ ok: false, error: "This problem is not in your revision list." });
      return;
    }
    if (result.completed) {
      res.status(409).json({ ok: false, error: "This problem is already finished. Add it again to revise it." });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || "Could not record this review." });
  }
});

app.post("/api/revision/:slug/reschedule", rateLimit, async (req, res) => {
  const body = req.body || {};
  const tzOffset = body.tzOffsetMinutes === undefined ? 0 : Number(body.tzOffsetMinutes);
  if (!Number.isInteger(tzOffset) || tzOffset < -840 || tzOffset > 840) {
    res.status(400).json({ ok: false, error: "Invalid timezone offset." });
    return;
  }
  const snoozeDays = body.snoozeDays === undefined ? null : Number(body.snoozeDays);
  if (snoozeDays !== null && (!Number.isInteger(snoozeDays) || snoozeDays < 1 || snoozeDays > 365)) {
    res.status(400).json({ ok: false, error: "snoozeDays must be between 1 and 365." });
    return;
  }
  try {
    const result = await revisionRepo.rescheduleItem(req.params.slug, { ...body, tzOffsetMinutes: tzOffset });
    if (result.notFound) {
      res.status(404).json({ ok: false, error: "This problem is not in your active revision list." });
      return;
    }
    res.json({ ok: true, item: result.item });
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || "Could not change the date." });
  }
});

app.post("/api/revision/:slug/complete", rateLimit, async (req, res) => {
  const body = req.body || {};
  const tzOffset = body.tzOffsetMinutes === undefined ? 0 : Number(body.tzOffsetMinutes);
  if (!Number.isInteger(tzOffset) || tzOffset < -840 || tzOffset > 840) {
    res.status(400).json({ ok: false, error: "Invalid timezone offset." });
    return;
  }
  try {
    const result = await revisionRepo.completeItem(req.params.slug, { tzOffsetMinutes: tzOffset });
    if (result.notFound) {
      res.status(404).json({ ok: false, error: "This problem is not in your revision list." });
      return;
    }
    /* Repeating "finished" is allowed and is reported as such; the first
       completion time is never overwritten. */
    res.json({ ok: true, item: result.item, alreadyCompleted: result.alreadyCompleted === true });
  } catch (error) {
    respondDatabaseError(res, error);
  }
});

app.delete("/api/revision/:slug", rateLimit, async (req, res) => {
  try {
    const removed = await revisionRepo.removeItem(req.params.slug);
    if (!removed) {
      res.status(404).json({ ok: false, error: "This problem is not in your revision list." });
      return;
    }
    /* The review history is kept on purpose - removing a row must never erase
       what was actually reviewed. */
    res.json({ ok: true, deleted: true });
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
    /* Recorded after the answer was sent: the dashboard's run counters come
       from real executions, never from what the client claims. */
    void recordRunAttempt(language, req.body, result);
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
