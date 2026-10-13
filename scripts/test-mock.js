/* ------------------------ scripts / test-mock --------------------------- */
/* The mock interview logic, checked without a browser.
   Usage:
     npm run test:mock

   The important properties here are that the problem picker is explainable and
   that the self-assessment really feeds the revision system - a mock interview
   that records a result but changes nothing afterwards would be a timer with
   extra steps. */

"use strict";

const M = require("../mock");

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

const catalog = [
  { slug: "e1", title: "Easy One", difficulty: "Easy", platform: "leetcode" },
  { slug: "e2", title: "Easy Two", difficulty: "Easy", platform: "leetcode" },
  { slug: "e3", title: "Easy Three", difficulty: "Easy", platform: "leetcode" },
  { slug: "m1", title: "Medium One", difficulty: "Medium", platform: "leetcode" },
  { slug: "m2", title: "Medium Two", difficulty: "Medium", platform: "codeforces" },
  { slug: "h1", title: "Hard One", difficulty: "Hard", platform: "leetcode" }
];

const main = () => {
  console.log("\n== problem selection ==");
  const picked = M.mockPickProblem(catalog, { difficulty: "Easy", seed: 1 });
  check("a problem is chosen", Boolean(picked.problem), picked.problem?.slug);
  check("it matches the requested difficulty", picked.problem.difficulty === "Easy", picked.problem.difficulty);
  check("the choice is explained", typeof picked.reason === "string" && picked.reason.length > 20, picked.reason);
  check("the explanation names the difficulty", /Easy/.test(picked.reason), picked.reason);
  check("the explanation says whether it was untouched", /neither solved nor scheduled|already/.test(picked.reason), picked.reason);
  check("it is not already solved", !["e1", "e2", "e3"].includes("") && picked.problem);

  /* Only e3 is left untouched, so e3 must be chosen - that is what proves
     solved and scheduled problems are skipped. */
  const avoided = M.mockPickProblem(catalog, {
    difficulty: "Easy",
    solvedSlugs: new Set(["e1", "e2"]),
    scheduledSlugs: new Set(),
    seed: 0
  });
  check("solved problems are skipped when something untouched is left", avoided.problem.slug === "e3", avoided.problem.slug);
  check("and no fallback is claimed when it did not need one", avoided.fallback === false, avoided.reason);

  /* Now leave nothing untouched: it must still offer a problem, and say why. */
  const allTouched = M.mockPickProblem(catalog, {
    difficulty: "Easy",
    solvedSlugs: new Set(["e1", "e2"]),
    scheduledSlugs: new Set(["e3"]),
    seed: 0
  });
  check("with nothing untouched it still offers a problem", Boolean(allTouched.problem), allTouched.problem?.slug);
  check("and it admits it fell back", allTouched.fallback === true, allTouched.reason);
  check("naming which problem was already done", /already solved|already on your revision/.test(allTouched.reason), allTouched.reason);

  const preferred = M.mockPickProblem(catalog, {
    difficulty: "Easy",
    solvedSlugs: new Set(["e1"]),
    scheduledSlugs: new Set(),
    seed: 0
  });
  check("an untouched problem is preferred", preferred.problem.slug !== "e1", preferred.problem.slug);
  check("and no fallback is claimed", preferred.fallback === false, preferred.reason);

  const nothingLeft = M.mockPickProblem(
    [{ slug: "e1", difficulty: "Easy" }],
    { difficulty: "Easy", solvedSlugs: new Set(["e1"]), seed: 0 }
  );
  check("when everything is solved it still offers something", nothingLeft.problem?.slug === "e1", nothingLeft.reason);
  check("and it admits why", /already solved/.test(nothingLeft.reason), nothingLeft.reason);

  console.log("\n== honesty about the catalog ==");
  const missing = M.mockPickProblem(catalog, { difficulty: "Easy" });
  check("a missing difficulty is an error, not a silent substitution", missing.error === undefined, "Easy exists here");
  const noHard = M.mockPickProblem([{ slug: "x", difficulty: "Easy" }], { difficulty: "Hard" });
  check("asking for a difficulty with no problems reports it", Boolean(noHard.error), noHard.error);
  check("the error lists what is available", /Easy/.test(noHard.error || ""), noHard.error);
  check("no problem is invented to fill the gap", !noHard.problem);

  console.log("\n== determinism ==");
  check("the same seed gives the same problem", M.mockPickProblem(catalog, { difficulty: "Easy", seed: 7 }).problem.slug === M.mockPickProblem(catalog, { difficulty: "Easy", seed: 7 }).problem.slug);
  const different = [0, 1, 2, 3].map((seed) => M.mockPickProblem(catalog, { difficulty: "Easy", seed }).problem.slug);
  check("different seeds can give different problems", new Set(different).size > 1, different.join(","));
  check("a negative seed is handled", Boolean(M.mockPickProblem(catalog, { difficulty: "Easy", seed: -5 }).problem));

  console.log("\n== the interview shape ==");
  check("there are three stages", M.MOCK_STAGES.length === 3, M.MOCK_STAGES.map((s) => s.key).join(","));
  check("every stage has a time and a note", M.MOCK_STAGES.every((s) => s.seconds > 0 && s.note && s.note.length > 25));
  check("the stages cover read, code and check", ["read", "code", "check"].every((k) => M.MOCK_STAGES.some((s) => s.key === k)));
  /* Pinned to ten minutes. The stages used to total 23 minutes, which is not
     how long an interview problem is normally given, and made the countdown
     disagree with the ten minutes a reader is told they have. */
  check("the whole interview is ten minutes", M.MOCK_TOTAL_SECONDS === 600, `${M.MOCK_TOTAL_SECONDS}s`);
  check(
    "the stages add up to exactly that total",
    M.MOCK_STAGES.reduce((sum, s) => sum + s.seconds, 0) === M.MOCK_TOTAL_SECONDS
  );
  check("the exported total matches the stages", M.MOCK_TOTAL_SECONDS === M.MOCK_STAGES.reduce((sum, s) => sum + s.seconds, 0));
  check("writing phase gets the largest share", (() => {
    const code = M.MOCK_STAGES.find((s) => s.key === "code").seconds;
    return M.MOCK_STAGES.every((s) => s.key === "code" || code >= s.seconds);
  })());
  check("no stage runs past the whole interview", M.MOCK_STAGES.every((s) => s.seconds < M.MOCK_TOTAL_SECONDS));
  check("the ten minutes reads as 10:00", M.mockClock(M.MOCK_TOTAL_SECONDS) === "10:00", M.mockClock(M.MOCK_TOTAL_SECONDS));

  console.log("\n== self-assessment feeds revision ==");
  const questions = M.mockSelfAssessment();
  check("it asks three questions", questions.length === 3);
  check("every question has four options", questions.every((q) => q.options.length === 4));
  check("every option maps to a real confidence level", questions.every((q) => q.options.every((o) => ["again", "difficult", "good", "easy"].includes(o.confidence))));
  check("no option stores a ladder stage that could drift from its label", questions.every((q) => q.options.every((o) => o.intervalStage === undefined)), "the stage is derived, never stored beside the label");
  /* Within a question the options are ordered best-first, which is the order
     they read best in and the order the UI renders them. */
  check("the options run from best to worst within a question", questions.every((q) => {
    const rank = { easy: 0, good: 1, difficult: 2, again: 3 };
    const ranks = q.options.map((o) => rank[o.confidence]);
    return ranks.every((r, i) => i === 0 || ranks[i - 1] <= r);
  }));
  check("every question offers exactly one of each confidence level", questions.every((q) => new Set(q.options.map((o) => o.confidence)).size === 4));

  check("all-easy gives easy", M.mockOverallConfidence({ approach: 0, edges: 0, explain: 0 }) === "easy");
  check("all-again gives again", M.mockOverallConfidence({ approach: 3, edges: 3, explain: 3 }) === "again");
  check("the WEAKEST answer decides, not the average", M.mockOverallConfidence({ approach: 0, edges: 3, explain: 0 }) === "again", "one bad answer is what an interviewer notices");
  check("a mixed answer lands between", ["again", "difficult", "good"].includes(M.mockOverallConfidence({ approach: 0, edges: 2, explain: 1 })));
  check("an empty assessment falls back to something reasonable", M.mockOverallConfidence({}) === "good");
  check("a partially answered assessment still works", Boolean(M.mockOverallConfidence({ approach: 3 })));
  check("an out-of-range answer does not break it", Boolean(M.mockOverallConfidence({ approach: 99, edges: -1 })));

  console.log("\n== outcome wording ==");
  for (const level of ["easy", "good", "difficult", "again"]) {
    const text = M.mockOutcomeText(level);
    check(`"${level}" explains what happens next`, typeof text === "string" && text.length > 30, text);
  }
  check("a weak outcome says it comes back soon", /tomorrow/.test(M.mockOutcomeText("again")), M.mockOutcomeText("again"));
  check("a strong outcome says it goes further out", /further out/.test(M.mockOutcomeText("easy")), M.mockOutcomeText("easy"));
  check("no outcome claims the solution was correct", !["easy", "good", "difficult", "again"].some((l) => /\b(correct|accepted|passed)\b/i.test(M.mockOutcomeText(l))), "the runner has no hidden tests, so it must not claim correctness");

  console.log("\n== clock ==");
  check("0 reads as 0:00", M.mockClock(0) === "0:00", M.mockClock(0));
  check("9 reads as 0:09", M.mockClock(9) === "0:09");
  check("65 reads as 1:05", M.mockClock(65) === "1:05", M.mockClock(65));
  check("900 reads as 15:00", M.mockClock(900) === "15:00");
  check("a negative time does not go backwards", M.mockClock(-5) === "0:00", M.mockClock(-5));
  check("it is always m:ss", /^\d+:\d{2}$/.test(M.mockClock(3725)), M.mockClock(3725));

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
};

main();
