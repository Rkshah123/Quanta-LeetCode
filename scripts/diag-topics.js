/* Why does the unfiltered catalog come back with empty topics?

   The facets endpoint counts 930 Heaps, so topics exist somewhere. The list
   endpoint returns []. This checks whether the difference is the platform:
   Codeforces rows imported with real topics, LeetCode rows left empty.

   Read-only. It SELECTs and prints counts. */
require("dotenv").config();
const { query } = require("../db/pool");

(async () => {
  const byPlatform = await query(
    `SELECT platform,
            COUNT(*) AS total,
            SUM(CASE WHEN topics IS NULL OR topics = '' OR topics = '[]' THEN 1 ELSE 0 END) AS no_topics,
            SUM(CASE WHEN topics IS NOT NULL AND topics <> '' AND topics <> '[]' THEN 1 ELSE 0 END) AS with_topics
       FROM problems
      GROUP BY platform`
  );
  console.log("platform            total  with_topics  no_topics");
  for (const r of byPlatform) {
    console.log(
      `${String(r.platform).padEnd(18)} ${String(r.total).padStart(5)} ${String(r.with_topics).padStart(12)} ${String(r.no_topics).padStart(9)}`
    );
  }

  const sample = await query(
    `SELECT platform, slug, title, topics FROM problems
      WHERE platform = 'leetcode' AND (topics IS NOT NULL AND topics <> '' AND topics <> '[]')
      LIMIT 5`
  );
  console.log(`\nLeetCode rows that DO have topics: ${sample.length}`);
  for (const r of sample) console.log(`  ${r.slug}: ${String(r.topics).slice(0, 80)}`);

  const cfSample = await query(
    `SELECT slug, title, topics FROM problems WHERE platform = 'codeforces' LIMIT 3`
  );
  console.log("\nCodeforces sample:");
  for (const r of cfSample) console.log(`  ${r.slug}: ${String(r.topics).slice(0, 90)}`);

  /* What does the raw column actually look like for a LeetCode row? If it held
     a non-JSON string, parseJson would silently return [] and this would be a
     parsing bug rather than a data gap. */
  const raw = await query(`SELECT slug, topics, JSON_VALID(topics) AS valid FROM problems WHERE platform = 'leetcode' LIMIT 5`);
  console.log("\nRaw LeetCode topics column:");
  for (const r of raw) console.log(`  ${r.slug}: valid=${r.valid} value=${JSON.stringify(r.topics)}`);

  const counts = await query(
    `SELECT COUNT(*) AS n FROM problems WHERE platform = 'leetcode'`
  );
  console.log(`\nTotal LeetCode rows: ${counts[0].n}`);
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
