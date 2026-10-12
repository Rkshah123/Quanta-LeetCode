/* ------------------------------ db / migrate ---------------------------- */
/* Versioned, repeatable schema migrations for Quanta.

   Usage:
     npm run migrate            apply every pending migration
     npm run migrate -- --status  show what is applied without changing data

   Safety:
   - Files run in filename order and are recorded in schema_migrations, so a
     file is never executed twice.
   - Migration files must be additive. Nothing here drops, truncates or
     deletes existing rows.
   - Each file runs on a single connection inside a transaction. Note that DDL
     implicitly commits on MySQL, so a failure part way through a file leaves
     the earlier statements applied. Additive statements are therefore written
     to be individually idempotent (CREATE TABLE IF NOT EXISTS, and
     addColumnIfMissing / createIndexIfMissing below), so re-running a
     half-applied file completes it instead of failing on work already done. */

/* Columns and indexes a migration wants to add, keyed by migration file.
   Held here rather than in the .sql files because MySQL offers no
   `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, and a plain
   ALTER in the file would abort on any statement a previous partial run had
   already completed. The runner checks information_schema and issues the DDL
   only when it is genuinely missing.

   A migration that needs a column of a type the helper cannot express simply
   puts plain `ALTER TABLE` statements in its .sql file instead; the helper is
   a convenience, not a requirement. */
const MIGRATION_ADD_COLUMNS = {
  "005_multiplatform.sql": [
    ["platform", "platform varchar(32) NULL"],
    ["external_id", "external_id varchar(64) NULL"],
    ["rating", "rating int NULL"],
    ["content_hash", "content_hash char(40) NULL"],
    ["statement_len", "statement_len int NULL"],
    ["interview_relevance", "interview_relevance tinyint NULL"]
  ]
};

const MIGRATION_ADD_INDEXES = {
  "005_multiplatform.sql": [
    ["idx_problems_platform", "(platform)"],
    ["idx_problems_content_hash", "(content_hash)"],
    ["idx_problems_external", "(platform, external_id)"]
  ]
};

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

/* Adds a column only when it is absent. Returns true when DDL was issued, so
   the caller can report "already present" honestly instead of implying it
   changed something. */
const addColumnIfMissing = async (connection, table, column, ddl) => {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  if (rows.length) return false;
  await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
  return true;
};

const createIndexIfMissing = async (connection, table, index, columns) => {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, index]
  );
  if (rows.length) return false;
  /* `columns` is the parenthesised column list, e.g. "(platform, external_id)". */
  await connection.query(`CREATE INDEX \`${index}\` ON \`${table}\` ${columns}`);
  return true;
};

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
        /* Guarded DDL first: these are individually idempotent, so a file that
           a previous run left half-applied can finish. They run inside the
           transaction, which MySQL implicitly commits around - harmless here
           because each statement is safe to repeat. */
        let added = 0;
        for (const [column, ddl] of MIGRATION_ADD_COLUMNS[file] || []) {
          if (await addColumnIfMissing(connection, "problems", column, ddl)) added += 1;
        }
        let indexed = 0;
        for (const [index, columns] of MIGRATION_ADD_INDEXES[file] || []) {
          if (await createIndexIfMissing(connection, "problems", index, columns)) indexed += 1;
        }
        if (added || indexed) {
          console.log(`    ${added} column(s) added, ${indexed} index(es) added`);
        }

        await connection.query(sql);
        await connection.query("INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)", [file, checksum]);
        await connection.commit();
        appliedCount += 1;
        console.log(`  ${file} — applied`);
      } catch (error) {
        await connection.rollback().catch(() => {});
        console.error(`  ${file} — FAILED: ${error?.message || error}`);
        console.error("  Statements that already committed are idempotent, so re-run `npm run migrate` to continue.");
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
