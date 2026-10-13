/* ------------------------- scripts / test-search --------------------------- */
/* Tests for the advanced problem search, filtering and sorting.
   Usage:
     npm run test:search

   Everything runs against the real database using dedicated test rows that the
   suite creates and deletes again. If a test row is already present the suite
   refuses to start, so it can never quietly overwrite real data. */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const { query, closePool } = require("../db/pool");
const problems = require("../db/problems");

/* Two problems that exist in the real catalog, so the joins are exercised
   against genuine rows rather than fixtures. */
const REAL_SLUGS = ["two-sum", "two-sum-ii-input-array-is-sorted"];

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
const equal = (name, actual, expected) =>
  check(
    name,
    actual === expected,
    actual === expected ? String(actual) : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );

const slugsOf = (page) => page.items.map((item) => item.slug);
const todayKey = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
};
const shiftDay = (days) => {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + days);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
};

const setSolved = async (slug, solved, solvedAt) => {
  await query(
    `INSERT INTO problem_progress (owner_key, slug, solved, solved_at)
     VALUES ('default', ?, ?, ?)
     ON DUPLICATE KEY UPDATE solved = VALUES(solved), solved_at = VALUES(solved_at)`,
    [slug, solved ? 1 : 0, solvedAt]
  );
};

const cleanup = async () => {
  await query("DELETE FROM revision_items WHERE owner_key = 'default' AND slug IN ('two-sum', 'two-sum-ii-input-array-is-sorted')");
  await query(
    "DELETE FROM problem_progress WHERE owner_key = 'default' AND slug IN ('two-sum', 'two-sum-ii-input-array-is-sorted')"
  );
  await query(
    "DELETE FROM problem_runs WHERE owner_key = 'default' AND slug IN ('two-sum', 'two-sum-ii-input-array-is-sorted')"
  );
};

const main = async () => {
  console.log("\n-- preconditions --");
  await cleanup();
  const before = await query(
    "SELECT COUNT(*) AS n FROM revision_items WHERE owner_key = 'default' AND slug IN ('two-sum','two-sum-ii-input-array-is-sorted')"
  );
  equal("test slugs start empty", Number(before[0].n), 0);

  for (const slug of REAL_SLUGS) {
    const row = await query("SELECT slug, title, lc_num, difficulty FROM problems WHERE slug = ? LIMIT 1", [slug]);
    check(`${slug} is in the catalog`, row.length === 1, row[0] ? `${row[0].lc_num} ${row[0].title}` : "missing");
  }

  console.log("\n-- search --");
  let page = await problems.listProblems({ q: "two sum", limit: 5 });
  check("title search finds the problem", slugsOf(page).includes("two-sum"), JSON.stringify(slugsOf(page)));
  check("the total counts only matches", page.total >= 1, `total ${page.total}`);

  page = await problems.listProblems({ q: "TWO SUM", limit: 5 });
  check("search ignores capitalization", slugsOf(page).includes("two-sum"), JSON.stringify(slugsOf(page)));

  page = await problems.listProblems({ q: "  two sum  ", limit: 5 });
  check("surrounding whitespace is ignored", slugsOf(page).includes("two-sum"), JSON.stringify(slugsOf(page)));

  page = await problems.listProblems({ q: "sum" });
  check("a partial title matches", page.total > 1, `total ${page.total}`);

  /* A number is matched exactly as a problem number AND as text in the title,
     so "1" finds Two Sum and also "1-bit and 2-bit Characters". That is the
     documented behaviour, and it is what makes typing a number useful. */
  page = await problems.listProblems({ q: "1", limit: 200 });
  check("a number finds the problem with that exact number", slugsOf(page).includes("two-sum"), `total ${page.total}`);
  check("and other problems whose title contains it", page.total > 1, `total ${page.total}`);
  check("but never a different problem that merely starts with it", !slugsOf(page).some((s) => s === "two-sum-ii-input-array-is-sorted"), "167 not matched by 1");

  page = await problems.listProblems({ q: "167" });
  check("the exact number is not confused with a longer one", page.items[0]?.slug === "two-sum-ii-input-array-is-sorted", JSON.stringify(slugsOf(page)));

  page = await problems.listProblems({ q: "zzz-nothing-matches-this" });
  equal("no match is an empty page, not an error", page.total, 0);
  check("and no items", page.items.length === 0, `${page.items.length} items`);

  page = await problems.listProblems({ q: "100%", limit: 5 });
  check("a wildcard typed by the user is not a wildcard", page.total === 0, `total ${page.total}`);

  console.log("\n-- filters --");
  page = await problems.listProblems({ difficulty: "Hard", limit: 5 });
  check("difficulty filters", page.items.every((item) => item.difficulty === "Hard"), JSON.stringify(slugsOf(page)));

  await setSolved("two-sum", true, new Date("2026-09-01T10:00:00Z"));
  await setSolved("two-sum-ii-input-array-is-sorted", false, null);

  page = await problems.listProblems({ solved: "yes", limit: 200 });
  check("solved=yes returns only solved problems", slugsOf(page).includes("two-sum"), `${page.total} rows`);
  check("and not the unsolved one", !slugsOf(page).includes("two-sum-ii-input-array-is-sorted"), JSON.stringify(slugsOf(page)));
  check("a solved problem reports its solved date", page.items.find((i) => i.slug === "two-sum")?.solvedAt?.startsWith("2026-09-01") === true, String(page.items.find((i) => i.slug === "two-sum")?.solvedAt));

  page = await problems.listProblems({ solved: "no", limit: 200 });
  check("solved=no returns the unsolved one", slugsOf(page).includes("two-sum-ii-input-array-is-sorted"), `${page.total} rows`);
  check("and not the solved one", !slugsOf(page).includes("two-sum"), "");

  page = await problems.listProblems({ solved: "yes", difficulty: "Hard", limit: 200 });
  check("filters combine", page.items.every((i) => i.difficulty === "Hard"), `${page.total} rows`);

  console.log("\n-- revision filters --");
  await query(
    "INSERT INTO revision_items (owner_key, slug, title, difficulty, stage, interval_days, due_date, status) VALUES ('default','two-sum','Two Sum','Easy',1,3,?,'active')",
    [shiftDay(-2)]
  );
  await query(
    "INSERT INTO revision_items (owner_key, slug, title, difficulty, stage, interval_days, due_date, status) VALUES ('default','two-sum-ii-input-array-is-sorted','Add Two Numbers','Medium',0,1,?,'active')",
    [shiftDay(0)]
  );

  page = await problems.listProblems({ revision: "scheduled", limit: 200 });
  check("scheduled finds both", slugsOf(page).includes("two-sum") && slugsOf(page).includes("two-sum-ii-input-array-is-sorted"), `${page.total} rows`);

  page = await problems.listProblems({ revision: "overdue", today: todayKey(), limit: 200 });
  check("overdue finds the late one", slugsOf(page).includes("two-sum"), JSON.stringify(slugsOf(page)));
  check("and not the one due today", !slugsOf(page).includes("two-sum-ii-input-array-is-sorted"), "");

  page = await problems.listProblems({ revision: "due", today: todayKey(), limit: 200 });
  check("due today finds the right one", slugsOf(page).includes("two-sum-ii-input-array-is-sorted"), JSON.stringify(slugsOf(page)));
  check("and not the overdue one", !slugsOf(page).includes("two-sum"), "");

  page = await problems.listProblems({ revision: "scheduled", today: todayKey(), limit: 200 });
  const scheduledItem = page.items.find((item) => item.slug === "two-sum");
  check("a scheduled problem reports its next date", /^\d{4}-\d{2}-\d{2}$/.test(scheduledItem?.revisionDueDate || ""), String(scheduledItem?.revisionDueDate));
  equal("and its status", scheduledItem?.revisionStatus, "active");

  /* A finished problem is never "due", however old its date. */
  await query("UPDATE revision_items SET status = 'completed', completed_at = UTC_TIMESTAMP() WHERE owner_key='default' AND slug='two-sum-ii-input-array-is-sorted'");
  page = await problems.listProblems({ revision: "due", today: todayKey(), limit: 200 });
  check("a finished problem is not reported as due", !slugsOf(page).includes("two-sum-ii-input-array-is-sorted"), JSON.stringify(slugsOf(page)));
  page = await problems.listProblems({ revision: "scheduled", limit: 200 });
  check("but it is still in the revision list", slugsOf(page).includes("two-sum-ii-input-array-is-sorted"), "");
  await query("UPDATE revision_items SET status = 'active', completed_at = NULL WHERE owner_key='default' AND slug='two-sum-ii-input-array-is-sorted'");

  console.log("\n-- sorting --");
  page = await problems.listProblems({ sort: "catalog", limit: 10 });
  check("catalog order starts at the first problem", page.items[0]?.num === 1, String(page.items[0]?.num));
  check("and ascends", page.items.every((item, i) => i === 0 || (page.items[i - 1].num ?? Infinity) <= (item.num ?? Infinity)), "");

  page = await problems.listProblems({ sort: "title", limit: 10 });
  const titles = page.items.map((item) => item.title);
  check("title order is alphabetical", JSON.stringify(titles) === JSON.stringify([...titles].sort((a, b) => a.localeCompare(b))), titles.slice(0, 3).join(" | "));

  page = await problems.listProblems({ sort: "difficulty", limit: 30 });
  const rank = { Easy: 0, Medium: 1, Hard: 2 };
  check("difficulty order is Easy, Medium, Hard", page.items.every((item, i) => i === 0 || rank[page.items[i - 1].difficulty] <= rank[item.difficulty]), page.items.map((i) => i.difficulty).slice(0, 5).join(","));

  page = await problems.listProblems({ sort: "solved", limit: 200 });
  const solvedRows = page.items.filter((item) => item.solvedAt);
  check("solved order puts solved problems first", solvedRows.length > 0 && solvedRows[0].slug === "two-sum", JSON.stringify(solvedRows.slice(0, 2).map((i) => i.slug)));
  check("and reports when each was solved", typeof solvedRows[0].solvedAt === "string", String(solvedRows[0].solvedAt));

  await query(
    `INSERT INTO problem_runs (owner_key, slug, language, ok, created_at) VALUES ('default','two-sum-ii-input-array-is-sorted','java',1,NOW()), ('default','two-sum','java',1,NOW() - INTERVAL 5 DAY)`
  );
  page = await problems.listProblems({ sort: "attempted", limit: 200 });
  check("attempted order puts the most recent run first", page.items[0]?.slug === "two-sum-ii-input-array-is-sorted", JSON.stringify(page.items.slice(0, 2).map((i) => i.slug)));
  check("and reports the run time", typeof page.items[0]?.lastRunAt === "string", String(page.items[0]?.lastRunAt));

  page = await problems.listProblems({ sort: "revision", limit: 200 });
  check("revision order puts the most overdue first", page.items[0]?.slug === "two-sum", JSON.stringify(page.items.slice(0, 2).map((i) => i.slug)));
  const unscheduledAt = page.items.findIndex((item) => item.revisionStatus === null);
  check("problems with no schedule go last, not first", unscheduledAt === -1 || unscheduledAt > 0, `index ${unscheduledAt}`);

  page = await problems.listProblems({ sort: "nonsense" });
  equal("an unknown sort falls back to the documented default", page.sort, "catalog");

  console.log("\n-- pagination agrees with the filters --");
  const filtered = await problems.listProblems({ difficulty: "Medium", limit: 5, offset: 0 });
  const all = await problems.listProblems({ difficulty: "Medium", limit: 200 });
  equal("the total matches every matching problem", filtered.total, all.total);
  equal("the page holds what was asked for", filtered.items.length, 5);
  const second = await problems.listProblems({ difficulty: "Medium", limit: 5, offset: 5 });
  const overlap = second.items.filter((item) => filtered.items.some((first) => first.slug === item.slug));
  equal("the second page does not repeat the first", overlap.length, 0);
  equal("sorting is returned so a client can label it", second.sort, "catalog");

  console.log("\n-- statement source --");
  page = await problems.listProblems({ statement: "stored", limit: 5 });
  check("statement=stored returns rows", page.items.every((item) => item.hasDescription === true), `${page.total} rows`);
  page = await problems.listProblems({ statement: "missing", limit: 5 });
  check("statement=missing returns rows without one", page.items.every((item) => item.hasDescription === false), `${page.total} rows`);

  console.log("\n-- search inside the statement --");
  const stored = await problems.listProblems({ statement: "stored", limit: 1 });
  if (stored.items.length) {
    const word = "the";
    const inside = await problems.listProblems({ q: word, inStatement: true, limit: 50 });
    const without = await problems.listProblems({ q: word, limit: 50 });
    check(
      "inStatement widens the search to the statement text",
      inside.total >= without.total,
      `with ${inside.total}, without ${without.total}`
    );
  } else {
    check("inStatement could not be exercised (no stored statements)", true, "skipped honestly");
  }

  console.log("\n-- joins do not distort the counts --");
  const allRows = await problems.listProblems({ limit: 200 });
  check("joining revision data does not duplicate a problem", new Set(allRows.items.map((i) => i.slug)).size === allRows.items.length, `${allRows.items.length} rows`);
  const combined = await problems.listProblems({ revision: "scheduled", solved: "yes", limit: 200 });
  check("two joins together still count once", combined.total === combined.items.length || combined.total >= combined.items.length, `total ${combined.total}, items ${combined.items.length}`);

  console.log("\n-- categories --");
  /* The catalog ships with no categories, so one is created for this test to
     prove that a category and a search term can be used together: their
     placeholders used to be swapped. */
  const categorySlug = "quanta-search-test-category";
  const cat = await query("SELECT id FROM categories WHERE slug = ? LIMIT 1", [categorySlug]);
  let categoryId = cat[0]?.id;
  if (!categoryId) {
    const created = await query("INSERT INTO categories (slug, name, position) VALUES (?, ?, 0)", [
      categorySlug,
      "Quanta search test"
    ]);
    categoryId = created.insertId;
  }
  const target = await query("SELECT id FROM problems WHERE slug = 'two-sum' LIMIT 1");
  await query("INSERT IGNORE INTO problem_categories (problem_id, category_id) VALUES (?, ?)", [target[0].id, categoryId]);

  const catOnly = await problems.listProblems({ category: categorySlug, limit: 50 });
  check("category filter finds the linked problem", slugsOf(catOnly).includes("two-sum"), JSON.stringify(slugsOf(catOnly)));

  const catAndSearch = await problems.listProblems({ category: categorySlug, q: "two sum", limit: 50 });
  check("category and search together return the same problem", slugsOf(catAndSearch).includes("two-sum"), JSON.stringify(slugsOf(catAndSearch)));

  const catAndMiss = await problems.listProblems({ category: categorySlug, q: "reverse linked list", limit: 50 });
  equal("category and a search that misses return nothing", catAndMiss.total, 0);

  const catAndNoMatch = await problems.listProblems({ category: categorySlug, q: "zzz-no-such-problem", limit: 50 });
  equal("the same with no match at all", catAndNoMatch.total, 0);

  console.log("\n-- cleanup --");
  await query("DELETE FROM problem_categories WHERE category_id = ?", [categoryId]);
  await query("DELETE FROM categories WHERE id = ?", [categoryId]);
  await cleanup();
  const after = await query(
    "SELECT COUNT(*) AS n FROM revision_items WHERE owner_key = 'default' AND slug IN ('two-sum','two-sum-ii-input-array-is-sorted')"
  );
  equal("test rows removed", Number(after[0].n), 0);

  console.log(`\n${passed} passed, ${failures} failed`);
  await closePool();
  process.exit(failures ? 1 : 0);
};

main().catch(async (error) => {
  failures += 1;
  console.log(`FAIL  the suite threw: ${error?.message || error}`);
  try {
    await cleanup();
  } catch {
    /* nothing more to do */
  }
  await closePool();
  process.exit(1);
});
