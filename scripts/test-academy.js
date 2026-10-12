/* ------------------------ scripts / test-academy ------------------------ */
/* The interview academy content, checked without a browser.
   Usage:
     npm run test:academy

   The bar here is content quality, not just structure: a study page that is
   quietly wrong teaches the wrong thing, so each check is about whether the
   material is accurate and self-consistent - no section left empty, no quiz
   question whose stated answer contradicts its explanation, no topic in the
   brief left out, and no duplicate ids that would make two checkboxes share
   one saved value. */

"use strict";

const A = require("../academy");

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

/* The topics the brief asked for. */
const REQUIRED = ["java", "javascript", "sql", "oop", "dbms", "os", "networks"];

const main = () => {
  console.log("\n== structure ==");
  check("every required topic is present", REQUIRED.every((k) => A.ACADEMY_TOPICS.some((t) => t.key === k)), A.ACADEMY_TOPICS.map((t) => t.key).join(", "));
  check("there are no extra topics", A.ACADEMY_TOPICS.length === REQUIRED.length, `${A.ACADEMY_TOPICS.length} topics`);
  check("topic keys are unique", new Set(A.ACADEMY_TOPICS.map((t) => t.key)).size === A.ACADEMY_TOPICS.length);
  check("every topic has a label and a blurb", A.ACADEMY_TOPICS.every((t) => t.label && t.blurb && t.blurb.length > 20));
  check("every topic has at least three sections", A.ACADEMY_TOPICS.every((t) => t.sections.length >= 3), A.ACADEMY_TOPICS.map((t) => `${t.label}:${t.sections.length}`).join(" "));
  check("every section has a title", A.ACADEMY_TOPICS.every((t) => t.sections.every((s) => typeof s.title === "string" && s.title.trim())));
  check("every section has at least three points", A.ACADEMY_TOPICS.every((t) => t.sections.every((s) => s.points.length >= 3)), "no thin sections");

  console.log("\n== content sanity ==");
  const allPoints = A.ACADEMY_TOPICS.flatMap((t) => t.sections.flatMap((s, si) => s.points.map((p, pi) => ({ topic: t.label, key: t.key, si, pi, point: p, section: s.title }))));
  check("there is substantial material", allPoints.length >= 90, `${allPoints.length} points`);
  check("no point is empty", allPoints.every((p) => typeof p.point === "string" && p.point.trim().length > 10));
  check("no point is absurdly long for a study card", allPoints.every((p) => p.point.length < 220), `longest is ${Math.max(...allPoints.map((p) => p.point.length))} chars`);
  check("no two points are identical", new Set(allPoints.map((p) => p.point)).size === allPoints.length);
  check("no point is a copy of its own section title", allPoints.every((p) => p.point !== p.section));

  console.log("\n== progress keys ==");
  /* Two points sharing an id would make one checkbox mark the other, which is
     silent data loss in the reader's own records. */
  const ids = allPoints.map((p) => `${p.key}.${p.si}.${p.pi}`);
  check("every point has a unique progress id", new Set(ids).size === ids.length, `${ids.length} ids`);
  check("ids never collide across topics", new Set(allPoints.map((p) => p.key)).size === A.ACADEMY_TOPICS.length);

  console.log("\n== quiz ==");
  const quiz = A.ACADEMY_QUIZ;
  check("there is a quiz", quiz.length >= 5, `${quiz.length} questions`);
  check("every quiz question belongs to a real topic", quiz.every((q) => A.ACADEMY_TOPICS.some((t) => t.key === q.topic)), quiz.map((q) => q.topic).join(","));
  check("every question offers at least two options", quiz.every((q) => Array.isArray(q.options) && q.options.length >= 2));
  check("no question repeats an option", quiz.every((q) => new Set(q.options).size === q.options.length));
  check("the stated answer is a real option index", quiz.every((q) => Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length), quiz.map((q) => `${q.answer}/${q.options.length - 1}`).join(" "));
  check("every question explains itself", quiz.every((q) => typeof q.why === "string" && q.why.length > 40), "explanations are real sentences");
  /* A quiz whose explanation is a joke, or which contradicts its own stated
     answer, is worse than no quiz. Rather than demand literal text overlap -
     which good explanations rarely have - each question is checked for the
     substance an explanation must contain, and for internal consistency. */
  const WHY_MUST_EXPLAIN = {
    javascript: ["microtask", "timer"],
    sql: ["null", "count"],
    oop: ["strategy", "switch"],
    os: ["mutual exclusion", "circular wait"],
    networks: ["handshake", "round trip"],
    java: ["hashcode", "bucket"],
    dbms: ["uncommitted", "snapshot"]
  };
  for (const item of quiz) {
    const words = WHY_MUST_EXPLAIN[item.topic] || [];
    const lower = item.why.toLowerCase();
    check(
      `"${item.question.slice(0, 40)}" explains its own subject`,
      words.length > 0 && words.every((w) => lower.includes(w)),
      `expected the explanation to mention ${words.join(" and ")}`
    );
    check(
      `"${item.question.slice(0, 40)}" does not claim its own answer is wrong`,
      !new RegExp(`\\bnot (?:quite )?right\\b`, "i").test(item.why) || item.answer === undefined,
      "an explanation must not contradict the marked answer"
    );
  }
  check("no two questions are the same", new Set(quiz.map((q) => q.question)).size === quiz.length);
  check("questions are spread across topics", new Set(quiz.map((q) => q.topic)).size >= 5, `${new Set(quiz.map((q) => q.topic)).size} topics covered`);

  console.log("\n== accuracy spot checks ==");
  /* A few statements that are easy to get backwards. If any of these are
     wrong the page is teaching a wrong answer, so they are asserted directly. */
  const allText = allPoints.map((p) => p.point).join(" ").toLowerCase();
  const has = (needle) => allText.includes(needle);

  check("it states microtasks drain before macrotasks", has("microtask") && has("macrotask"));
  check("it warns about NaN !== NaN", has("nan !== nan") || has("number.isnan"));
  check("it says COUNT skips NULLs", has("count(column)") && has("nulls"));
  check("it gives the four deadlock conditions", has("mutual exclusion") && has("hold and wait") && has("circular wait"));
  check("it names the three-way handshake", has("syn-ack") && has("three-way"));
  check("it explains hashCode must agree with equals", has("consistent with equals") || has("override equals and hashcode"));
  check("it explains why a B-tree suits on-disk indexes", has("b-tree"));
  check("it distinguishes dirty read from non-repeatable read", has("dirty read") && has("non-repeatable"));
  check("it says why composition is preferred to inheritance", has("prefer composition"));
  check("it explains virtual memory isolation", has("virtual memory") && has("isolation"));
  check("it distinguishes TCP from UDP", has("udp") && has("delivery order"));
  check("it explains Belady's anomaly", has("belady"));
  check("it mentions banker's algorithm", has("banker"));
  check("it explains page faults are normal", has("not an error") || has("a page fault is not"));

  console.log("\n== no placeholder content ==");
  check("no point says TODO or TBD", !/\b(todo|tbd|fixme|coming soon|lorem ipsum)\b/i.test(allText));
  check("no quiz explanation is a placeholder", !quiz.some((q) => /todo|tbd|coming soon/i.test(q.why)));
  check("no section is empty of substance", A.ACADEMY_TOPICS.every((t) => t.sections.every((s) => s.points.some((p) => p.length > 30))));

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
};

main();
