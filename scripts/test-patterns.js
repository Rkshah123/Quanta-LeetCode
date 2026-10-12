/* ------------------------ scripts / test-patterns ----------------------- */
/* The DSA pattern trainer, checked without a browser.
   Usage:
     npm run test:patterns

   These tests care about two things. First, that the pattern content is
   complete and specific enough to teach from - a pattern with generic advice
   ("think carefully about the boundaries") is worse than no pattern at all.
   Second, that the practice list is built from the catalog rather than
   hardcoded, so it can never advertise a problem that is not there. */

"use strict";

const P = require("../patterns");

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

const allText = () =>
  P.PATTERNS.map((p) => [p.title, p.when, p.shape, p.skeleton, ...p.checklist].join(" ")).join(" ").toLowerCase();

/* A small catalog with known topic tags, so the matching logic is testable. */
const catalog = [
  { slug: "a1", title: "Container With Most Water", difficulty: "Medium", topics: ["Two Pointers", "Arrays"] },
  { slug: "a2", title: "3Sum", difficulty: "Medium", topics: ["Two Pointers", "Arrays"] },
  { slug: "a3", title: "Minimum Window Substring", difficulty: "Hard", topics: ["Sliding Window", "Strings"] },
  { slug: "a4", title: "Longest Repeating Character Replacement", difficulty: "Medium", topics: ["Sliding Window", "Strings"] },
  { slug: "a5", title: "Range Sum Query", difficulty: "Easy", topics: ["Prefix Sum", "Arrays"] },
  { slug: "a6", title: "Search Insert Position", difficulty: "Easy", topics: ["Binary Search"] },
  { slug: "a7", title: "Merge Intervals", difficulty: "Medium", topics: ["Arrays", "Sorting"] },
  { slug: "a8", title: "Reverse Linked List", difficulty: "Easy", topics: ["Linked List"] },
  { slug: "a9", title: "Valid Parentheses", difficulty: "Easy", topics: ["Stack", "Strings"] },
  { slug: "a10", title: "Number of Islands", difficulty: "Medium", topics: ["Graphs"] },
  { slug: "a11", title: "Permutations", difficulty: "Medium", topics: ["Backtracking"] },
  { slug: "a12", title: "House Robber", difficulty: "Medium", topics: ["Dynamic Programming"] },
  { slug: "a13", title: "Implement Trie", difficulty: "Medium", topics: ["Tries"] },
  { slug: "a14", title: "Diamond Pattern", difficulty: "Easy", topics: ["Strings", "Arrays"] },
  { slug: "a15", title: "Top K Frequent", difficulty: "Medium", topics: ["Heaps", "Hashing"] },
  { slug: "a16", title: "Single Number", difficulty: "Easy", topics: ["Bit Manipulation"] },
  { slug: "a17", title: "Binary Tree Level Order", difficulty: "Medium", topics: ["Trees", "Queue"] },
  { slug: "a18", title: "Kth Smallest in BST", difficulty: "Medium", topics: ["BST", "Trees"] },
  { slug: "a19", title: "Jump Game", difficulty: "Medium", topics: ["Greedy"] },
  { slug: "a20", title: "Reverse Integer", difficulty: "Medium", topics: ["Math"] },
  { slug: "a21", title: "Count Primes", difficulty: "Medium", topics: ["Number Theory", "Math"] }
];

const main = () => {
  console.log("\n== structure ==");
  check("there is a decent number of patterns", P.PATTERNS.length >= 15, `${P.PATTERNS.length} patterns`);
  check("pattern keys are unique", new Set(P.PATTERNS.map((p) => p.key)).size === P.PATTERNS.length);
  check("every pattern has a title", P.PATTERNS.every((p) => p.title && p.title.length > 2));
  check("every pattern names at least one topic", P.PATTERNS.every((p) => Array.isArray(p.topics) && p.topics.length > 0));
  check("every pattern says when to use it", P.PATTERNS.every((p) => typeof p.when === "string" && p.when.length > 40), "the 'when' is a real explanation");
  check("every pattern describes its shape", P.PATTERNS.every((p) => typeof p.shape === "string" && p.shape.length > 30));
  check("every pattern has a code skeleton", P.PATTERNS.every((p) => typeof p.skeleton === "string" && p.skeleton.length > 40));
  check("every pattern has at least two checklist items", P.PATTERNS.every((p) => Array.isArray(p.checklist) && p.checklist.length >= 2), P.PATTERNS.map((p) => p.checklist.length).join(","));
  check("no two patterns are the same title", new Set(P.PATTERNS.map((p) => p.title.toLowerCase())).size === P.PATTERNS.length);

  console.log("\n== content quality ==");
  const text = allText();
  check("no placeholder text", !/\b(todo|tbd|fixme|coming soon|lorem)\b/i.test(text));
  check("no checklist item is generic filler", P.PATTERNS.every((p) => p.checklist.every((c) => c.length > 30 && !/^think carefully|^be careful|^read the question/i.test(c))));
  check("skeletons contain real code, not prose", P.PATTERNS.every((p) => /[;{}]|const|let|def |for |while /.test(p.skeleton)));
  check("the two-pointer skeleton warns about sorting", /sorted/.test(P.PATTERNS.find((p) => p.key === "two-pointers").when + P.PATTERNS.find((p) => p.key === "two-pointers").checklist.join(" ")));
  check("sliding window's checklist warns about the missing shrink", /shrink|while/.test(P.PATTERNS.find((p) => p.key === "sliding-window").checklist.join(" ")));
  check("backtracking's checklist warns about the missing undo", /undo|un-choose|delete|pop/i.test(P.PATTERNS.find((p) => p.key === "backtracking").checklist.join(" ")));
  check("binary search's checklist warns about mid overflow", /overflow|\(lo \+ hi\)/.test(P.PATTERNS.find((p) => p.key === "binary-search").checklist.join(" ")));
  check("greedy is given a real counter-example", /counter-example|1,3,4/.test(P.PATTERNS.find((p) => p.key === "greedy").checklist.join(" ")));
  check("queue's checklist says mark visited on enqueue", /enqueue/i.test(P.PATTERNS.find((p) => p.key === "queue").checklist.join(" ")));
  check("hash patterns explain set-after-check ordering", /after the check|set AFTER|before you insert/i.test(P.PATTERNS.find((p) => p.key === "two-sum-variants").checklist.join(" ")));
  check("trie's checklist mentions the terminal flag", /terminal|isword/i.test(P.PATTERNS.find((p) => p.key === "trie").checklist.join(" ")));
  check("DP's checklist asks for a state sentence", /sentence/i.test(P.PATTERNS.find((p) => p.key === "dp").checklist.join(" ")));
  check("the stack patterns pattern mentions checking an empty stack", /empty/.test(P.PATTERNS.find((p) => p.key === "stack").checklist.join(" ")));
  check("star patterns is present and explains the derivation", Boolean(P.PATTERNS.find((p) => p.key === "star-patterns")), "the brief asked for star patterns");
  check("star patterns warns about leading spaces", /space/i.test(P.PATTERNS.find((p) => p.key === "star-patterns").checklist.join(" ")));

  console.log("\n== practice lists come from the catalog ==");
  for (const pattern of P.PATTERNS) {
    const list = P.patternProblems(P.PATTERNS, pattern.key, catalog, 8);
    check(`${pattern.key} returns only real catalog problems`, list.every((p) => catalog.some((c) => c.slug === p.slug)), `${list.length} problems`);
    check(`${pattern.key} only returns problems carrying one of its topics`, list.every((p) => pattern.topics.some((t) => (p.topics || []).some((x) => x.toLowerCase() === t.toLowerCase()))));
  }

  const twoPointers = P.patternProblems(P.PATTERNS, "two-pointers", catalog, 8);
  check("two pointers finds the tagged problems", twoPointers.length === 2, twoPointers.map((p) => p.slug).join(","));
  check("practice problems come out easiest first", (() => {
    const order = { Easy: 0, Medium: 1, Hard: 2 };
    const list = P.patternProblems(P.PATTERNS, "sliding-window", catalog, 8);
    return list.every((p, i) => i === 0 || (order[list[i - 1].difficulty] ?? 3) <= (order[p.difficulty] ?? 3));
  })(), "a learning list should not open with the hardest problem");

  check("an unknown pattern key returns nothing", P.patternProblems(P.PATTERNS, "does-not-exist", catalog, 8).length === 0);
  check("an empty catalog returns nothing", P.patternProblems(P.PATTERNS, "dp", [], 8).length === 0);
  check("problems with no topics are simply not matched", P.patternProblems(P.PATTERNS, "dp", [{ slug: "x", difficulty: "Easy" }], 8).length === 0);
  check("topic matching is case insensitive", P.patternProblems(P.PATTERNS, "dp", [{ slug: "y", difficulty: "Easy", topics: ["dynamic programming"] }], 8).length === 1);

  console.log("\n== coverage ==");
  const gaps = P.patternGaps(P.PATTERNS, catalog);
  /* Every topic in the fixture catalog should be claimed by some pattern, or
     reported as a gap. Nothing may be silently dropped. */
  const catalogTopics = new Set(catalog.flatMap((p) => p.topics || []).map((t) => t.toLowerCase()));
  const claimed = new Set(P.PATTERNS.flatMap((p) => p.topics.map((t) => t.toLowerCase())));
  const unreported = [...catalogTopics].filter((t) => !claimed.has(t) && !gaps.some((g) => g.topic === t));
  check("every catalog topic is either taught or reported as a gap", unreported.length === 0, unreported.join(",") || "nothing dropped");
  check("gap counts are real", gaps.every((g) => Number.isInteger(g.count) && g.count > 0));
  check("gaps are sorted largest first", gaps.every((g, i) => i === 0 || gaps[i - 1].count >= g.count));

  console.log("\n== topics are real catalog topics ==");
  /* A pattern pointing at a topic no problem carries would render an empty
     practice list forever and look like a bug to the reader. */
  const known = new Set(catalogTopics);
  for (const pattern of P.PATTERNS) {
    const unknown = pattern.topics.filter((t) => !known.has(t.toLowerCase()));
    check(`${pattern.key} only references known topics`, unknown.length === 0, unknown.join(",") || "all known");
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
};

main();
