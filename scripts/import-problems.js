/* -------------------------- scripts / import ---------------------------- */
/* Imports the problem catalog into MySQL from sources that already exist:

   1. the seed list baked into lab-notes.js (default), and/or
   2. a backup exported from Quanta: Settings → Export (JSON).

   Problem numbers, titles and difficulties are then verified against
   LeetCode's own problem index, and real statements are downloaded and
   stored. Nothing is ever invented: if LeetCode cannot be reached, the row is
   imported without a description and the app falls back to the live lookup.

   Usage:
     npm run import:problems
     npm run import:problems -- --from backups/leetcode-dashboard-backup-2026-01-01.json
     npm run import:problems -- --limit 20
     npm run import:problems -- --no-descriptions
     npm run import:problems -- --refresh-descriptions
     npm run import:problems -- --dry-run

   The script is idempotent: running it twice does not duplicate rows and does
   not overwrite existing descriptions (unless --refresh-descriptions). */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const database = require("../db/pool");

const ROOT = path.join(__dirname, "..");
const LAB_SOURCE = path.join(ROOT, "lab-notes.js");

const args = process.argv.slice(2);
const readFlag = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const hasFlag = (name) => args.includes(name);

const OPTIONS = {
  from: readFlag("--from"),
  limit: Number(readFlag("--limit", "0")) || 0,
  descriptions: !hasFlag("--no-descriptions"),
  refresh: hasFlag("--refresh-descriptions"),
  dryRun: hasFlag("--dry-run"),
  concurrency: Math.min(6, Math.max(1, Number(readFlag("--concurrency", "4")) || 4))
};

/* ------------------------------- sources -------------------------------- */

const extractSlug = (url) => {
  const match = String(url || "").match(/\/problems\/([^/?#]+)/i);
  return match ? match[1].trim().toLowerCase() : "";
};

/* Reads the `p(num, "slug", "Title", "Difficulty"),` rows of seedProblems().
   The seed list is the only problem data that ships with the app, so parsing
   it keeps the import tied to what the user actually sees. */
const readSeedProblems = () => {
  const source = fs.readFileSync(LAB_SOURCE, "utf8");
  const start = source.indexOf("const seedProblems");
  if (start < 0) throw new Error("seedProblems() not found in lab-notes.js");
  const listStart = source.indexOf("return [", start);
  if (listStart < 0) throw new Error("seedProblems() list not found in lab-notes.js");
  const listEnd = source.indexOf("];", listStart);
  const body = source.slice(listStart, listEnd < 0 ? undefined : listEnd);
  const pattern = /\bp\(\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"(Easy|Medium|Hard)"\s*\)/g;
  const problems = [];
  let match;
  while ((match = pattern.exec(body)) !== null) {
    problems.push({
      num: Number(match[1]),
      slug: match[2].toLowerCase(),
      title: match[3].replace(/\\"/g, '"'),
      difficulty: match[4],
      url: `https://leetcode.com/problems/${match[2].toLowerCase()}/`
    });
  }
  return problems;
};

/* Settings → Export produces this file; only the catalog fields are imported. */
const readExportProblems = (file) => {
  const resolved = path.resolve(file);
  const payload = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const list = payload?.leetcode?.problems || payload?.problems || [];
  if (!Array.isArray(list)) throw new Error("Export file has no problems array.");
  return list
    .map((problem) => {
      const slug = extractSlug(problem.url) || String(problem.slug || "").toLowerCase();
      if (!slug) return null;
      const num = Number(problem.num) || 0;
      return {
        num: num > 0 ? num : null,
        slug,
        title: String(problem.name || problem.title || slug).trim(),
        difficulty: ["Easy", "Medium", "Hard"].includes(problem.difficulty) ? problem.difficulty : "Medium",
        url: problem.url || `https://leetcode.com/problems/${slug}/`
      };
    })
    .filter(Boolean);
};

/* ------------------------- LeetCode live sources ------------------------ */

/* One request returns number/title/difficulty for the whole problem set. */
const fetchProblemIndex = async () => {
  try {
    const response = await fetch("https://leetcode.com/api/problems/all/", {
      headers: { "User-Agent": "Quanta/1.0 (+local import script)" },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const index = new Map();
    for (const entry of payload?.stat_status_pairs || payload?.stat_status_list || []) {
      const stat = entry?.stat;
      if (!stat?.question__title_slug) continue;
      index.set(stat.question__title_slug.toLowerCase(), {
        num: Number(stat.frontend_question_id) || Number(stat.question_id) || null,
        title: String(stat.question__title || "").trim(),
        difficulty: { 1: "Easy", 2: "Medium", 3: "Hard" }[entry?.difficulty?.level] || "Medium"
      });
    }
    return index;
  } catch (error) {
    console.warn(`! Could not download LeetCode's problem index (${error?.message || error}).`);
    console.warn("  Rows will keep their existing numbers/titles/difficulties.");
    return null;
  }
};

const fetchDescription = async (slug) => {
  try {
    const response = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://leetcode.com" },
      body: JSON.stringify({
        query: "query questionContent($titleSlug: String!) { question(titleSlug: $titleSlug) { content } }",
        variables: { titleSlug: slug }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const content = payload?.data?.question?.content;
    return typeof content === "string" && content.trim() ? content : null;
  } catch {
    return null;
  }
};

/* ------------------------------- database ------------------------------- */

const insertProblem = async (problem, updateNumber) => {
  /* Deliberately NOT an ON DUPLICATE KEY UPDATE statement: MySQL would match
     any unique key (slug *or* lc_num) and update whichever row collided,
     which can rewrite a different problem's row. Look the slug up first. */
  const existing = await database.query("SELECT id FROM problems WHERE slug = ? LIMIT 1", [problem.slug]);

  if (existing.length) {
    const sql = updateNumber
      ? "UPDATE problems SET lc_num = ?, title = ?, difficulty = ?, url = ? WHERE slug = ?"
      : "UPDATE problems SET title = ?, difficulty = ?, url = ? WHERE slug = ?";
    const params = updateNumber
      ? [problem.num, problem.title, problem.difficulty, problem.url, problem.slug]
      : [problem.title, problem.difficulty, problem.url, problem.slug];
    try {
      const result = await database.query(sql, params);
      return result?.affectedRows > 0 ? "upserted" : "unchanged";
    } catch (error) {
      if (error?.code !== "ER_DUP_ENTRY") throw error;
      /* The number belongs to a different row — keep the slug, drop the number. */
      const result = await database.query(
        "UPDATE problems SET lc_num = NULL, title = ?, difficulty = ?, url = ? WHERE slug = ?",
        [problem.title, problem.difficulty, problem.url, problem.slug]
      );
      return result?.affectedRows > 0 ? "upserted" : "unchanged";
    }
  }

  const insertSql =
    "INSERT INTO problems (lc_num, slug, title, difficulty, url, source) VALUES (?, ?, ?, ?, ?, 'leetcode')";
  try {
    const result = await database.query(insertSql, [
      problem.num,
      problem.slug,
      problem.title,
      problem.difficulty,
      problem.url
    ]);
    return result?.affectedRows > 0 ? "upserted" : "unchanged";
  } catch (error) {
    if (error?.code !== "ER_DUP_ENTRY") throw error;
    /* The LeetCode number belongs to another row — keep the slug unique. */
    const fallback = await database.query(insertSql, [
      null,
      problem.slug,
      problem.title,
      problem.difficulty,
      problem.url
    ]);
    return fallback?.affectedRows > 0 ? "upserted" : "unchanged";
  }
};

const storeDescription = async (slug, html) => {
  const sql = OPTIONS.refresh
    ? "UPDATE problems SET description_html = ? WHERE slug = ?"
    : "UPDATE problems SET description_html = ? WHERE slug = ? AND (description_html IS NULL OR description_html = '')";
  const result = await database.query(sql, [html, slug]);
  return (result?.affectedRows || 0) > 0;
};

/* LeetCode numbers must be unique. Correcting them one row at a time can make
   two rows briefly claim the same number, so this runs first, inside one
   transaction: work out every row's final number, clear the rows that change,
   then write the new values. Rows that are not in the official index keep
   their number unless it belongs to a real problem. */
const reconcileNumbers = async (index) => {
  const rows = await database.query("SELECT id, slug, lc_num FROM problems");
  if (!rows.length) return { changed: 0, cleared: 0 };

  const desired = new Map();
  const officialSlugs = new Set();
  rows.forEach((row) => {
    const official = index.get(row.slug);
    if (official && official.num !== null) {
      desired.set(row.id, official.num);
      officialSlugs.add(row.slug);
    } else {
      desired.set(row.id, row.lc_num);
    }
  });

  /* Two rows wanting the same number: the real (indexed) problem wins. */
  const owners = new Map();
  rows.forEach((row) => {
    const num = desired.get(row.id);
    if (num === null || num === undefined) return;
    if (!owners.has(num)) owners.set(num, []);
    owners.get(num).push(row);
  });

  const finalNumbers = new Map();
  owners.forEach((list, num) => {
    if (list.length === 1) {
      finalNumbers.set(list[0].id, num);
      return;
    }
    const preferred = list.find((row) => officialSlugs.has(row.slug)) || list[0];
    list.forEach((row) => finalNumbers.set(row.id, row.id === preferred.id ? num : null));
  });
  rows.forEach((row) => {
    if (!finalNumbers.has(row.id)) finalNumbers.set(row.id, null);
  });

  const changing = rows.filter((row) => (finalNumbers.get(row.id) ?? null) !== (row.lc_num ?? null));
  if (!changing.length) return { changed: 0, cleared: 0 };

  await database.withTransaction(async (run) => {
    for (const row of changing) {
      if (row.lc_num !== null) await run("UPDATE problems SET lc_num = NULL WHERE id = ?", [row.id]);
    }
    for (const row of changing) {
      const value = finalNumbers.get(row.id);
      if (value !== null && value !== undefined) {
        await run("UPDATE problems SET lc_num = ? WHERE id = ?", [value, row.id]);
      }
    }
  });

  return { changed: changing.length, cleared: changing.filter((row) => finalNumbers.get(row.id) === null).length };
};

const runPool = async (items, worker, concurrency) => {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
};

/* --------------------------------- main ---------------------------------- */

const main = async () => {
  const label = OPTIONS.from ? path.resolve(OPTIONS.from) : "lab-notes.js seed list";
  let problems = OPTIONS.from ? readExportProblems(OPTIONS.from) : readSeedProblems();

  if (!problems.length) throw new Error("No problems found in the source.");
  if (OPTIONS.limit > 0) problems = problems.slice(0, OPTIONS.limit);

  /* De-duplicate by slug so one run never fights itself. */
  const seen = new Set();
  problems = problems.filter((problem) => {
    if (seen.has(problem.slug)) return false;
    seen.add(problem.slug);
    return true;
  });

  console.log(`Source: ${label}`);
  console.log(`Problems: ${problems.length}${OPTIONS.dryRun ? " (dry run — no writes)" : ""}`);

  const status = await database.checkDatabase();
  if (!status.ok) {
    console.error(`Database unavailable: ${status.error || "not configured"}`);
    console.error("Check DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME in .env, then run npm run migrate.");
    return 1;
  }

  /* The official index is always requested: it is a single request and it is
     what keeps numbers, titles and difficulties correct in the catalog. */
  const index = await fetchProblemIndex();
  if (index) console.log(`LeetCode index: ${index.size} problems available for verification.`);

  if (!OPTIONS.dryRun && index) {
    const numbers = await reconcileNumbers(index);
    if (numbers.changed) {
      console.log(`LeetCode numbers reconciled: ${numbers.changed} row(s) adjusted${numbers.cleared ? `, ${numbers.cleared} cleared` : ""}.`);
    }
  }

  let inserted = 0;
  let withDescription = 0;
  let descriptionFailures = 0;

  if (!OPTIONS.dryRun) {
    await runPool(
      problems,
      async (problem) => {
        const official = index?.get(problem.slug);
        const record = official
          ? { ...problem, num: official.num ?? problem.num, title: official.title || problem.title, difficulty: official.difficulty }
          : problem;

        const outcome = await insertProblem(record, Boolean(official));
        if (outcome === "upserted") inserted += 1;
      },
      OPTIONS.concurrency
    );
  }

  console.log(`Catalog rows written: ${inserted} (of ${problems.length}).`);

  if (OPTIONS.descriptions) {
    let done = 0;
    await runPool(
      problems,
      async (problem) => {
        done += 1;
        const prefix = `[${String(done).padStart(3)}/${problems.length}] ${problem.slug}`;
        if (OPTIONS.dryRun) {
          const html = await fetchDescription(problem.slug);
          if (html) withDescription += 1;
          else descriptionFailures += 1;
          process.stdout.write(`${prefix} ${html ? "statement ok" : "no statement"}\n`);
          return;
        }
        const html = await fetchDescription(problem.slug);
        if (!html) {
          descriptionFailures += 1;
          process.stdout.write(`${prefix} skipped (no statement)\n`);
          return;
        }
        const stored = await storeDescription(problem.slug, html);
        if (stored) withDescription += 1;
        process.stdout.write(`${prefix} ${stored ? "stored" : "already had a statement"}\n`);
      },
      OPTIONS.concurrency
    );
  }

  console.log("");
  console.log(`Descriptions stored: ${withDescription}`);
  if (descriptionFailures) {
    console.log(`Descriptions skipped: ${descriptionFailures} (LeetCode unavailable or no content).`);
    console.log("Re-run the same command later — the import is repeatable.");
  }
  console.log("Done.");
  return 0;
};

main()
  .then((code) => database.closePool().finally(() => process.exit(code)))
  .catch(async (error) => {
    console.error(`Import failed: ${error?.message || error}`);
    await database.closePool().catch(() => {});
    process.exit(1);
  });
