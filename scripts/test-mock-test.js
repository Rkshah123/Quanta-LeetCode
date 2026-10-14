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

console.log("\n== the submit rule ==");
/* The rule the reader asked for, stated here once so the button, the timer and
   the expiry path cannot drift apart about what counts as an attempt. */
check("an empty editor is not an answer", T.hasCode("") === false);
check("a single space is not an answer", T.hasCode(" ") === false);
check("a tab is not an answer", T.hasCode("\t") === false);
check("newlines are not an answer", T.hasCode("\n\n") === false);
check("indented blank lines are not an answer", T.hasCode("   \n\t\n  \n") === false);
check("one real character is an answer", T.hasCode("x") === true);
check("leading blank lines around code are still an answer", T.hasCode("\n\n  return 1;\n") === true);
check("a comment counts as an answer", T.hasCode("// hi") === true);
check("non-strings are safely not answers", T.hasCode(null) === false && T.hasCode(undefined) === false && T.hasCode(12) === false);

console.log("\n== verdicts are separated by what was seen ==");
check("every verdict has a label", Object.values(T.VERDICT).every((v) => typeof T.VERDICT_LABEL[v] === "string" && T.VERDICT_LABEL[v].length > 3));
check("every verdict has a tone", Object.values(T.VERDICT).every((v) => typeof T.VERDICT_TONE[v] === "string"));
check("a right answer is called 'Correct Answer'", T.VERDICT_LABEL[T.VERDICT.CORRECT] === "Correct Answer");
check("a wrong answer is called 'Incorrect Answer'", T.VERDICT_LABEL[T.VERDICT.WRONG] === "Incorrect Answer");
check("an unevaluable one says so plainly", T.VERDICT_LABEL[T.VERDICT.UNVERIFIED] === "Unable to evaluate automatically");
check("running cleanly is not the same verdict as passing", T.VERDICT.UNVERIFIED !== T.VERDICT.CORRECT);

console.log("\n== marking an objective answer ==");
const mcq = bank.find((q) => q.options.length >= 2);
const right = T.markObjective(mcq, mcq.correctIndex);
const wrong = T.markObjective(mcq, (mcq.correctIndex + 1) % mcq.options.length);
const skipped = T.markObjective(mcq, -1);
check("the stored correct index is compared, not assumed", right.correct === true);
check("a different option is not correct", wrong.correct === false);
check("unanswered is not counted as correct", skipped.correct === false);
check("but unanswered is kept distinct from wrong", skipped.answered === false && wrong.answered === true);
check("an out-of-range choice is treated as unanswered", T.markObjective(mcq, 99).answered === false);
check("a non-numeric choice is treated as unanswered", T.markObjective(mcq, "2").answered === false);
check("the correct text comes back", right.correctText === mcq.options[mcq.correctIndex]);
check("the chosen text comes back", wrong.chosenText === mcq.options[wrong.chosenIndex]);
check("the explanation comes back", right.explanation === mcq.explanation && right.explanation.length > 0);
check("a right answer says it matches the stored answer", /matches the stored correct answer/.test(right.detail), right.detail);
check("a wrong answer names the stored answer", /does not match/.test(wrong.detail), wrong.detail);
check("correct carries the verdict, not just a flag", right.verdict === T.VERDICT.CORRECT && right.label === "Correct Answer");
check("wrong carries the verdict", wrong.verdict === T.VERDICT.WRONG && wrong.label === "Incorrect Answer");
check("an objective answer never claims a test was run", right.tested === 0 && right.tests.length === 0);

console.log("\n== marking a coding answer: only a passing test is correct ==");
const pass1 = { label: "Example 1", passed: true, expected: "[0,1]", got: "[0,1]" };
const pass2 = { label: "Example 2", passed: true, expected: "true", got: "true" };
const fail1 = { label: "Example 2", passed: false, expected: "true", got: "false" };
const someCode = "function f(){return 1;}";

check("all tests passing is correct", T.markCoding({ tests: [pass1, pass2], code: someCode }).verdict === T.VERDICT.CORRECT);
check("and it says so", T.markCoding({ tests: [pass1, pass2], code: someCode }).label === "Correct Answer");
check("a single failing test makes it wrong", T.markCoding({ tests: [pass1, fail1], code: someCode }).verdict === T.VERDICT.WRONG);
check("and the label says Incorrect Answer", T.markCoding({ tests: [pass1, fail1], code: someCode }).label === "Incorrect Answer");
check("running cleanly with no test is NOT correct", T.markCoding({ tests: [], ran: true, code: someCode }).verdict === T.VERDICT.UNVERIFIED);
check("running cleanly with no test says it cannot be judged", T.markCoding({ tests: [], ran: true, code: someCode }).label === "Unable to evaluate automatically");
check("and explains why", /cannot be marked right or wrong/.test(T.markCoding({ tests: [], ran: true, code: someCode }).detail));
check("a compile failure is its own verdict", T.markCoding({ compiled: false, tests: [pass1], code: someCode }).verdict === T.VERDICT.COMPILE_ERROR);
check("a compile failure is never reported as a wrong answer", T.markCoding({ compiled: false, tests: [pass1], code: someCode }).verdict !== T.VERDICT.WRONG);
check("a crash is its own verdict", T.markCoding({ ran: false, tests: [], code: someCode }).verdict === T.VERDICT.RUNTIME_ERROR);
check("a timeout is its own verdict", T.markCoding({ ran: true, timedOut: true, tests: [], code: someCode }).verdict === T.VERDICT.RUNTIME_ERROR);
check("a single failing test names itself rather than counting", /The test that failed is shown below/.test(T.markCoding({ tests: [pass1, fail1], code: someCode }).detail));
check("several failing tests are counted", /2 of 3 failed/.test(T.markCoding({ tests: [fail1, fail1, pass1], code: someCode }).detail), T.markCoding({ tests: [fail1, fail1, pass1], code: someCode }).detail);
check("the passing count is reported", /all 2 of the problem/.test(T.markCoding({ tests: [pass1, pass2], code: someCode }).detail));
check("an empty editor is answered=false however it is marked", T.markCoding({ tests: [pass1], code: "   \n " }).answered === false);
check("a real submission is answered=true", T.markCoding({ tests: [pass1], code: someCode }).answered === true);
check("the test rows are kept for review", T.markCoding({ tests: [pass1, fail1], code: someCode }).tests.length === 2);
check("no tests can never be reported as correct", [true, false, null, undefined].every((v) => {
  const m = T.markCoding({ tests: v, ran: true, code: someCode });
  return m.verdict !== T.VERDICT.CORRECT;
}));

console.log("\n== reading worked examples out of a statement ==");
const html = `<p>Example 1:</p><pre><code>Input: nums = [2,7,11,15], target = 9
Output: [0,1]
Explanation: The two numbers add up.</code></pre>`;
const parsed = T.parseExamples(html);
check("an example is found", parsed.length === 1, JSON.stringify(parsed));
check("its named arguments are read", parsed[0]?.args?.nums === "[2,7,11,15]" && parsed[0]?.args?.target === "9", JSON.stringify(parsed[0]?.args));
check("its expected output is read", parsed[0]?.expected === "[0,1]", parsed[0]?.expected);
check("examples are labelled in order", parsed[0]?.label === "Example 1", parsed[0]?.label);

const threeHtml = `<pre>Input: nums = [2,7,11,15], target = 9
Output: [0,1]</pre>
<pre>Input: nums = [3,2,4], target = 6
Output: [1,2]</pre>
<pre>Input: nums = [3,3], target = 6
Output: [0,1]</pre>`;
const three = T.parseExamples(threeHtml);
check("several examples are all read, not just the first", three.length === 3, `${three.length}`);
check("and each keeps its own arguments", three[1].args.nums === "[3,2,4]" && three[2].args.target === "6", JSON.stringify(three.map((e) => e.args)));
check("a second example is labelled as the second", three[1].label === "Example 2");

check("a statement with no examples gives none", T.parseExamples("<p>Just a statement.</p>").length === 0);
check("empty input gives none", T.parseExamples("").length === 0);
check("null input gives none", T.parseExamples(null).length === 0);
check("an input with an ellipsis is refused", T.parseExamples("<pre>Input: nums = [1,2,...]\nOutput: 3</pre>").length === 0, "a range is a paraphrase, not an input");
check("an input with a constraint word is refused", T.parseExamples("<pre>Input: n <= 10\nOutput: 3</pre>").length === 0);
check("an input with no assignment is refused", T.parseExamples("<pre>Input: some array here\nOutput: 3</pre>").length === 0);
check("an input whose output is missing is refused", T.parseExamples("<pre>Input: nums = [1], target = 2</pre>").length === 0);
check("an output that is prose is refused", T.parseExamples("<pre>Input: nums = [1], target = 2\nOutput: see below</pre>").length === 0);
check("the cap is honoured", T.parseAllExamples(Array.from({ length: 30 }, (_, i) => `<pre>Input: n = ${i}\nOutput: ${i}</pre>`).join(""), 5).length === 5);

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

const pySolution = `class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        return [0,1]`;
const pyHarness = T.buildPythonHarness(pySolution, ex);
check("the Python LeetCode shape is recognised", typeof pyHarness === "string");
check("it calls the method with the statement's arguments", /__inst\.twoSum\(\[2, 7, 11, 15\], 9\)/.test(pyHarness), (pyHarness || "").slice(-120));
check("it prints a marked JSON result", pyHarness.includes("__Q__") && pyHarness.includes("json.dumps"));
check("Python with no class gives no harness", T.buildPythonHarness("print(1)", ex) === null);
check("Python with no method gives no harness", T.buildPythonHarness("class Solution:\n    x = 1", ex) === null);
check("Python spelling is translated, not pasted", T.pythonLiteral("true") === "True" && T.pythonLiteral("null") === "None" && T.pythonLiteral("false") === "False", JSON.stringify([T.pythonLiteral("true"), T.pythonLiteral("null")]));
check("a Python number is passed through", T.pythonLiteral("9") === "9");
check("a Python string keeps its quotes", T.pythonLiteral('"abc"') === '"abc"');
check("a Python list is rebuilt element by element", T.pythonLiteral("[1,true,null]") === "[1, True, None]", T.pythonLiteral("[1,true,null]"));

const javaSolution = `class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        return new int[]{0,1};\n    }\n}`;
const javaHarness = T.buildJavaHarness(javaSolution, ex);
check("the Java LeetCode shape is recognised", typeof javaHarness === "string");
check("an int[] parameter gets a real array", /new int\[\]\{2, 7, 11, 15\}/.test(javaHarness), (javaHarness || "").slice(-200));
check("the method is called with the statement's arguments", /s\.twoSum\(new int\[\]\{2, 7, 11, 15\}, 9\)/.test(javaHarness));
check("Java with no class gives no harness", T.buildJavaHarness("int main(){return 0;}", ex) === null);
check("Java with no method gives no harness", T.buildJavaHarness("class Solution { int x = 1; }", ex) === null);
check("a List parameter gets a real list", /new ArrayList<>\(Arrays\.asList\("a"\)\)/.test(T.buildJavaHarness(`class Solution { public String f(List<String> xs){ return xs.get(0); } }`, { args: { xs: '["a"]' }, expected: '"a"' }) || ""));

console.log("\n== which languages can be checked ==");
check("JavaScript, Python and Java are the checked languages", JSON.stringify(T.CAN_EVALUATE) === JSON.stringify(["javascript", "python", "java"]), JSON.stringify(T.CAN_EVALUATE));
check("the dispatcher builds a JavaScript harness", T.harnessFor("javascript", jsFn, ex) !== null);
check("the dispatcher builds a Python harness", T.harnessFor("python", pySolution, ex) !== null);
check("the dispatcher builds a Java harness", T.harnessFor("java", javaSolution, ex) !== null);
check("C is not claimed, because nothing has tested a C harness", T.harnessFor("c", javaSolution, ex) === null);
check("C++ is not claimed either", T.harnessFor("cpp", javaSolution, ex) === null);

console.log("\n== running one example and reading the answer back ==");
const runWith = (stdout) => async () => ({ ok: true, stdout, stderr: "", phase: "run" });
(async () => {
  const good = await T.runExampleTest({ harness: "x", expected: "[0,1]", expectedLabel: "Example 1", run: runWith("__Q__[0,1]") });
  check("a matching result is a pass", good?.passed === true, JSON.stringify(good));
  const bad = await T.runExampleTest({ harness: "x", expected: "[0,1]", expectedLabel: "Example 1", run: runWith("__Q__[1,0]") });
  check("a mismatched result is a fail", bad?.passed === false, JSON.stringify(bad));
  const spaced = await T.runExampleTest({ harness: "x", expected: "[0,1]", expectedLabel: "E", run: runWith("__Q__[0, 1]") });
  check("spaced and unspaced arrays match", spaced?.passed === true, JSON.stringify(spaced));
  const quoted = await T.runExampleTest({ harness: "x", expected: "abc", expectedLabel: "E", run: runWith('__Q__"abc"') });
  check("a quoted string matches a bare one", quoted?.passed === true, JSON.stringify(quoted));
  const noise = await T.runExampleTest({ harness: "x", expected: "[0,1]", expectedLabel: "E", run: runWith("just a log line\n") });
  check("output with no marker is NOT a pass", noise === null, JSON.stringify(noise));
  const crashed = await T.runExampleTest({ harness: "x", expected: "[0,1]", expectedLabel: "E", run: async () => ({ ok: false, stdout: "", stderr: "Error: boom", phase: "run" }) });
  check("a crashed check is NOT a fail - it is no result at all", crashed === null, JSON.stringify(crashed));
  const threw = await T.runExampleTest({ harness: "x", expected: "[0,1]", expectedLabel: "E", run: async () => { throw new Error("network"); } });
  check("a runner that throws is NOT a fail", threw === null, JSON.stringify(threw));
  check("no harness means no row", (await T.runExampleTest({ harness: null, expected: "[0,1]", expectedLabel: "E", run: runWith("__Q__[0,1]") })) === null);
  check("the row keeps the expected and the actual", good?.expected === "[0,1]" && good?.got === "[0,1]", JSON.stringify(good));

  console.log("\n== tallying a finished test ==");
  const tally = T.summarise([
    { verdict: T.VERDICT.CORRECT, answered: true },
    { verdict: T.VERDICT.WRONG, answered: true },
    { verdict: T.VERDICT.UNVERIFIED, answered: true },
    { verdict: T.VERDICT.UNANSWERED, answered: false }
  ]);
  check("the total is the number answered", tally.total === 4);
  check("right answers are counted", tally.correct === 1);
  check("wrong answers are counted", tally.incorrect === 1);
  check("unanswered are counted separately from wrong", tally.unanswered === 1);
  check("unevaluable are counted on their own", tally.unevaluated === 1);
  check("unevaluable is NOT counted as incorrect", tally.incorrect === 1);
  check("the headline number is right plus wrong or skipped", tally.wrongTotal === 2);
  check("the percentage is out of the total", tally.percent === 25, String(tally.percent));
  check("compile errors count as incorrect", T.summarise([{ verdict: T.VERDICT.COMPILE_ERROR, answered: true }]).incorrect === 1);
  check("runtime errors count as incorrect", T.summarise([{ verdict: T.VERDICT.RUNTIME_ERROR, answered: true }]).incorrect === 1);
  check("an empty test does not divide by zero", T.summarise([]).percent === 0 && T.summarise(null).total === 0);
  check("a hole in the results is ignored", T.summarise([null, { verdict: T.VERDICT.CORRECT, answered: true }, undefined]).total === 1);
  check("a perfect test is 100%", T.summarise([{ verdict: T.VERDICT.CORRECT, answered: true }, { verdict: T.VERDICT.CORRECT, answered: true }]).percent === 100);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();console.log("\n== explanation for a coding answer ==");
const binary = catalog.find((p) => p.topics.includes("Binary Search"));
const ex1 = T.explanationFor(binary, PATTERNS);
check("a binary search problem gets the binary search pattern", ex1.pattern?.key === "binary-search", ex1.pattern?.key);
check("it carries the pattern's own skeleton", typeof ex1.approach === "string" && ex1.approach.length > 20);
check("and says plainly what that is", /not a verified reference solution/i.test(ex1.note));
check("a problem with no matching pattern says so rather than inventing", /no worked explanation/i.test(T.explanationFor({ topics: ["Nonsense Topic"] }, PATTERNS).note));
check("a problem with no topics at all is survivable", T.explanationFor({}, PATTERNS).pattern === null);
check("an empty pattern list is survivable", T.explanationFor(binary, []).pattern === null);

  console.log("\n== was it wrong, and may the question close ==");

  /* Each verdict, reached the way the panel reaches one. */
  const marked = (verdict) => (verdict === T.VERDICT.UNANSWERED
    ? { verdict, answered: false, correct: false }
    : { verdict, answered: true, correct: verdict === T.VERDICT.CORRECT });

  check("a wrong answer is incorrect", T.isIncorrect(marked(T.VERDICT.WRONG)));
  check("a compile error is incorrect", T.isIncorrect(marked(T.VERDICT.COMPILE_ERROR)));
  check("a runtime error is incorrect", T.isIncorrect(marked(T.VERDICT.RUNTIME_ERROR)));

  /* The one that must not be mistaken for a failure. */
  check("an answer Quanta could not evaluate is NOT incorrect", T.isIncorrect(marked(T.VERDICT.UNVERIFIED)) === false);
  check("nor is an unanswered question", T.isIncorrect(marked(T.VERDICT.UNANSWERED)) === false);
  check("and certainly not an accepted one", T.isIncorrect(marked(T.VERDICT.CORRECT)) === false);

  check("only an accepted answer closes the question", T.isAccepted(marked(T.VERDICT.CORRECT)));
  check("being wrong does not close it - that is what a second go is for",
    Object.values(T.VERDICT).filter((v) => v !== T.VERDICT.CORRECT).every((v) => T.isAccepted(marked(v)) === false));
  check("being unevaluable does not close it either",
    T.isAccepted(marked(T.VERDICT.UNVERIFIED)) === false);

  /* Nothing is a verdict, and must not be treated as one. */
  check("no mark at all is neither wrong nor accepted", T.isIncorrect(null) === false && T.isAccepted(null) === false);
  check("neither is an undefined mark", T.isIncorrect(undefined) === false && T.isAccepted(undefined) === false);
  check("nor one with no verdict on it", T.isIncorrect({}) === false && T.isAccepted({}) === false);

  /* Objective answers are marked by the same two questions. */
  const objective = T.markObjective({ options: ["a", "b"], correctIndex: 0 }, 1);
  check("a wrong option is incorrect", T.isIncorrect(objective));
  check("and does not close the question", T.isAccepted(objective) === false);
  const rightObjective = T.markObjective({ options: ["a", "b"], correctIndex: 0 }, 0);
  check("the right option closes it", T.isAccepted(rightObjective) && T.isIncorrect(rightObjective) === false);

  /* The list is exported so the panel and the tests cannot drift apart. */
  check("every listed verdict is a real verdict", T.INCORRECT_VERDICTS.every((v) => Object.values(T.VERDICT).includes(v)));
  check("and it is exactly the three failures", T.INCORRECT_VERDICTS.length === 3);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
