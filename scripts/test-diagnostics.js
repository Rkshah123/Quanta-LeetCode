/* ------------------------ scripts / test-diagnostics ---------------------- */
/* Tests the data the Connection diagnostics rely on.
   Usage:
     npm run test:diagnostics

   The important one is the last case: an API that answers while its database
   is unreachable. A client that only asks "did /health respond?" would report
   everything as fine, so the health payload has to say which part failed. */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const path = require("path");
const { spawn } = require("child_process");
const { closePool } = require("../db/pool");

const ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(ROOT, "server.js");
const BASE_PORT = Number(process.env.DIAG_TEST_PORT || 3411);
const START_TIMEOUT_MS = 30000;

let passed = 0;
let failures = 0;

const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startServer = async (port, envOverrides = {}) => {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join("")}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.status) return { child, base, logs };
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  child.kill();
  throw new Error(`server did not start: ${logs.join("")}`);
};

const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => child.on("exit", resolve));
};

/* Nothing a diagnostics panel could ever render may carry infrastructure
   details. Checked against every field the panel reads. */
const SECRET_PATTERN = /password|passwd|secret|token|authorization|DB_HOST|DB_USER|DB_PASSWORD|mysql:\/\/|tidbcloud|\broot\b|ER_ACCESS_DENIED|ER_BAD_DB_ERROR|Access denied|getaddrinfo/i;

const main = async () => {
  console.log("\n-- a healthy server --");
  const healthy = await startServer(BASE_PORT);
  try {
    const response = await fetch(`${healthy.base}/health`);
    const payload = await response.json();
    check("health answers 200", response.status === 200, `status ${response.status}`);
    check("it reports itself ok", payload?.ok === true, JSON.stringify(payload?.ok));
    check("the database check is a real one and passed", payload?.database?.ok === true, JSON.stringify(payload?.database));
    check("it includes a latency so the panel can show it", typeof payload?.database?.latencyMs === "number", String(payload?.database?.latencyMs));
    check("it carries a server timestamp", typeof payload?.timestamp === "string", String(payload?.timestamp));
    check("no secrets in a healthy health payload", !SECRET_PATTERN.test(JSON.stringify(payload)), "checked");

    /* The panel must be able to tell these three apart, so all three keys have
       to be present and independently readable. */
    const catalog = await fetch(`${healthy.base}/api/problems?limit=1`);
    check("the catalog still answers", catalog.status === 200, `status ${catalog.status}`);
  } finally {
    await stop(healthy.child);
  }

  console.log("\n-- the API answers but its database is down --");
  /* This is the case that separates "connected" from "working". */
  const broken = await startServer(BASE_PORT + 1, { DB_HOST: "127.0.0.1", DB_PORT: "9", DB_CONNECTION_LIMIT: "1", DB_QUERY_TIMEOUT_MS: "3000" });
  try {
    const response = await fetch(`${broken.base}/health`);
    const payload = await response.json();
    check("the API itself still answers 200", response.status === 200, `status ${response.status}`);
    check("the API still reports itself ok", payload?.ok === true, "a reachable server is still reachable");
    check(
      "but the database is reported as not ok",
      payload?.database?.ok === false,
      `database.ok=${payload?.database?.ok} - a client can tell these apart`
    );
    check("the database is still marked configured", payload?.database?.configured === true, JSON.stringify(payload?.database?.configured));
    check("the failure detail is generic", payload?.database?.error === "Connection failed.", JSON.stringify(payload?.database?.error));
    check("a broken database reports an error the panel can show", typeof payload?.database?.error === "string" && payload.database.error.length > 0, JSON.stringify(payload?.database?.error));
    check("no host, user or driver error is exposed", !SECRET_PATTERN.test(JSON.stringify(payload)), JSON.stringify(payload?.database));

    const catalog = await fetch(`${broken.base}/api/problems?limit=1`);
    check("the catalog reports the failure instead of pretending", catalog.status === 503, `status ${catalog.status}`);
    const body = await catalog.text();
    check("the catalog error carries no secrets", !SECRET_PATTERN.test(body), body.slice(0, 120));
  } finally {
    await stop(broken.child);
  }

  console.log("\n-- the health payload can express every state the panel shows --");
  /* The panel distinguishes "no database configured" from "database broken".
     That third state cannot be produced here, because this repository's .env
     always supplies a database - so what is checked is the contract that lets a
     client tell the states apart: `configured` and `ok` are independent
     booleans, present in every response. */
  const again = await startServer(BASE_PORT + 2);
  try {
    const payload = await (await fetch(`${again.base}/health`)).json();
    check("configured is a boolean", typeof payload?.database?.configured === "boolean", String(payload?.database?.configured));
    check("ok is a boolean", typeof payload?.database?.ok === "boolean", String(payload?.database?.ok));
    check(
      "a healthy database reports latency and no error",
      typeof payload?.database?.latencyMs === "number" && !payload?.database?.error,
      JSON.stringify(payload?.database)
    );
    check("no secrets", !SECRET_PATTERN.test(JSON.stringify(payload)), "checked");
  } finally {
    await stop(again.child);
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  await closePool();
  process.exit(failures ? 1 : 0);
};

main().catch(async (error) => {
  failures += 1;
  console.log(`FAIL  the suite threw: ${error?.message || error}`);
  await closePool();
  process.exit(1);
});