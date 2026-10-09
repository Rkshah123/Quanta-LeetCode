/* ------------------------------ db / migrate ---------------------------- */
/* Versioned, repeatable schema migrations for Quanta.

   Usage:
     npm run migrate            apply every pending migration
     npm run migrate -- --status  show what is applied without changing data

   Safety:
   - Files run in filename order and are recorded in schema_migrations, so a
     file is never executed twice.
   - Migration files must be additive (CREATE TABLE IF NOT EXISTS / ADD COLUMN
     IF NOT EXISTS). Nothing here drops, truncates or deletes existing rows.
   - Each file runs on a single connection inside a transaction. A failure
     rolls that file back and stops the run; earlier files stay applied. */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const { dbConfig, describeConfig } = require("./pool");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");
const statusOnly = process.argv.includes("--status");

const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(191) NOT NULL,
    checksum CHAR(40) NOT NULL,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (version)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const listFiles = () => {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.toLowerCase().endsWith(".sql"))
    .sort();
};

const sha1 = (value) => crypto.createHash("sha1").update(value, "utf8").digest("hex");

const looksLikeMissingDatabase = (error) =>
  error && (error.code === "ER_BAD_DB_ERROR" || /unknown database/i.test(error.message || ""));

const main = async () => {
  const files = listFiles();
  const config = describeConfig();

  if (!files.length) {
    console.log("No migration files found in db/migrations.");
    return 0;
  }

  let connection;
  try {
    /* Dedicated connection: multi-statement SQL is required to run a whole
       .sql file, and that flag stays off for the runtime query pool. */
    connection = await mysql.createConnection({ ...dbConfig, multipleStatements: true });
  } catch (error) {
    console.error(`Could not connect to MySQL at ${config.host}:${config.port}/${config.database}.`);
    console.error(`  ${error?.message || error}`);
    if (looksLikeMissingDatabase(error)) {
      console.error("");
      console.error("The database does not exist yet. Create it first with:");
      console.error(
        "  CREATE DATABASE IF NOT EXISTS `Quanta-Leetcode` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci;"
      );
    }
    console.error("Check DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME in .env");
    return 1;
  }

  try {
    await connection.query(MIGRATIONS_TABLE_SQL);
    const [appliedRows] = await connection.query("SELECT version, checksum FROM schema_migrations");
    const applied = new Map(appliedRows.map((row) => [row.version, row.checksum]));

    if (statusOnly) {
      console.log(`Database: ${config.database} @ ${config.host}:${config.port}`);
      for (const file of files) {
        const checksum = sha1(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
        const appliedAt = applied.get(file);
        const state = appliedAt ? (appliedAt === checksum ? "applied" : "applied (file changed since)") : "pending";
        console.log(`  ${file.padEnd(28)} ${state}`);
      }
      return 0;
    }

    let appliedCount = 0;
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = sha1(sql);

      if (applied.has(file)) {
        if (applied.get(file) !== checksum) {
          console.warn(`! ${file} was already applied but its contents changed.`);
          console.warn("  Applied migrations are never re-run; add a new migration file instead.");
        } else {
          console.log(`  ${file} — already applied`);
        }
        continue;
      }

      console.log(`  ${file} — applying…`);
      await connection.beginTransaction();
      try {
        await connection.query(sql);
        await connection.query("INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)", [file, checksum]);
        await connection.commit();
        appliedCount += 1;
        console.log(`  ${file} — applied`);
      } catch (error) {
        await connection.rollback();
        console.error(`  ${file} — FAILED and was rolled back: ${error?.message || error}`);
        return 1;
      }
    }

    console.log(appliedCount ? `Migration complete (${appliedCount} applied).` : "Database is already up to date.");
    return 0;
  } finally {
    try {
      await connection.end();
    } catch {
      /* already closed */
    }
  }
};

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
