/* How much evaluation evidence does the catalog really hold?

   The panel can only call an answer right when it has a test to run it against.
   Three questions decide how good that can be:

     1. how many statements give a worked example at all
     2. how many give MORE than one, so "all tests pass" means something
     3. whether a harness can be generated per language

   Measured on real rows, not hand-picked fixtures. Read-only.
*/
require("dotenv").config({ quiet: true });
const { query, closePool } = require("../db/pool");
const T = require("../mocktest.js");

const SAMPLE = 300;

(async () => {
  const rows = await query(
    `SELECT slug, platform, description_html
       FROM problems
      WHERE description_html IS NOT NULL AND description_html <> ''
      ORDER BY lc_num IS NULL, lc_num, slug
      LIMIT ?`,
    [SAMPLE]
  );
  console.log(`statements sampled: ${rows.length}\n`);

  let withOne = 0;
  let withMany = 0;
  const counts = new Map();
  let jsHarness = 0;
  let pyHarness = 0;

  for (const row of rows) {
    const all = T.parseAllExamples ? T.parseAllExamples(row.description_html) : [];
    const ex = all.length ? all : T.parseExamples(row.description_html);
    if (!ex.length) continue;
    withOne += 1;
    counts.set(ex.length, (counts.get(ex.length) || 0) + 1);
    if (ex.length > 1) withMany += 1;

    /* Can a harness be built for the shape LeetCode actually serves in each
       language? Tested against real starter code, not a guess at it. */
    if (T.buildJsHarness(JS_STARTER, ex[0])) jsHarness += 1;
    if (T.buildPythonHarness && T.buildPythonHarness(PY_STARTER, ex[0])) pyHarness += 1;
  }

  const pct = (n) => `${((n / rows.length) * 100).toFixed(1)}%`;
  console.log(`at least one worked example : ${withOne}  (${pct(withOne)})`);
  console.log(`more than one example      : ${withMany}  (${pct(withMany)})`);
  console.log(`\nexamples per statement:`);
  for (const [n, c] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${n} example${n > 1 ? "s" : " "}: ${c}`);
  }
  console.log(`\nJavaScript harness buildable : ${jsHarness}  (${pct(jsHarness)})`);
  console.log(`Python harness buildable     : ${pyHarness}  (${pct(pyHarness)})`);

  await closePool();
})().catch((e) => { console.error(e.message); process.exit(1); });

/* The starter code LeetCode actually serves, in each language. */
const JS_STARTER = `var twoSum = function(nums, target) {
};`;
const PY_STARTER = `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        `;