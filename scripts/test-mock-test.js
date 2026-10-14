/* Tests for mocktest.js - the three-question mock test.
 *
 * The parts that matter most here are the ones that could quietly lie:
 * selecting a test without repeats, marking an unanswered question differently
 * from a wrong one, and the worked-example check. That last one must NEVER
 * report a wrong answer as correct, or report a right one as wrong, so most of
 * these tests are about the cases where it refuses to answer at all. */

const T = require("../mocktest.js");
const { ACADEMY_QUIZ } = require("../academy.js");
const { PATTERNS } = require("../patterns.js");

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `  <- ${detail}`}`);
};

/* A catalog stand-in with the fields the picker reads. */
const catalog = Array.from({ length: 40 }, (_, i) => ({
  id: `p${i}`,
  slug: `slug-${i}`,
  name: `Problem ${i}`,
  difficulty: ["Easy", "Medium", "Hard"][i % 3],
  platform: i % 2 ? "codeforces" : "leetcode",
  url: `https://example.com/${i}`,
  topics: [["Arrays"], ["Binary Search"], ["Trees"], ["Stack"], ["Graphs"]][i % 5]
}));

console.log("\n== timing ==");
check("a coding question gets ten minutes", T.secondsFor(T.KIND.CODING) === 600, String(T.secondsFor(T.KIND.CODING)));
check("an objective question gets no clock at all", T.secondsFor(T.KIND.OBJECTIVE) === null, String(T.secondsFor(T.KIND.OBJECTIVE)));
check("the clock reads 10:00 at the start", T.clockText(600) === "10:00", T.clockText(600));
check("the clock reads 9:05 near the end", T.clockText(545) === "9:05", T.clockText(545));
check("the clock never goes negative", T.clockText(-5) === "0:00", T.clockText(-5));
check("a tick counts down", T.tick(600) === 599 && T.tick(1) === 0 && T.tick(0) === 0);
check("expiry is reachable from ten minutes", Array.from({ length: 600 }, () => 0).length === 600 && T.tick(T.tick(1)) === 0);

console.log("\n== the objective bank comes from real Quanta data ==");
const bank = T.buildObjectiveBank({ quiz: ACADEMY_QUIZ, patterns: PATTERNS });
check("the bank is built from the Academy quiz and the patterns", bank.length >= 7, `${bank.length} questions`);
check("it includes every Academy question", ACADEMY_QUIZ.every((q) => bank.some((b) => b.prompt.startsWith(q.question.slice(0, 20)))));
check("it adds pattern questions on top", bank.length > ACADEMY_QUIZ.length, `${bank.length} vs ${ACADEMY_QUIZ.length}`);
check("every question has real options", bank.every((q) => q.options.length >= 2));
check("every answer index points at a real option", bank.every((q) => q.correctIndex >= 0 && q.correctIndex < q.options.length));
check("every question carries an explanation", bank.every((q) => (q.explanation || "").length > 20), bank.filter((q) => !(q.explanation || "").length).map((q) => q.id).join(","));
check("no two questions share an id", new Set(bank.map((q) => q.id)).size === bank.length);
check("pattern questions ask about the pattern's own words", bank.filter((q) => q.source === "pattern").every((q) => PATTERNS.some((p) => q.prompt.includes(p.when.slice(0, 25)))));
check("a pattern question's answer is that pattern", bank.filter((q) => q.source === "pattern").every((q) => q.options[q.correctIndex] && q.prompt.length > 40));
check("options in a pattern question are all real patterns", bank.filter((q) => q.source === "pattern").every((q) => q.options.every((o) => PATTERNS.some((p) => p.title === o))));

console.log("\n== building a test ==");
const test = T.buildTest({ coding: catalog, objective: bank, seed: 12345 });
check("a test has three questions", test.length === 3, String(test.length));
check("no question repeats inside a test", new Set(test.map((q) => q.id)).size === test.length);
check("both kinds are present when both are available", new Set(test.map((q) => q.kind)).size === 2, test.map((q) => q.kind).join(","));
check("coding questions come from the catalog", test.filter((q) => q.kind === T.KIND.CODING).every((q) => catalog.some((p) => p.id === q.id)));
check("objective questions come from the bank", test.filter((q) => q.kind === T.KIND.OBJECTIVE).every((q) => bank.some((b) => b.id === q.id)));
check("the same seed gives the same test", JSON.stringify(T.buildTest({ coding: catalog, objective: bank, seed: 7 })) === JSON.stringify(T.buildTest({ coding: catalog, objective: bank, seed: 7 })));
check("a different seed gives a different test", JSON.stringify(T.buildTest({ coding: catalog, objective: bank, seed: 7 })) !== JSON.stringify(T.buildTest({ coding: catalog, objective: bank, seed: 8 })));
check("a negative seed does not break it", T.buildTest({ coding: catalog, objective: bank, seed: -3 }).length === 3);
check("seed 0 is handled", T.buildTest({ coding: catalog, objective: bank, seed: 0 }).length === 3);
check("a missing objective bank gives a coding-only test", T.buildTest({ coding: catalog, objective: [], seed: 5 }).every((q) => q.kind === T.KIND.CODING));
check("a missing catalog gives an objective-only test", T.buildTest({ coding: [], objective: bank, seed: 5 }).every((q) => q.kind === T.KIND.OBJECTIVE));
check("with nothing to draw from, the test is empty rather than padded", T.buildTest({ coding: [], objective: [], seed: 5 }).length === 0);
check("a tiny catalog is not padded with repeats", T.buildTest({ coding: catalog.slice(0, 1), objective: bank.slice(0, 1), seed: 5 }).length <= 2);
check("twenty different seeds never repeat a question inside one test", Array.from({ length: 20 }, (_, s) => T.buildTest({ coding: catalog, objective: bank, seed: s * 31 })).every((t) => new Set(t.map((q) => q.id)).size === t.length));

console.log("\n== marking an objective answer ==");
const mcq = bank.find((q) => q.options.length >= 2);
const right = T.markObjective(mcq, mcq.correctIndex);
const wrong = T.markObjective(mcq, (mcq.correctIndex + 1) % mcq.options.length);
const skipped = T.markObjective(mcq, -1);
check("the right answer is correct", right.correct === true);
check("the wrong answer is not", wrong.correct === false);
check("unanswered is not counted as correct", skipped.correct === false);
check("but unanswered is kept distinct from wrong", skipped.answered === false && wrong.answered === true, JSON.stringify({ skipped: skipped.answered, wrong: wrong.answered }));
check("an out-of-range choice is treated as unanswered", T.markObjective(mcq, 99).answered === false);
check("a non-numeric choice is treated as unanswered", T.markObjective(mcq, "2").answered === false);
check("the correct text comes back", right.correctText === mcq.options[mcq.correctIndex]);
check("the chosen text comes back", wrong.chosenText === mcq.options[wrong.chosenIndex]);
check("the explanation comes back", right.explanation === mcq.explanation && right.explanation.length > 0);

console.log("\n== marking a coding answer ==");
check("code that does not compile is wrong", T.markCoding({ compiled: false, stderr: "boom" }).verdict === "wrong");
check("a compile failure explains itself", /compile/i.test(T.markCoding({ compiled: false }).detail));
check("code that runs forever is wrong", T.markCoding({ compiled: true, ran: true, timedOut: true }).verdict === "wrong");
check("code that crashes is wrong", T.markCoding({ compiled: true, ran: false, stderr: "NullPointer" }).verdict === "wrong");
check("clean code with no example is UNVERIFIED, not right", T.markCoding({ compiled: true, ran: true, example: null }).verdict === "unverified");
check("and it says why", /could not be established|no hidden tests/i.test(T.markCoding({ compiled: true, ran: true }).detail));
check("a matched example makes it correct", T.markCoding({ compiled: true, ran: true, example: { checked: true, matched: true } }).correct === true);
check("a mismatched example makes it wrong", T.markCoding({ compiled: true, ran: true, example: { checked: true, matched: false } }).verdict === "wrong");
check("an unchecked example never counts as a pass", T.markCoding({ compiled: true, ran: true, example: { checked: false } }).verdict === "unverified");
check("an unchecked example never counts as a fail", T.markCoding({ compiled: true, ran: true, example: { checked: false } }).verdict !== "wrong");

console.log("\n== reading worked examples out of a statement ==");
const html = `<p>Example 1:</p><pre><code>Input: nums = [2,7,11,15], target = 9
Output: [0,1]
Explanation: The two numbers add up.</code></pre>`;
const parsed = T.parseExamples(html);
check("an example is found", parsed.length === 1, JSON.stringify(parsed));
check("its named arguments are read", parsed[0]?.args?.nums === "[2,7,11,15]" && parsed[0]?.args?.target === "9", JSON.stringify(parsed[0]?.args));
check("its expected output is read", parsed[0]?.expected === "[0,1]", parsed[0]?.expected);
check("a statement with no examples gives none", T.parseExamples("<p>Just a statement.</p>").length === 0);
check("empty input gives none", T.parseExamples("").length === 0);
check("null input gives none", T.parseExamples(null).length === 0);
check("an input with an ellipsis is refused", T.parseExamples("<pre>Input: nums = [1,2,...]\nOutput: 3</pre>").length === 0, "a range is a paraphrase, not an input");
check("an input with a constraint word is refused", T.parseExamples("<pre>Input: n <= 10\nOutput: 3</pre>").length === 0);
check("an input with no assignment is refused", T.parseExamples("<pre>Input: some array here\nOutput: 3</pre>").length === 0);
check("an input whose output is missing is refused", T.parseExamples("<pre>Input: nums = [1], target = 2</pre>").length === 0);
check("an output that is prose is refused", T.parseExamples("<pre>Input: nums = [1], target = 2\nOutput: see below</pre>").length === 0);
check("only one example is used", T.parseExamples(html + html.replace("Example 1", "Example 2")).length === 1);

console.log("\n== building a runnable check ==");
const jsFn = `var twoSum = function(nums, target) {
  for (let i = 0; i < nums.length; i++)
    for (let j = i + 1; j < nums.length; j++)
      if (nums[i] + nums[j] === target) return [i, j];
  return [];
};`;
const ex = { args: { nums: "[2,7,11,15]", target: "9" }, expected: "[0,1]" };
const harness = T.buildJsHarness(jsFn, ex);
check("a var-assigned function is recognised", typeof harness === "string");
check("the harness calls it with the statement's arguments", /twoSum\(\[2,7,11,15\], 9\)/.test(harness), (harness || "").slice(-160));
check("the harness prints a marked result", harness.includes("__Q__"));
check("a declaration form is recognised too", typeof T.buildJsHarness(`function twoSum(nums, target){ return [0,1]; }`, ex) === "string");
check("an arrow function is recognised", typeof T.buildJsHarness(`const twoSum = (nums, target) => [0,1];`, ex) === "string");
check("a class method is recognised", typeof T.buildJsHarness(`class Solution {\n  twoSum(nums, target){ return [0,1]; }\n}`, ex) === "string");
check("code with no recognisable function gives no harness", T.buildJsHarness("int x = 1;", ex) === null);
check("empty code gives no harness", T.buildJsHarness("", ex) === null);

console.log("\n== comparing what came back ==");
check("a matching result is a match", T.compareOutput('noise\n__Q__[0,1]\n', "[0,1]").matched === true);
check("a wrong result is a mismatch", T.compareOutput('__Q__[1,0]\n', "[0,1]").matched === false);
check("spaced and unspaced arrays match", T.compareOutput('__Q__[0, 1]\n', "[0,1]").matched === true);
check("quoted strings match either way", T.compareOutput('__Q__"abc"\n', "abc").matched === true);
check("output with no marker is not checked", T.compareOutput("just some log line\n", "[0,1]").checked === false);
check("empty output is not checked", T.compareOutput("", "[0,1]").checked === false);
check("a crash with no marker is not checked - never a wrong verdict", T.compareOutput("Error: boom\n", "[0,1]").checked === false);

console.log("\n== explanation for a coding answer ==");
const binary = catalog.find((p) => p.topics.includes("Binary Search"));
const ex1 = T.explanationFor(binary, PATTERNS);
check("a binary search problem gets the binary search pattern", ex1.pattern?.key === "binary-search", ex1.pattern?.key);
check("it carries the pattern's own skeleton", typeof ex1.approach === "string" && ex1.approach.length > 20);
check("and says plainly what that is", /not a verified reference solution/i.test(ex1.note));
check("a problem with no matching pattern says so rather than inventing", /no worked explanation/i.test(T.explanationFor({ topics: ["Nonsense Topic"] }, PATTERNS).note));
check("a problem with no topics at all is survivable", T.explanationFor({}, PATTERNS).pattern === null);
check("an empty pattern list is survivable", T.explanationFor(binary, []).pattern === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
