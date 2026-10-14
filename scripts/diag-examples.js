/* How often does the worked-example check actually work on real statements?

   The check is only useful if it fires on a decent share of the catalog, and it
   is only safe if it stays silent when it cannot be sure. This measures both on
   real rows rather than on hand-picked fixtures.

   Read-only. */
require("dotenv").config({ quiet: true });
const { query, closePool } = require("../db/pool");
const T = require("../mocktest.js");

const SAMPLE = 300;

(async () => {
  const rows = await query(
    `SELECT slug, title, platform, description_html
       FROM problems
      WHERE description_html IS NOT NULL AND description_html <> ''
      ORDER BY lc_num IS NULL, lc_num, slug
      LIMIT ?`,
    [SAMPLE]
  );
  console.log(`statements sampled: ${rows.length}\n`);

  let withExamples = 0;
  let withHarness = 0;
  const shapes = new Map();
  const refusals = [];

  for (const row of rows) {
    const examples = T.parseExamples(row.description_html);
    if (!examples.length) continue;
    withExamples += 1;
    const ex = examples[0];
    /* Whether a JavaScript function could be wrapped for it. The submitted code
       is what matters, so this is a capability question about the example, not a
       claim about any particular answer. */
    const harness = T.buildJsHarness("var f = function(a){return a;};", ex);
    if (harness) withHarness += 1;
    const shape = ex.expected.startsWith("[") ? "array" : ex.expected.startsWith("{") ? "object" : /^["']/.test(ex.expected) ? "string" : /^(true|false)/.test(ex.expected) ? "bool" : "number";
    shapes.set(shape, (shapes.get(shape) || 0) + 1);
    if (harness && refusals.length < 5) refusals.push({ slug: row.slug, expected: ex.expected });
  }

  const pct = (n) => `${((n / rows.length) * 100).toFixed(1)}%`;
  console.log(`statements that yielded a usable example : ${withExamples}  (${pct(withExamples)})`);
  console.log(`  and a runnable JavaScript check        : ${withHarness}  (${pct(withHarness)})`);
  console.log(`\nanswer shapes found:`);
  for (const [shape, n] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${shape.padEnd(8)} ${n}`);
  }
  if (refusals.length) {
    console.log("\nsample of what it would check:");
    for (const r of refusals) console.log(`  ${r.slug}: expected ${r.expected}`);
  }

  /* The safety property that matters most: never a verdict it is not sure of. */
  console.log("\nsafety checks:");
  console.log(`  no marker in output  -> not checked: ${JSON.stringify(T.compareOutput("boom\n", "[1]"))}`);
  console.log(`  harness crashes     -> not checked: ${JSON.stringify(T.compareOutput("", "[1]"))}`);
  console.log(`  prose expected      -> refused    : ${T.parseExamples("<pre>Input: a = [1]\nOutput: see below</pre>").length === 0}`);

  await closePool();
})().catch((e) => { console.error(e.message); process.exit(1); });
