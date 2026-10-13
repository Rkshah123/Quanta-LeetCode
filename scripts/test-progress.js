/* -------------------------- scripts / test-progress ----------------------- */
/* Tests for the coding progress dashboard.
   Usage:
     npm run test:progress
     node scripts/test-progress.js --keep-rows   (skip cleanup, for debugging)

   Two layers:
     1. Pure functions (streaks, calendar keys, series, comparisons) with
        fixed fixtures - no database, deterministic, no timezone surprises.
     2. The real SQL path against the actual database, using dedicated test
        slugs ("quanta-progress-test-*"). The test asserts those rows do not
        exist before it starts and removes exactly the rows it created, so real
        progress data is never touched. */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const { query, closePool } = require("../db/pool");
const progress = require("../db/progress");

const TEST_SLUGS = [
  "quanta-progress-test-a",
  "quanta-progress-test-b",
  "quanta-progress-test-c",
  "quanta-progress-test-d",
  "quanta-progress-test-e"
];

const keepRows = process.argv.includes("--keep-rows");
let failures = 0;
let passed = 0;

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
  check(name, actual === expected, actual === expected ? String(actual) : `expected ${expected}, got ${actual}`);

/* Builds a count map from {day: count} pairs, like the repository does. */
const counts = (entries) => new Map(Object.entries(entries));

/* ------------------------- 1. pure unit tests --------------------------- */

const testPureFunctions = () => {
  const { normalizeSlug, normalizeTzOffset, normalizeDays, toDayKey, shiftDayKey, isoWeekKey, computeStreaks, comparePeriods } = progress;

  console.log("\n-- validation --");
  equal("slug: lowercase + dashes kept", normalizeSlug("Two-Sum"), "two-sum");
  equal("slug: leading/trailing space trimmed", normalizeSlug("  two-sum  "), "two-sum");
  equal("slug: spaces rejected", normalizeSlug("two sum"), "");
  equal("slug: symbols rejected", normalizeSlug("two_sum!"), "");
  equal("slug: empty rejected", normalizeSlug(""), "");
  equal("tz: +330 kept", normalizeTzOffset(330), 330);
  equal("tz: non-number becomes 0", normalizeTzOffset("abc"), 0);
  equal("tz: out of range clamped", normalizeTzOffset(99999), 840);
  equal("days: default 365", normalizeDays(undefined), 365);
  equal("days: minimum 30", normalizeDays(1), 30);
  equal("days: maximum 730", normalizeDays(5000), 730);

  console.log("\n-- calendar keys --");
  equal("day key from Date", toDayKey(new Date(Date.UTC(2026, 2, 9))), "2026-03-09");
  equal("day key pads month/day", toDayKey(new Date(Date.UTC(2026, 10, 1))), "2026-11-01");
  equal("shift across month end", shiftDayKey("2026-03-31", 1), "2026-04-01");
  equal("shift backwards across month start", shiftDayKey("2026-03-01", -1), "2026-02-28");
  equal("shift across year end", shiftDayKey("2026-12-31", 1), "2027-01-01");
  equal("shift is DST-proof (UTC math)", shiftDayKey("2026-03-29", 1), "2026-03-30");
  equal("iso week of a Monday", isoWeekKey("2026-03-09"), "2026-W11");
  equal("iso week: Sunday belongs to the week that started Monday", isoWeekKey("2026-03-15"), "2026-W11");
  equal("iso week: next Monday moves on", isoWeekKey("2026-03-16"), "2026-W12");

  console.log("\n-- streaks --");
  const today = "2026-03-10";
  let result = computeStreaks(counts({}), today);
  equal("no activity: current 0", result.current, 0);
  equal("no activity: longest 0", result.longest, 0);

  result = computeStreaks(counts({ [today]: 1 }), today);
  equal("solved today: current 1", result.current, 1);
  equal("solved today: longest 1", result.longest, 1);

  result = computeStreaks(counts({ [today]: 2, [shiftDayKey(today, -1)]: 1, [shiftDayKey(today, -2)]: 3 }), today);
  equal("three days ending today: current 3", result.current, 3);
  equal("three days ending today: longest 3", result.longest, 3);

  /* The day is not over: a streak that ended yesterday is still alive today. */
  result = computeStreaks(counts({ [shiftDayKey(today, -1)]: 1, [shiftDayKey(today, -2)]: 1 }), today);
  equal("ended yesterday: current still counts", result.current, 2);

  result = computeStreaks(counts({ [shiftDayKey(today, -2)]: 1, [shiftDayKey(today, -3)]: 1 }), today);
  equal("gap before yesterday breaks it: current 0", result.current, 0);
  equal("gap before yesterday keeps longest 2", result.longest, 2);

  result = computeStreaks(
    counts({
      [shiftDayKey(today, -1)]: 1,
      [shiftDayKey(today, -2)]: 1,
      [shiftDayKey(today, -3)]: 1,
      [shiftDayKey(today, -4)]: 1,
      [shiftDayKey(today, -5)]: 1,
      [shiftDayKey(today, -7)]: 1,
      [shiftDayKey(today, -8)]: 1
    }),
    today
  );
  equal("two separate runs: longest 5", result.longest, 5);
  equal("two separate runs: current 5 (latest)", result.current, 5);

  result = computeStreaks(counts({ [shiftDayKey(today, -40)]: 1, [shiftDayKey(today, -39)]: 1, [shiftDayKey(today, -38)]: 1 }), today);
  equal("old run is history, not current", result.current, 0);
  equal("old run still counts as longest", result.longest, 3);

  console.log("\n-- period comparison --");
  equal("comparison: delta", comparePeriods(5, 3).delta, 2);
  equal("comparison: percent", comparePeriods(5, 3).percent, 67);
  equal("comparison: drop is negative", comparePeriods(2, 4).percent, -50);
  check("comparison: zero previous has no percent", comparePeriods(3, 0).percent === null);

  console.log("\n-- dense series (no phantom days) --");
  const map = counts({ "2026-03-10": 2, "2026-03-08": 1 });
  const daily = progress.buildDailySeries(map, 7, "2026-03-10");
  equal("daily series length equals requested days", daily.length, 7);
  equal("daily series is oldest first", daily[0].day, "2026-03-04");
  equal("missing days are zero, not absent", daily[3].count, 0);
  equal("activity lands on its own day", daily[6].count, 2);

  const weekly = progress.buildWeeklySeries(map, 4, "2026-03-10");
  equal("weekly series length", weekly.length, 4);
  check("weekly buckets are ordered", weekly.every((w, i) => i === 0 || w.start > weekly[i - 1].start));

  const monthly = progress.buildMonthlySeries(map, 3, "2026-03-10");
  equal("monthly series length", monthly.length, 3);
  equal("last month bucket holds the activity", monthly[2].count, 3);
};

/* ---------------------- 2. database-backed tests ------------------------ */

const existingTestRows = async () => {
  const rows = await query(
    "SELECT slug FROM problem_progress WHERE owner_key = ? AND slug IN (?)",
    [progress.PROGRESS_OWNER, TEST_SLUGS]
  );
  return rows.map((row) => row.slug);
};

const removeTestRows = async () => {
  await query("DELETE FROM problem_progress WHERE owner_key = ? AND slug IN (?)", [progress.PROGRESS_OWNER, TEST_SLUGS]);
  await query("DELETE FROM problem_runs WHERE owner_key = ? AND slug IN (?)", [progress.PROGRESS_OWNER, TEST_SLUGS]);
};

const testRepository = async () => {
  console.log("\n-- database: preconditions --");
  const before = await existingTestRows();
  check(
    "test slugs are free before the run",
    before.length === 0,
    before.length ? `already present: ${before.join(", ")}` : ""
  );
  if (before.length) throw new Error("Refusing to run: test rows already exist.");

  const baseline = await progress.getSummary({});
  equal("baseline solved is the count before the test", baseline.solved.total, 0);

  console.log("\n-- database: mark solved --");
  const marked = await progress.markSolved({
    slug: TEST_SLUGS[0],
    title: "Test Problem A",
    num: 900001,
    difficulty: "Easy",
    solved: true
  });
  check("markSolved returns the stored row", marked?.slug === TEST_SLUGS[0]);
  equal("markSolved reports solved", marked?.solved, true);
  check("markSolved stamps solved_at", Boolean(marked?.solvedAt));
  equal("difficulty is stored", marked?.difficulty, "Easy");

  /* Marking the same problem again must not move the original date, or a stray
     double click would silently rewrite a streak. */
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const remarked = await progress.markSolved({
    slug: TEST_SLUGS[0],
    title: "Test Problem A",
    num: 900001,
    difficulty: "Easy",
    solved: true
  });
  equal("re-marking keeps the first solved_at", remarked.solvedAt, marked.solvedAt);

  await progress.markSolved({ slug: TEST_SLUGS[1], title: "Test Problem B", num: 900002, difficulty: "Hard", solved: true });
  await progress.markSolved({ slug: TEST_SLUGS[2], title: "Test Problem C", num: 900003, difficulty: "Medium", solved: true });

  /* A problem that is not in the catalog still counts as solved, but must not
     distort the catalog completion percentage. */
  await progress.markSolved({ slug: TEST_SLUGS[3], title: "Outside catalog", difficulty: "Easy", solved: true });

  const afterSolve = await progress.getSummary({});
  equal("four problems solved", afterSolve.solved.total, 4);
  /* None of the test slugs exist in the problems table, so all four must be
     reported as outside the catalog and must not move the percentage. */
  equal("solved problems outside the catalog are counted separately", afterSolve.solved.outsideCatalog, 4);
  equal("completion percent uses the catalog only", afterSolve.catalog.completionPercent, 0);
  equal("catalog solved count stays 0", afterSolve.catalog.solved, 0);
  equal("catalog total unchanged by progress", afterSolve.catalog.total, baseline.catalog.total);
  equal("unsolved = total - solved", afterSolve.catalog.unsolved, afterSolve.catalog.total - afterSolve.catalog.solved);
  equal("easy solved counted", afterSolve.solved.byDifficulty.find((r) => r.difficulty === "Easy").solved, 2);
  equal("easy in-catalog count stays 0", afterSolve.solved.byDifficulty.find((r) => r.difficulty === "Easy").solvedInCatalog, 0);
  equal("hard solved counted", afterSolve.solved.byDifficulty.find((r) => r.difficulty === "Hard").solved, 1);
  check("today counts at least one solve", afterSolve.solved.today >= 1, `today=${afterSolve.solved.today}`);
  check("current streak counts today", afterSolve.streaks.current >= 1, `current=${afterSolve.streaks.current}`);
  equal("longest streak is at least the current one", afterSolve.streaks.longest >= afterSolve.streaks.current, true);

  console.log("\n-- database: calendar and timezone --");
  /* A fixed timestamp near midnight: the same solved moment belongs to a
     different calendar day depending on the caller's timezone. */
  await query(
    "INSERT INTO problem_progress (owner_key, slug, lc_num, title, difficulty, solved, solved_at) VALUES (?, ?, ?, ?, ?, 1, '2026-03-10 23:30:00')",
    [progress.PROGRESS_OWNER, TEST_SLUGS[4], 900004, "Test Problem D", "Easy"]
  );

  const utcView = await progress.getSummary({ tzOffsetMinutes: 0 });
  const plusOneView = await progress.getSummary({ tzOffsetMinutes: 60 });
  const utcDay = utcView.activity.daily.find((entry) => entry.day === "2026-03-10");
  const shiftedDay = plusOneView.activity.daily.find((entry) => entry.day === "2026-03-11");
  check("UTC view buckets 23:30 on the same day", (utcDay?.count || 0) >= 1, `count=${utcDay?.count}`);
  check("UTC+1 view moves it to the next day", (shiftedDay?.count || 0) >= 1, `count=${shiftedDay?.count}`);
  check(
    "the solve is counted exactly once in each view",
    utcDay?.count === shiftedDay?.count,
    `utc=${utcDay?.count} +1=${shiftedDay?.count}`
  );
  equal("series respects the requested length", utcView.activity.daily.length, 365);

  console.log("\n-- database: duplicate protection --");
  /* Re-marking the same problem many times must never inflate the solved count. */
  for (let i = 0; i < 3; i += 1) {
    await progress.markSolved({ slug: TEST_SLUGS[0], title: "Test Problem A", num: 900001, difficulty: "Easy", solved: true });
  }
  const afterDuplicates = await progress.getSummary({});
  equal("duplicate marks do not double-count", afterDuplicates.solved.total, 5);
  const listRows = await progress.listSolved();
  const slugs = listRows.map((row) => row.slug);
  equal("no duplicate slugs in the solved list", new Set(slugs).size, slugs.length);
  equal("solved list matches the summary", listRows.length, afterDuplicates.solved.total);

  console.log("\n-- database: unmark --");
  await progress.markSolved({ slug: TEST_SLUGS[0], title: "Test Problem A", num: 900001, difficulty: "Easy", solved: false });
  const afterUnmark = await progress.getSummary({});
  equal("unmarking removes it from the total", afterUnmark.solved.total, 4);
  check("unmarking removes it from the list", !(await progress.listSolved()).some((row) => row.slug === TEST_SLUGS[0]));
  const unmarkRow = await query(
    "SELECT solved_at FROM problem_progress WHERE owner_key = ? AND slug = ?",
    [progress.PROGRESS_OWNER, TEST_SLUGS[0]]
  );
  check("unmarking clears solved_at", unmarkRow[0]?.solved_at === null);

  console.log("\n-- database: activity pagination --");
  const page1 = await progress.listActivity({ limit: 2, offset: 0 });
  equal("page size honoured", page1.items.length, 2);
  equal("total reflects all solved", page1.total, 4);
  check("newest first", page1.items[0].solvedAt >= page1.items[1].solvedAt);
  const page2 = await progress.listActivity({ limit: 2, offset: 2 });
  check("pages do not overlap", !page2.items.some((row) => page1.items.some((first) => first.slug === row.slug)));
  const capped = await progress.listActivity({ limit: 9999, offset: 0 });
  check("limit is capped", capped.limit <= 50, `limit=${capped.limit}`);

  console.log("\n-- database: run history --");
  const runsBefore = await progress.getSummary({}).then((s) => s.runs.total);
  await progress.recordRun({ slug: TEST_SLUGS[1], num: 900002, language: "java", status: "Completed", ok: true, durationMs: 1234 });
  await progress.recordRun({ slug: TEST_SLUGS[1], num: 900002, language: "java", status: "Compile Error", ok: false, durationMs: null });
  const afterRuns = await progress.getSummary({});
  equal("two runs recorded", afterRuns.runs.total - runsBefore, 2);
  equal("one run counted as successful", afterRuns.runs.successful - (afterRuns.runs.total - runsBefore - 1) >= 0, true);
  check("failed runs counted", afterRuns.runs.failed >= 1, `failed=${afterRuns.runs.failed}`);
  check("run note explains what a run is", /browser/i.test(afterRuns.runs.note));
  /* Runs are never allowed to invent solved problems. */
  equal("runs do not change the solved count", afterRuns.solved.total, 4);

  console.log("\n-- database: empty state --");
  /* How many runs the summary reported before any of this suite's rows went in.
     Recorded rather than assumed to be zero: a run made in the general Lab has
     no problem slug, is real usage, and is deliberately never deleted by
     removeTestRows. Asserting a global zero made this suite fail on any
     database where somebody had actually used the app - which is the normal
     case, and which is not a defect. */
  const runsPreExisting = runsBefore;
  await removeTestRows();
  const empty = await progress.getSummary({});
  equal("no progress: solved 0", empty.solved.total, 0);
  equal("no progress: streak 0", empty.streaks.current, 0);
  equal(
    "the suite's own runs are gone",
    empty.runs.total,
    runsPreExisting,
    `expected only the ${runsPreExisting} pre-existing run(s) to remain`
  );
  /* And they really are the suite's rows that went, rather than something else
     having been deleted to make the number fit. */
  const leftBehind = await query(
    "SELECT slug FROM problem_runs WHERE owner_key = ? AND slug IN (?)",
    [progress.PROGRESS_OWNER, TEST_SLUGS]
  );
  equal("no test run row survives", leftBehind.length, 0, JSON.stringify(leftBehind));
  const progressLeft = await query(
    "SELECT slug FROM problem_progress WHERE owner_key = ? AND slug IN (?)",
    [progress.PROGRESS_OWNER, TEST_SLUGS]
  );
  equal("no test progress row survives", progressLeft.length, 0, JSON.stringify(progressLeft));
  equal("no progress: completion 0%", empty.catalog.completionPercent, 0);
  check("no progress: catalog still reported", empty.catalog.total > 0, `catalog=${empty.catalog.total}`);
  check("no progress: no solved_at", empty.streaks.firstSolvedAt === null);
};

const main = async () => {
  testPureFunctions();
  try {
    await testRepository();
  } catch (error) {
    failures += 1;
    console.log(`FAIL  database tests threw: ${error?.message || error}`);
  } finally {
    if (!keepRows) {
      try {
        await removeTestRows();
        console.log("\ncleanup: test rows removed");
      } catch (error) {
        console.log(`\ncleanup failed: ${error?.message || error}`);
      }
    } else {
      console.log("\ncleanup skipped (--keep-rows)");
    }
    await closePool();
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
};

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});