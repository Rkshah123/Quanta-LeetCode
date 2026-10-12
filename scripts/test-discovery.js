/* ------------------------ scripts / test-discovery ---------------------- */
/* Smart Problem Discovery, checked without a browser.
   Usage:
     npm run test:discovery

   The point of these tests is that recommendations are EXPLAINED. A list of
   problems with no stated reason cannot be checked by a user, so every strategy
   is asserted to produce a reason that actually matches the numbers behind it,
   and the coverage figures are checked against the problems given. */

"use strict";

const D = require("../discovery");

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

/* A small, fully known catalog. Real shape, small enough to reason about. */
const makeProblems = () => [
  { slug: "two-sum", title: "Two Sum", difficulty: "Easy", platform: "leetcode", topics: ["Arrays", "Hashing"], solved: true },
  { slug: "valid-parens", title: "Valid Parentheses", difficulty: "Easy", platform: "leetcode", topics: ["Stack", "Strings"], solved: true },
  { slug: "merge-lists", title: "Merge Two Sorted Lists", difficulty: "Easy", platform: "leetcode", topics: ["Linked List", "Arrays"], solved: true },
  /* Arrays: two solved out of five, so it is a weak spot. */
  { slug: "a-3", title: "Arrays Easy 3", difficulty: "Easy", platform: "leetcode", topics: ["Arrays"], solved: false },
  { slug: "a-4", title: "Arrays Medium 1", difficulty: "Medium", platform: "leetcode", topics: ["Arrays"], solved: false },
  { slug: "a-5", title: "Arrays Medium 2", difficulty: "Medium", platform: "leetcode", topics: ["Arrays"], solved: false },
  { slug: "a-6", title: "Arrays Hard 1", difficulty: "Hard", platform: "leetcode", topics: ["Arrays"], solved: false },
  { slug: "a-7", title: "Arrays Easy 4", difficulty: "Easy", platform: "leetcode", topics: ["Arrays"], solved: false },
  /* Graphs: nothing solved, nothing attempted -> a breadth suggestion. */
  { slug: "g-1", title: "Graph Easy 1", difficulty: "Easy", platform: "leetcode", topics: ["Graphs"], solved: false },
  { slug: "g-2", title: "Graph Medium 1", difficulty: "Medium", platform: "leetcode", topics: ["Graphs"], solved: false },
  /* DP: solved one Easy, a Medium exists -> a level-up suggestion. The topic is
     given only these three problems so the counts behind the recommendation
     are unambiguous.
     Note that this topic is ALSO a weak spot (1 of 3 solved), and the two
     strategies legitimately want the same problem. The weak-spot entry claims
     it first and the level-up entry is then suppressed as a duplicate, which
     is correct: showing the same problem twice with two different excuses
     would be noise. */
  { slug: "dp-1", title: "DP Easy 1", difficulty: "Easy", platform: "leetcode", topics: ["Dynamic Programming"], solved: true },
  { slug: "dp-2", title: "DP Medium 1", difficulty: "Medium", platform: "leetcode", topics: ["Dynamic Programming"], solved: false },
  { slug: "dp-3", title: "DP Hard 1", difficulty: "Hard", platform: "leetcode", topics: ["Dynamic Programming"], solved: false },
  /* A topic that is fully solved at Easy and has a Medium waiting: a pure
     level-up, with no weak-spot claim attached. */
  { slug: "bs-1", title: "Binary Search Easy 1", difficulty: "Easy", platform: "leetcode", topics: ["Binary Search"], solved: true },
  { slug: "bs-2", title: "Binary Search Medium 1", difficulty: "Medium", platform: "leetcode", topics: ["Binary Search"], solved: false },
  /* Something already on the schedule. */
  { slug: "due-1", title: "Due Problem", difficulty: "Medium", platform: "leetcode", topics: ["Arrays"], solved: false },
  /* Attempted but not solved. */
  { slug: "t-1", title: "Tried One", difficulty: "Easy", platform: "codeforces", topics: ["Sorting"], solved: false, lastRunAt: 1700000000000 },
  /* Rating-carrying problem from another platform. */
  { slug: "cf-1", title: "Codeforces One", difficulty: "Medium", platform: "codeforces", topics: ["Greedy"], solved: false, rating: 1600 }
];

const main = () => {
  console.log("\n== basics ==");
  const problems = makeProblems();
  const recs = D.discoveryRecommend(problems, { limit: 10 });
  check("a fresh catalog still produces recommendations", recs.length > 0, `${recs.length} recommendations`);
  check("every recommendation names its strategy", recs.every((r) => r.strategy && r.strategyLabel));
  check("every recommendation explains itself", recs.every((r) => typeof r.reason === "string" && r.reason.length > 15), "reasons are real sentences");
  check("no problem is recommended twice", new Set(recs.map((r) => r.problem.slug)).size === recs.length, `${recs.length} unique`);
  check("no solved problem is recommended", recs.every((r) => !r.problem.solved), "already-done work is never suggested");

  console.log("\n== due to revise ==");
  const withDue = D.discoveryRecommend(problems, { dueSlugs: new Set(["due-1"]) });
  const dueEntry = withDue.find((r) => r.strategy === "due");
  check("a problem on the schedule is recommended as due", Boolean(dueEntry), dueEntry ? dueEntry.problem.slug : "none");
  check("it is the scheduled problem", dueEntry?.problem.slug === "due-1");
  check("due comes first, because it is already planned", withDue[0]?.strategy === "due", withDue[0]?.strategy);
  check("its reason mentions the schedule", /revision schedule/i.test(dueEntry?.reason || ""), dueEntry?.reason);

  console.log("\n== weak spot ==");
  const weak = recs.find((r) => r.strategy === "weakSpot");
  check("a started-but-unfinished topic is detected", Boolean(weak), weak ? weak.topic : "none");
  check("the weak topic is Arrays", weak?.topic === "Arrays", weak?.topic);
  /* Arrays carries 8 problems, not 5: Two Sum and Merge Two Sorted Lists are
     both tagged Arrays as well as having their own tagged problems. Counting
     by hand here is exactly the kind of mistake these tests exist to catch, so
     the expected total is computed from the fixture instead of written down. */
  const arraysProblems = problems.filter((p) => (p.topics || []).includes("Arrays"));
  const arraysSolved = arraysProblems.filter((p) => p.solved).length;
  check(
    "the reason quotes the real solved count",
    new RegExp(`solved ${arraysSolved} of ${arraysProblems.length}`).test(weak?.reason || ""),
    `${weak?.reason} (fixture has ${arraysSolved}/${arraysProblems.length})`
  );
  check("the reason names the topic", /Arrays/.test(weak?.reason || ""), weak?.reason);
  check("the suggested problem is unsolved", weak && !weak.problem.solved);
  check("the suggested problem belongs to that topic", (Array.isArray(weak?.problem.topics) ? weak.problem.topics : []).includes("Arrays"));

  console.log("\n== level up ==");
  const levels = recs.filter((r) => r.strategy === "nextStep");
  check("a topic with an Easy solve offers a Medium next", levels.length > 0, levels.map((r) => r.reason).join(" | "));
  check("every level-up problem is one step harder", levels.every((r) => r.problem.difficulty === "Medium"), levels.map((r) => r.problem.difficulty).join(","));
  const dpLevel = levels.find((r) => r.topic === "Binary Search");
  check("a topic solved only at Easy is offered the Medium", Boolean(dpLevel), dpLevel ? `${dpLevel.problem.title} (${dpLevel.problem.difficulty})` : "none");
  check("the level-up problem really is the Medium", dpLevel?.problem.title === "Binary Search Medium 1", dpLevel?.problem.title);
  check("the reason quotes the real count", /solved 1 Easy/.test(dpLevel?.reason || ""), dpLevel?.reason);
  check("no Hard is offered while a Medium is waiting", levels.every((r) => r.problem.difficulty !== "Hard"), levels.map((r) => r.problem.difficulty).join(","));
  check(
    "a problem claimed by two strategies is only listed once",
    new Set(recs.map((r) => r.problem.slug)).size === recs.length,
    "no duplicates across strategies"
  );

  console.log("\n== breadth ==");
  const breadth = recs.find((r) => r.strategy === "breadth");
  check("an untouched topic is suggested", Boolean(breadth), breadth ? breadth.topic : "none");
  check("it picks Graphs, which is untouched", breadth?.topic === "Graphs", breadth?.topic);
  check("a breadth suggestion starts Easy", breadth?.problem.difficulty === "Easy", breadth?.problem.difficulty);
  check("its reason says the topic is unopened", /not opened/i.test(breadth?.reason || ""), breadth?.reason);

  console.log("\n== completed topics are not suggested ==");
  const allDone = problems.map((p) => ({ ...p, solved: true }));
  const afterDone = D.discoveryRecommend(allDone, { limit: 8 });
  check("a fully solved catalog offers no due/weak/level-up work", afterDone.every((r) => !["due", "weakSpot", "nextStep"].includes(r.strategy)), afterDone.map((r) => r.strategy).join(","));
  const touchesSolved = afterDone.filter((r) => r.problem.solved);
  check("and never recommends something already solved", touchesSolved.length === 0, `${touchesSolved.length} solved suggestions`);

  console.log("\n== external state is honoured ==");
  const external = D.discoveryRecommend(
    problems.map((p) => ({ ...p, solved: false })),
    { solvedSlugs: new Set(["two-sum"]), attemptedSlugs: new Set(["a-3"]), dueSlugs: new Set(["dp-2"]), limit: 10 }
  );
  check("a problem solved elsewhere is not recommended", external.every((r) => r.problem.slug !== "two-sum"));
  check("a problem attempted elsewhere is not offered as brand new", external.filter((r) => r.strategy === "breadth").every((r) => r.problem.slug !== "a-3"));
  check("an externally-scheduled problem appears as due", external.some((r) => r.strategy === "due" && r.problem.slug === "dp-2"));

  console.log("\n== coverage ==");
  const coverage = D.discoveryCoverage(problems);
  const arrays = coverage.find((c) => c.topic === "Arrays");
  check(
    "coverage counts Arrays correctly",
    arrays && arrays.total === arraysProblems.length && arrays.solved === arraysSolved,
    JSON.stringify(arrays)
  );
  const graphs = coverage.find((c) => c.topic === "Graphs");
  check("an untouched topic is reported as untouched", graphs?.status === "untouched", graphs?.status);
  const sorting = coverage.find((c) => c.topic === "Sorting");
  check("an attempted-but-unsolved topic counts as attempted", sorting?.attempted === 1, JSON.stringify(sorting));
  check("every coverage entry has real numbers", coverage.every((c) => Number.isInteger(c.total) && Number.isInteger(c.solved) && c.share >= 0 && c.share <= 1));
  check("topics with no problems are omitted", coverage.every((c) => c.total > 0));
  check("coverage of an empty catalog is empty", D.discoveryCoverage([]).length === 0);

  console.log("\n== limits and robustness ==");
  check("the limit is respected", D.discoveryRecommend(problems, { limit: 3 }).length <= 3);
  check("an empty catalog does not crash", Array.isArray(D.discoveryRecommend([], {})));
  check("problems with no topics do not break it", D.discoveryRecommend([{ slug: "x", title: "X", difficulty: "Easy" }], {}).length >= 0);
  check("a problem with an unknown difficulty is skipped, not crashed on", Array.isArray(D.discoveryRecommend([{ slug: "y", title: "Y", difficulty: "Impossible", topics: ["Arrays"] }], {})));
  check("null topics are tolerated", Array.isArray(D.discoveryRecommend([{ slug: "z", title: "Z", difficulty: "Easy", topics: null }], {})));
  check("solvedSlugs as an array is not mistaken for a Set", Array.isArray(D.discoveryRecommend(problems, { solvedSlugs: ["two-sum"] })));

  console.log("\n== explanation honesty ==");
  /* The reason text quotes numbers, so those numbers must be the ones that are
     actually true - this is the check that stops the panel from lying. */
  for (const rec of recs) {
    if (rec.strategy !== "weakSpot" && rec.strategy !== "nextStep") continue;
    const match = /solved (\d+) of (\d+) (\w[\w ]*?) problems/.exec(rec.reason);
    if (!match) continue;
    const solvedCount = Number(match[1]);
    const totalCount = Number(match[2]);
    const topic = rec.topic;
    const inTopic = problems.filter((p) => (p.topics || []).includes(topic));
    check(
      `"${rec.reason}" quotes the real numbers`,
      inTopic.filter((p) => p.solved).length === solvedCount && inTopic.length === totalCount,
      `claims ${solvedCount}/${totalCount}, reality ${inTopic.filter((p) => p.solved).length}/${inTopic.length}`
    );
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
};

main();
