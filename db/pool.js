/* ------------------------------ db / pool ------------------------------- */
/* Shared MySQL access for the Quanta backend.

   Rules that keep the app safe and offline-friendly:
   - Credentials only ever live here (read from .env), never in API responses.
   - Every query is parameterized.
   - A missing/unreachable database must never crash the server: callers get a
     normal failure object and the API answers 503 with a generic message. */

const path = require("path");
const fs = require("fs");
const mysql = require("mysql2/promise");

/* Scripts (migrate / import / tests) require this module directly, so load
   .env here too. dotenv.config() never overrides variables that already
   exist, which makes repeated calls harmless. */
try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
} catch {
  /* no .env yet — defaults below apply */
}

const QUERY_TIMEOUT_MS = Number(process.env.DB_QUERY_TIMEOUT_MS || 8000);

/* Hosted MySQL (TiDB, PlanetScale proxy, Aiven, RDS, …) requires TLS. Set
   DB_SSL=true to enable it, optionally with DB_SSL_CA=/path/to/ca.pem for the
   provider's certificate bundle. DB_SSL=insecure turns off certificate
   verification and must only be used for local testing. */
const buildSslConfig = () => {
  const mode = String(process.env.DB_SSL || "").trim().toLowerCase();
  if (!mode || mode === "0" || mode === "false" || mode === "off" || mode === "no") return undefined;
  const ssl = { rejectUnauthorized: mode !== "insecure" && mode !== "skip" };
  const caPath = String(process.env.DB_SSL_CA || "").trim();
  if (caPath) {
    try {
      ssl.ca = fs.readFileSync(path.resolve(caPath), "utf8");
    } catch {
      console.warn(`[db] Could not read DB_SSL_CA file: ${caPath} — using the system trust store.`);
    }
  }
  return ssl;
};

const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "Quanta-Leetcode",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: Math.min(QUERY_TIMEOUT_MS, 10000),
  charset: "utf8mb4",
  ssl: buildSslConfig(),
  /* Multi-statement SQL is only enabled on the dedicated migration
     connection inside migrate.js — never on this pool. */
  multipleStatements: false
};

const isConfigured = () => Boolean(dbConfig.database && dbConfig.user);

let pool = null;

const getPool = () => {
  if (!isConfigured()) {
    throw new Error("Database is not configured. Set DB_HOST, DB_USER, DB_PASSWORD and DB_NAME in .env");
  }
  if (!pool) {
    pool = mysql.createPool(dbConfig);
    /* A pool-level error (e.g. server went away) must not take Node down. */
    try {
      pool.on?.("error", () => {
        /* connections are recreated lazily on the next query */
      });
    } catch {
      /* older drivers without an error channel */
    }
  }
  return pool;
};

/* Runs one parameterized statement and enforces an application-level timeout
   (mysql2 has no per-query timeout). Rejects with a plain Error. */
const query = async (sql, params = []) => {
  const activePool = getPool();
  let timer = null;
  try {
    const result = await Promise.race([
      activePool.query(sql, params),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Database query timed out.")), QUERY_TIMEOUT_MS);
      })
    ]);
    return result[0];
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/* Cheap connectivity probe used by /health and the Settings "Test" button. */
const checkDatabase = async () => {
  if (!isConfigured()) {
    return { configured: false, ok: false, error: "Not configured." };
  }
  const startedAt = Date.now();
  try {
    await query("SELECT 1");
    return { configured: true, ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { configured: true, ok: false, error: error?.message || "Connection failed." };
  }
};

/* Never leaks host/user/password — /health and tests may print this. */
const describeConfig = () => ({
  configured: isConfigured(),
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  ssl: Boolean(dbConfig.ssl)
});

const closePool = async () => {
  if (!pool) return;
  const activePool = pool;
  pool = null;
  try {
    await activePool.end();
  } catch {
    /* already closed */
  }
};

/* Runs several statements atomically: either all of them commit or none do.
   The callback receives a parameterized `run(sql, params)` function. */
const withTransaction = async (callback) => {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(async (sql, params = []) => {
      const [rows] = await connection.query(sql, params);
      return rows;
    });
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      /* connection already broken */
    }
    throw error;
  } finally {
    try {
      connection.release();
    } catch {
      /* already released */
    }
  }
};

module.exports = {
  query,
  checkDatabase,
  describeConfig,
  closePool,
  withTransaction,
  isConfigured,
  dbConfig
};
