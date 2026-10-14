/* How much of the catalog can actually be evaluated?

   A coding question can only be marked right or wrong where the statement is
   stored, because the worked examples are read out of it. This is what decides
   how often a mock test can give a real verdict rather than an honest "unable
   to evaluate". Read-only.
*/
require("dotenv").config({ quiet: true });
const { query, closePool } = require("../db/pool");
const T = require("../mocktest.js");

(async () => {
  const byPlatform = await query(`
    SELECT platform,
           COUNT(*) AS total,
           SUM(CASE WHEN description_html IS NOT NULL AND description_html <> '' THEN 1 ELSE 0 END) AS with_statement
      FROM problems
     GROUP BY platform`);
  console.log("platform".padEnd(14) + "total".padStart(7) + "with statement".padStart(16));
  let total = 0;
  let withStmt = 0;
  for (const row of byPlatform) {
    console.log(String(row.platform).padEnd(14) + String(row.total).padStart(7) + String(row.with_statement).padStart(16));
    total += Number(row.total);
    withStmt += Number(row.with_statement);
  }
  console.log("TOTAL".padEnd(14) + String(total).padStart(7) + String(withStmt).padStart(16));
  console.log(`\n${((withStmt / total) * 100).toFixed(1)}% of the catalog has a statement stored.`);

  const shapes = await query(`
    SELECT slug, description_html FROM problems
     WHERE description_html IS NOT NULL AND description_html <> ''
     ORDER BY lc_num IS NULL, lc_num LIMIT 400`);
  let withExample = 0;
  let totalExamples = 0;
  for (const row of shapes) {
    const found = T.parseAllExamples(row.description_html);
    if (found.length) withExample += 1;
    totalExamples += found.length;
  }
  const parseRate = withExample / shapes.length;
  console.log(`${(parseRate * 100).toFixed(1)}% of stored statements yield a usable worked example (of ${shapes.length} sampled, ${totalExamples} examples in total).`);
  console.log(`Combined: ${((withStmt / total) * parseRate * 100).toFixed(1)}% of randomly chosen coding questions can be marked right or wrong.`);

  await closePool();
})().catch((e) => { console.error(e.message); process.exit(1); });