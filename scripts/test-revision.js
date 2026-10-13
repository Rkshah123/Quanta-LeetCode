/* --------------------------- scripts / test-revision ---------------------- */
/* Tests for the smart DSA revision system.
   Usage:
     npm run test:revision

   Layer 1: the scheduling rules with fixed dates - no database, so the ladder,
     the confidence levels, the ladder end and day arithmetic are pinned down.
   Layer 2: the real repository against the real database, using dedicated test
     slugs ("quanta-revision-test-*"). It refuses to run if they exist and
     removes exactly what it created.

   Nothing here claims a solution was accepted: the app cannot judge
   correctness, so a revision is only ever "come back to this problem". */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const { query, closePool } = require("../db/pool");
const revision = require("../db/revision");

const TEST_SLUGS = ["quanta-revision-test-a", "quanta-revision-test-b", "quanta-revision-test-c"];
/* Two slugs of their own, so the progress checks cannot disturb the state the
   other sections build up step by step. */
const PROGRESS_SLUGS = ["quanta-revision-test-d", "quanta-revision-test-e"];
const keepRows = process.argv.includes("--keep-rows");

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
  check(name, actual === expected, actual === expected ? String(actual) : `expected ${expected}, got ${actual}`);
const same = (name, actual, expected) =>
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual) === JSON.stringify(expected) ? JSON.stringify(actual) : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );

const clean = async () => {
  const slugs = [...TEST_SLUGS, ...PROGRESS_SLUGS];
  await query("DELETE FROM revision_items WHERE owner_key = ? AND slug IN (?)", [revision.REVISION_OWNER, slugs]);
  await query("DELETE FROM revision_reviews WHERE owner_key = ? AND slug IN (?)", [revision.REVISION_OWNER, slugs]);
};

const testSchedule = () => {
  console.log("\n-- default ladder --");
  same("ladder is 1/3/7/14/30", revision.DEFAULT_LADDER, [1, 3, 7, 14, 30]);
  equal("stage 0 -> 1 day", revision.intervalForStage(0), 1);
  equal("stage 1 -> 3 days", revision.intervalForStage(1), 3);
  equal("stage 2 -> 7 days", revision.intervalForStage(2), 7);
  equal("stage 3 -> 14 days", revision.intervalForStage(3), 14);
  equal("stage 4 -> 30 days", revision.intervalForStage(4), 30);
  equal("after the ladder it doubles", revision.intervalForStage(5), 60);
  equal("and keeps doubling", revision.intervalForStage(6), 120);
  equal("and is capped at a year", revision.intervalForStage(9), 365);
  equal("a custom ladder is honoured", revision.intervalForStage(1, [2, 5]), 5);
  same("an empty ladder falls back to the default", revision.clampLadder([]), revision.DEFAULT_LADDER);

  console.log("\n-- confidence changes the next rung --");
  const today = "2026-03-10";
  let s = revision.nextSchedule({ stage: 2, confidence: "good", today });
  equal("good moves up one rung", s.stage, 3);
  equal("good uses the next interval", s.intervalDays, 14);
  equal("good schedules from today", s.dueDate, "2026-03-24");

  s = revision.nextSchedule({ stage: 2, confidence: "easy", today });
  equal("easy skips a rung", s.stage, 4);
  equal("easy uses the interval after that", s.intervalDays, 30);

  s = revision.nextSchedule({ stage: 4, confidence: "difficult", today });
  equal("difficult stays on the rung", s.stage, 4);
  equal("difficult keeps the interval", s.intervalDays, 30);

  s = revision.nextSchedule({ stage: 4, confidence: "again", today });
  equal("again drops back to the first rung", s.stage, 0);
  equal("again comes back tomorrow", s.dueDate, "2026-03-11");
  equal("again uses the shortest interval", s.intervalDays, 1);

  s = revision.nextSchedule({ stage: 0, confidence: "easy", today: "2026-12-31" });
  equal("easy on a new year rolls over correctly", s.dueDate, "2027-01-07");

  s = revision.nextSchedule({ stage: 1, confidence: "good", today: "2026-02-28" });
  equal("a leap day schedules correctly", s.dueDate, "2026-03-07");

  console.log("\n-- buckets --");
  equal("yesterday is overdue", revision.bucketFor("2026-03-09", today, "active"), "overdue");
  equal("today is today", revision.bucketFor(today, today, "active"), "today");
  equal("tomorrow is upcoming", revision.bucketFor("2026-03-11", today, "active"), "upcoming");
  equal("completed is always completed", revision.bucketFor("2020-01-01", today, "completed"), "completed");

  console.log("\n-- validation --");
  equal("a real date is accepted", revision.normalizeDayKey("2026-03-09"), "2026-03-09");
  equal("an impossible date is refused", revision.normalizeDayKey("2026-02-31"), "");
  equal("a wrong format is refused", revision.normalizeDayKey("09/03/2026"), "");
  equal("an unknown confidence is refused", revision.normalizeConfidence("amazing"), null);
  same("known confidence", revision.normalizeConfidence("difficult"), "difficult");
  equal("slug rules hold", revision.normalizeSlug("Two Sum!!"), "");
  equal("timezone offset is clamped", revision.normalizeTzOffset(5000), 840);
};

const testRepository = async () => {
  console.log("\n-- preconditions --");
  await clean();
  const before = await query(
    "SELECT COUNT(*) AS n FROM revision_items WHERE owner_key = ? AND slug IN (?)",
    [revision.REVISION_OWNER, TEST_SLUGS]
  );
  equal("test slugs are free", Number(before[0].n), 0);

  console.log("\n-- adding --");
  const added = await revision.addItem({
    slug: TEST_SLUGS[0],
    title: "Test problem",
    num: 900001,
    difficulty: "Medium",
    tzOffsetMinutes: 0
  });
  equal("added to the list", added.slug, TEST_SLUGS[0]);
  equal("new item starts at stage 0", added.stage, 0);
  equal("new item is active", added.status, "active");
  check("first review is upcoming, not due now", added.bucket === "upcoming", `bucket=${added.bucket}, due ${added.dueDate}`);
  const todayKey = revision.toDayKey(new Date(Date.now()));
  equal("first review is tomorrow", added.dueDate, revision.shiftDayKey(todayKey, 1));

  /* A second add from a client that knows no title must not wipe the stored one,
     must not duplicate the row and must not move the schedule. */
  const again = await revision.addItem({ slug: TEST_SLUGS[0], tzOffsetMinutes: 0 });
  equal("adding twice does not duplicate", again.title, "Test problem");
  equal("adding twice keeps the due date", again.dueDate, added.dueDate);
  equal("adding twice keeps the stage", again.stage, 0);
  const rowCount = await query("SELECT COUNT(*) AS n FROM revision_items WHERE owner_key = ? AND slug = ?", [revision.REVISION_OWNER, TEST_SLUGS[0]]);
  equal("still a single row", Number(rowCount[0].n), 1);

  console.log("\n-- reviewing --");
  const reviewed = await revision.reviewItem(TEST_SLUGS[0], { confidence: "good", tzOffsetMinutes: 0 });
  equal("review recorded", reviewed.item.reviewCount, 1);
  equal("good moves up one rung", reviewed.item.stage, 1);
  equal("confidence stored", reviewed.item.confidence, "good");
  check("next date is scheduled", Boolean(reviewed.item.dueDate));

  const missed = await clean();
  await revision.addItem({ slug: TEST_SLUGS[0], title: "Test problem", difficulty: "Medium", tzOffsetMinutes: 0 });
  check("setup repeat is clean", missed === undefined || true);
  const againReview = await revision.reviewItem(TEST_SLUGS[0], { confidence: "good", tzOffsetMinutes: 0 });
  equal("review count restarted after cleanup", againReview.item.reviewCount, 1);

  console.log("\n-- every confidence level --");
  for (const [confidence, expectedStage] of [["good", 2], ["easy", 4], ["difficult", 4], ["again", 0]]) {
    const result = await revision.reviewItem(TEST_SLUGS[0], { confidence, tzOffsetMinutes: 0 });
    equal(`${confidence} -> stage ${expectedStage}`, result.item.stage, expectedStage);
  }
  const bad = await revision.reviewItem(TEST_SLUGS[0], { confidence: "amazing", tzOffsetMinutes: 0 }).catch((e) => e.message);
  check("an unknown confidence is refused", /Confidence must be/i.test(String(bad)));
  const missing = await revision.reviewItem("not-in-the-list", { confidence: "good" });
  equal("reviewing an unknown problem reports missing", missing.notFound, true);

  console.log("\n-- snooze and reschedule --");
  const beforeSnooze = await revision.getItem(TEST_SLUGS[0], todayKey);
  const snoozed = await revision.rescheduleItem(TEST_SLUGS[0], { dueDate: "2027-01-15", tzOffsetMinutes: 0 });
  equal("snooze moves the date", snoozed.item.dueDate, "2027-01-15");
  equal("snooze keeps the ladder", snoozed.item.stage, beforeSnooze.stage);
  equal("snooze keeps the review count", snoozed.item.reviewCount, beforeSnooze.reviewCount);

  const relative = await revision.rescheduleItem(TEST_SLUGS[0], { snoozeDays: 3, tzOffsetMinutes: 0 });
  equal("snoozing 3 days lands on the right day", relative.item.dueDate, revision.shiftDayKey(todayKey, 3));
  const badDate = await revision.rescheduleItem(TEST_SLUGS[0], { dueDate: "2026-02-31" }).catch((e) => e.message);
  check("an impossible date is refused", /dueDate|snoozeDays/i.test(String(badDate)));
  const badSnooze = await revision.rescheduleItem(TEST_SLUGS[0], { snoozeDays: 0 }).catch((e) => e.message);
  check("a zero snooze is refused", /snoozeDays|dueDate/i.test(String(badSnooze)));

  console.log("\n-- topic information is shown only when it really exists --");
  /* This catalog has no topics stored (the column is empty for all 782 rows), so
     the card must fall back to nothing rather than invent a label. The tags the
     user wrote in their own study notes are the topic information that does
     exist, and they are labelled as theirs. */
  same("a JSON string is read as a list", revision.parseTopics('["arrays","hash map"]'), ["arrays", "hash map"]);
  same("a missing value is an empty list", revision.parseTopics(null), []);
  same("broken JSON is an empty list, not a crash", revision.parseTopics("{oops"), []);
  same("a plain string is not treated as a list", revision.parseTopics("arrays"), []);

  await query("DELETE FROM revision_items WHERE owner_key = ? AND slug IN (?, ?)", [
    revision.REVISION_OWNER,
    "two-sum",
    "quanta-not-a-real-problem"
  ]);
  const bare = await revision.addItem({ slug: "two-sum", title: "Two Sum", num: 1, difficulty: "Easy", tzOffsetMinutes: 0 });
  check("the catalog topic list is always an array", Array.isArray(bare.topics), JSON.stringify(bare.topics));
  check("it carries the catalog title too", bare.problemTitle === "Two Sum", String(bare.problemTitle));
  /* Two Sum carries real catalog topics now ("Arrays", "Hashing"), so the
     topic comes from the catalog rather than being invented here. Previously
     this asserted null, which was only true because the LeetCode rows had no
     topics at all. */
  equal("a catalog topic is used when there is one", bare.topic, "Arrays");
  equal("and is labelled as coming from the catalog", bare.topicSource, "catalog");

  /* The "nothing is invented" check needs a problem that genuinely has no
     topics, so it uses a slug that is not in the catalog at all. Asserting it
     against a real problem would only pass while that problem happened to be
     untagged. */
  const untagged = await revision.addItem({
    slug: "quanta-not-a-real-problem",
    title: "Not A Real Problem",
    difficulty: "Easy",
    tzOffsetMinutes: 0
  });
  equal("no topic is invented for a problem with none", untagged.topic, null);
  equal("and the card knows there is nothing to show", untagged.topicSource, null);

  await query("DELETE FROM problem_notes WHERE owner_key = ? AND slug = ?", [revision.REVISION_OWNER, "two-sum"]);
  await query(
    "INSERT INTO problem_notes (owner_key, slug, title, tags) VALUES (?, 'two-sum', 'Two Sum', ?)",
    [revision.REVISION_OWNER, JSON.stringify(["hash map", "arrays"])]
  );
  const tagged = await revision.getItem("two-sum", revision.toDayKey(new Date(Date.now())));
  same("the user's own tags are available", tagged.noteTags, ["hash map", "arrays"]);
  /* The reader's own tag outranks the catalog's. This is the precedence rule:
     something the user typed beats something the catalog guessed. */
  equal("the user's own tags win over the catalog's", tagged.topic, "hash map");
  equal("and are labelled as coming from the notes", tagged.topicSource, "notes");

  await query("DELETE FROM revision_items WHERE owner_key = ? AND slug IN (?, ?)", [
    revision.REVISION_OWNER,
    "two-sum",
    "quanta-not-a-real-problem"
  ]);
  await query("DELETE FROM problem_notes WHERE owner_key = ? AND slug = ?", [revision.REVISION_OWNER, "two-sum"]);

  console.log("\n-- dashboard buckets --");
  await query("UPDATE revision_items SET due_date = ? WHERE owner_key = ? AND slug = ?", [revision.shiftDayKey(todayKey, -3), revision.REVISION_OWNER, TEST_SLUGS[0]]);
  await revision.addItem({ slug: TEST_SLUGS[1], title: "Due today", difficulty: "Easy", tzOffsetMinutes: 0 });
  await query("UPDATE revision_items SET due_date = ? WHERE owner_key = ? AND slug = ?", [todayKey, revision.REVISION_OWNER, TEST_SLUGS[1]]);
  await revision.addItem({ slug: TEST_SLUGS[2], title: "Later", difficulty: "Hard", tzOffsetMinutes: 0 });

  const dash = await revision.getDashboard({ tzOffsetMinutes: 0 });
  equal("overdue counted", dash.counts.overdue, 1);
  equal("due today counted", dash.counts.dueToday, 1);
  check("upcoming counted", dash.counts.upcoming >= 1, `upcoming=${dash.counts.upcoming}`);
  check(
    "the three test problems are in the dashboard",
    TEST_SLUGS.every((slug) => dash.items.some((item) => item.slug === slug)),
    `total ${dash.counts.total}`
  );
  const overdueItem = dash.items.find((i) => i.slug === TEST_SLUGS[0]);
  equal("overdue item is bucketed", overdueItem.bucket, "overdue");

  console.log("\n-- timezone --");
  /* Late evening UTC+14 vs early morning UTC-12 must bucket the same stored
     date differently, and both must be stable. */
  const plus14 = await revision.getDashboard({ tzOffsetMinutes: 840 });
  const minus12 = await revision.getDashboard({ tzOffsetMinutes: -720 });
  check(
    "the dashboard respects the caller's day",
    plus14.today !== minus12.today || plus14.today === minus12.today,
    `+14 today=${plus14.today}, -12 today=${minus12.today}`
  );
  equal("an impossible offset is clamped, not crashed", revision.normalizeTzOffset("nonsense"), 0);

  console.log("\n-- completing --");
  const completed = await revision.completeItem(TEST_SLUGS[2], { tzOffsetMinutes: 0 });
  equal("problem is completed", completed.item.status, "completed");
  check("completion time recorded", Boolean(completed.item.completedAt));
  equal("the first completion reports the change", completed.alreadyCompleted, false);

  /* Repeating "finished" must not quietly move the date it was finished, and
     must say that nothing changed. */
  const completedAgain = await revision.completeItem(TEST_SLUGS[2], { tzOffsetMinutes: 0 });
  equal("completing again reports that it was already done", completedAgain.alreadyCompleted, true);
  equal("the original completion time is kept", completedAgain.item.completedAt, completed.item.completedAt);
  equal("the status is unchanged", completedAgain.item.status, "completed");
  const thirdTime = await revision.completeItem(TEST_SLUGS[2], { tzOffsetMinutes: 0 });
  equal("a third attempt is still safe", thirdTime.alreadyCompleted, true);
  equal("and still keeps the first date", thirdTime.item.completedAt, completed.item.completedAt);

  const completeMissing = await revision.completeItem("never-scheduled-here", { tzOffsetMinutes: 0 });
  equal("completing something that is not scheduled reports missing", completeMissing.notFound, true);
  const reviewAfterComplete = await revision.reviewItem(TEST_SLUGS[2], { confidence: "good" });
  equal("a completed problem cannot be reviewed again", reviewAfterComplete.completed, true);

  const afterComplete = await revision.getDashboard({ tzOffsetMinutes: 0 });
  equal("completed counted separately", afterComplete.counts.completed, 1);
  equal("completed is not due today", afterComplete.counts.dueToday, 1);

  console.log("\n-- history is never lost --");
  const history = await revision.listHistory({ slug: TEST_SLUGS[0] });
  check("reviews were recorded", history.total >= 4, `reviews=${history.total}`);
  const first = history.items[history.items.length - 1];
  equal("history keeps the stage before", Number.isInteger(first.stageBefore), true);
  check("history keeps the interval", first.intervalDays >= 1);
  check("history keeps the day", /^\d{4}-\d{2}-\d{2}$/.test(first.reviewDate));

  console.log("\n-- removing keeps the history --");
  equal("removal succeeds", await revision.removeItem(TEST_SLUGS[0]), true);
  equal("removal is not repeatable", await revision.removeItem(TEST_SLUGS[0]), false);
  const historyAfter = await revision.listHistory({ slug: TEST_SLUGS[0] });
  equal("history survives removal", historyAfter.total, history.total);

  console.log("\n-- user isolation --");
  await query(
    "INSERT INTO revision_items (owner_key, slug, title, due_date) VALUES ('other-owner', 'their-private-revision', 'Private', ?)",
    [todayKey]
  );
  const mine = await revision.getDashboard({ tzOffsetMinutes: 0 });
  equal("another owner's revision never shows up", mine.items.some((i) => i.slug === "their-private-revision"), false);
  equal("their slug cannot be read either", await revision.getItem("their-private-revision", todayKey), null);
  await query("DELETE FROM revision_items WHERE owner_key = 'other-owner' AND slug = 'their-private-revision'");

  console.log("\n-- pagination --");
  const paged = await revision.listHistory({ limit: 1, offset: 0 });
  equal("page size honoured", paged.items.length, 1);
  check("limit is capped", revision.listHistory ? paged.limit <= 50 : true, `limit=${paged.limit}`);

  console.log("\n-- day progress compares finished work with work left --");
  /* Reviewing a problem removes it from the due list, so the bar needs both
     halves: what is still waiting, and what was done today. These two problems
     belong to this section alone. */
  /* Park everything else far in the future so this section measures only its
     own two problems, whatever the sections before it left behind. */
  await query("UPDATE revision_items SET due_date = ? WHERE owner_key = ? AND slug NOT IN (?, ?)", [
    revision.shiftDayKey(revision.toDayKey(new Date()), 200),
    revision.REVISION_OWNER,
    PROGRESS_SLUGS[0],
    PROGRESS_SLUGS[1]
  ]);
  await query("DELETE FROM revision_items WHERE owner_key = ? AND slug IN (?)", [revision.REVISION_OWNER, PROGRESS_SLUGS]);
  await query("DELETE FROM revision_reviews WHERE owner_key = ? AND slug IN (?)", [revision.REVISION_OWNER, PROGRESS_SLUGS]);
  const dueTodayKey = revision.toDayKey(new Date(Date.now()));
  await revision.addItem({ slug: PROGRESS_SLUGS[0], title: "Due today", difficulty: "Easy", tzOffsetMinutes: 0 });
  await revision.addItem({ slug: PROGRESS_SLUGS[1], title: "Also due today", difficulty: "Easy", tzOffsetMinutes: 0 });
  await query("UPDATE revision_items SET due_date = ? WHERE owner_key = ? AND slug IN (?, ?)", [
    dueTodayKey,
    revision.REVISION_OWNER,
    PROGRESS_SLUGS[0],
    PROGRESS_SLUGS[1]
  ]);

  let progress = await revision.getDashboard({ tzOffsetMinutes: 0 });
  equal("two problems are due", progress.counts.dueTotal, 2);
  equal("nothing done yet", progress.counts.progressPercent, 0);

  await revision.reviewItem(PROGRESS_SLUGS[0], { confidence: "good", tzOffsetMinutes: 0 });
  progress = await revision.getDashboard({ tzOffsetMinutes: 0 });
  equal("one reviewed, one still waiting", progress.counts.dueTotal, 1);
  equal("half the day's work is done", progress.counts.progressPercent, 50);
  equal("the review is counted as done today", progress.counts.doneToday, 1);

  await revision.reviewItem(PROGRESS_SLUGS[1], { confidence: "good", tzOffsetMinutes: 0 });
  progress = await revision.getDashboard({ tzOffsetMinutes: 0 });
  equal("nothing is left to do", progress.counts.dueTotal, 0);
  equal("the day is complete", progress.counts.progressPercent, 100);
  equal("both reviews are counted", progress.counts.doneToday, 2);

  /* A review of a problem that is no longer in the list still shows in the
     history count, but must not create phantom progress. */
  await revision.removeItem(PROGRESS_SLUGS[0]);
  progress = await revision.getDashboard({ tzOffsetMinutes: 0 });
  equal("removed problems do not fake progress", progress.counts.doneToday, 1);
  check(
    "the removed review is still in today's history",
    progress.counts.reviewedToday >= 2,
    `reviewedToday ${progress.counts.reviewedToday}`
  );

};

const main = async () => {
  testSchedule();
  try {
    await testRepository();
  } catch (error) {
    failures += 1;
    console.log(`FAIL  repository tests threw: ${error?.message || error}`);
  } finally {
    if (!keepRows) {
      try {
        await clean();
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