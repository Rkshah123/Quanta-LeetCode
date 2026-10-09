/* -------------------------- scripts / verify ---------------------------- */
/* Compares the catalog in MySQL against LeetCode's own problem index and
   reports rows whose number, title or difficulty disagree — the signature of
   a bad upsert (or of a locally invented problem).

   Usage:
     node scripts/verify-catalog.js            report only
     node scripts/verify-catalog.js --repair   rewrite disagreeing fields
                                               with LeetCode's official values

   --repair only ever writes data that comes from LeetCode itself; rows that
   are not in the official index (custom / premium-only entries) are left
   untouched. Nothing is deleted. */

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const database = require("../db/pool");

const repair = process.argv.includes("--repair");

const fetchOfficialIndex = async () => {
  const response = await fetch("https://leetcode.com/api/problems/all/", {
    headers: { "User-Agent": "Quanta/1.0 (+catalog verify)" },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`LeetCode responded with HTTP ${response.status}`);
  const payload = await response.json();
  const index = new Map();
  for (const entry of payload.stat_status_pairs || []) {
    const stat = entry.stat;
    if (!stat?.question__title_slug) continue;
    index.set(stat.question__title_slug.toLowerCase(), {
      num: Number(stat.frontend_question_id) || null,
      title: String(stat.question__title || "").trim(),
      difficulty: { 1: "Easy", 2: "Medium", 3: "Hard" }[entry.difficulty?.level] || "Medium"
    });
  }
  return index;
};

(async () => {
  const rows = await database.query(
    "SELECT id, lc_num, slug, title, difficulty, url FROM problems ORDER BY id"
  );
  console.log(`Catalog rows: ${rows.length}`);

  const index = await fetchOfficialIndex();
  console.log(`Official LeetCode index: ${index.size} problems`);

  const mismatches = [];
  const notInIndex = [];

  for (const row of rows) {
    const official = index.get(row.slug);
    if (!official) {
      notInIndex.push(row.slug);
      continue;
    }
    const problems = [];
    if (official.num !== null && row.lc_num !== official.num) {
      problems.push(`number ${row.lc_num} → ${official.num}`);
    }
    if (official.title && row.title !== official.title) {
      problems.push(`title "${row.title}" → "${official.title}"`);
    }
    if (row.difficulty !== official.difficulty) {
      problems.push(`difficulty ${row.difficulty} → ${official.difficulty}`);
    }
    if (problems.length) mismatches.push({ row, official, problems });
  }

  console.log(`Not in the official index (kept as-is): ${notInIndex.length}`);
  if (mismatches.length) {
    console.log(`Mismatches: ${mismatches.length}`);
    mismatches.forEach(({ row, problems }) => console.log(`  ${row.slug}: ${problems.join(", ")}`));
  } else {
    console.log("Mismatches: 0 — every indexed row matches LeetCode.");
  }

  if (repair && mismatches.length) {
    let repaired = 0;
    for (const { row, official } of mismatches) {
      await database.query("UPDATE problems SET lc_num = ?, title = ?, difficulty = ? WHERE id = ?", [
        official.num,
        official.title,
        official.difficulty,
        row.id
      ]);
      repaired += 1;
    }
    console.log(`Repaired rows: ${repaired}`);
  } else if (mismatches.length && !repair) {
    console.log("Run with --repair to rewrite those fields with LeetCode's official values.");
  }

  await database.closePool();
  process.exit(mismatches.length && !repair ? 0 : 0);
})().catch(async (error) => {
  console.error(`Verify failed: ${error?.message || error}`);
  await database.closePool().catch(() => {});
  process.exit(1);
});
