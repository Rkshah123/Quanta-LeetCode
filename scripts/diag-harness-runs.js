"use strict";
/* Do the Python and JavaScript harnesses actually RUN correctly?

   diag-examples.js showed a harness can be BUILT for 96% of real statements.
   Building is not running. A harness that compiles but calls the wrong thing,
   or prints in a shape the comparison cannot read, would turn a correct answer
   into a wrong one - the exact failure this whole area is careful about.

   So: real statement, real starter shape, real solutions, run through the same
   /api/run the app uses. Correct solutions must come back correct, and broken
   ones must come back wrong - never the other way round.
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ quiet: true });

const BASE = process.env.RUN_BASE || "http://localhost:3000";
const { query, closePool } = require(path.join(__dirname, "..", "db", "pool"));
const T = require(path.join(__dirname, "..", "mocktest.js"));


/* JavaScript is evaluated in the browser by the app, never on the compile
   server, so it is evaluated here the same way: the harness runs, and whatever
   it logged is the output. */
const runJavaScript = async (code) => {
  const logs = [];
  const original = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    new Function(code)();
    return { ok: true, stdout: logs.join("\n"), stderr: "", phase: "run" };
  } catch (error) {
    return { ok: false, stdout: logs.join("\n"), stderr: String(error && error.message), phase: "run" };
  } finally {
    console.log = original;
  }
};

const run = async (language, code) => {
  if (language === "javascript") return runJavaScript(code);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch(`${BASE}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, code, stdin: "" }),
      signal: controller.signal
    });
    if (!res.ok) return { ok: false, stdout: "", stderr: `HTTP ${res.status}`, phase: "run" };
    return await res.json();
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e.message), phase: "network" };
  } finally {
    clearTimeout(timer);
  }
};

/* Real LeetCode Python starter shape, and a solution that is genuinely right. */
const PY_RIGHT = `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, n in enumerate(nums):
            if target - n in seen:
                return [seen[target - n], i]
            seen[n] = i
        return []`;

const PY_WRONG = `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        return [1, 0]`;

const PY_BOOM = `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        raise ValueError("boom")`;

const JS_RIGHT = `function twoSum(nums, target) {
  const seen = {};
  for (let i = 0; i < nums.length; i++) { if (target - nums[i] in seen) return [seen[target - nums[i]], i]; seen[nums[i]] = i; }
  return [];
}`;
const JS_WRONG = `function twoSum(nums, target) { return [1, 0]; }`;

(async () => {
  const rows = await query(
    `SELECT slug, description_html FROM problems
      WHERE slug = 'two-sum' LIMIT 1`
  );
  if (!rows.length) { console.log("two-sum not in the catalog"); await closePool(); process.exit(1); }
  const examples = T.parseAllExamples(rows[0].description_html);
  console.log(`two-sum: ${examples.length} example(s) parsed`);
  console.log(`  ${JSON.stringify(examples[0])}\n`);

  let bad = 0;
  const report = (name, ok, detail = "") => {
    if (!ok) bad += 1;
    console.log(`${ok ? "OK  " : "BAD "} ${name}${detail ? "  <- " + detail : ""}`);
  };

  /* --- Python, every example --- */
  for (const ex of examples) {
    const harness = T.buildPythonHarness(PY_RIGHT, ex);
    if (!harness) { report(`python harness for ${ex.label}`, false, "not built"); continue; }
    const out = await run("python", harness);
    const test = await T.runExampleTest({ harness, expected: ex.expected, expectedLabel: ex.label, run: (h) => run("python", h) });
    report(`python right solution passes ${ex.label}`, test && test.passed === true,
      test ? `got ${test.got} expected ${test.expected}` : `raw: ${(out.stderr || out.stdout || "").slice(0, 90)}`);
  }

  {
    const harness = T.buildPythonHarness(PY_WRONG, examples[0]);
    const out = await run("python", harness);
    const test = await T.runExampleTest({ harness, expected: examples[0].expected, expectedLabel: examples[0].label, run: (h) => run("python", h) });
    report("python wrong solution fails", test !== null && test.passed === false,
      test ? `got ${test.got}` : `no test row - raw: ${(out.stderr || out.stdout || "").slice(0, 110)}`);
  }
  {
    const harness = T.buildPythonHarness(PY_BOOM, examples[0]);
    const out = await run("python", harness);
    const test = await T.runExampleTest({ harness, expected: examples[0].expected, expectedLabel: examples[0].label, run: (h) => run("python", h) });
    /* The important property: a crash must produce NO test row, never a failed
       one. A crashed check must never cost a mark. */
    report("python crashing solution yields no test row at all", test === null,
      test ? `got a row saying passed=${test.passed}` : "no row (correct)");
  }

  /* --- JavaScript, same three shapes --- */
  for (const ex of examples) {
    const harness = T.buildJsHarness(JS_RIGHT, ex);
    const test = await T.runExampleTest({ harness, expected: ex.expected, expectedLabel: ex.label, run: runJavaScript });
    report(`javascript right solution passes ${ex.label}`, test && test.passed === true,
      test ? `got ${test.got} expected ${test.expected}` : "no row");
  }
  {
    const harness = T.buildJsHarness(JS_WRONG, examples[0]);
    const test = await T.runExampleTest({ harness, expected: examples[0].expected, expectedLabel: examples[0].label, run: runJavaScript });
    report("javascript wrong solution fails", test !== null && test.passed === false, test ? `got ${test.got}` : "no row");
  }


/* --------------------------------- Java --------------------------------- */

const JAVA_TWO_SUM_RIGHT = `class Solution {
    public int[] twoSum(int[] nums, int target) {
        Map<Integer, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            int need = target - nums[i];
            if (seen.containsKey(need)) return new int[]{seen.get(need), i};
            seen.put(nums[i], i);
        }
        return new int[0];
    }
}`;

const JAVA_TWO_SUM_WRONG = `class Solution {
    public int[] twoSum(int[] nums, int target) {
        return new int[]{1, 0};
    }
}`;

const JAVA_TWO_SUM_BOOM = `class Solution {
    public int[] twoSum(int[] nums, int target) {
        throw new RuntimeException("boom");
    }
}`;

/* A signature with a List parameter and a boolean result - the two shapes that
   break a naive harness. */
const JAVA_VALID_PARENTHESES = `class Solution {
    public boolean isValid(String s) {
        java.util.Deque<Character> stack = new java.util.ArrayDeque<>();
        for (char c : s.toCharArray()) {
            if (c == '(') stack.push(')');
            else if (c == '[') stack.push(']');
            else if (c == '{') stack.push('}');
            else if (stack.isEmpty() || stack.pop() != c) return false;
        }
        return stack.isEmpty();
    }
}`;

const runJavaBlock = async () => {
  const rows = await query("SELECT slug, description_html FROM problems WHERE slug IN ('two-sum','valid-parentheses')");
  const twoSum = rows.find((r) => r.slug === "two-sum");
  const parens = rows.find((r) => r.slug === "valid-parentheses");
  if (!twoSum) { console.log("two-sum missing"); return 1; }
  let bad = 0;
  const report = (name, ok, detail = "") => { if (!ok) bad += 1; console.log(`${ok ? "OK  " : "BAD "} ${name}${detail ? "  <- " + detail : ""}`); };

  const ex = T.parseAllExamples(twoSum.description_html);
  for (const e of ex) {
    const harness = T.buildJavaHarness(JAVA_TWO_SUM_RIGHT, e);
    const test = harness ? await T.runExampleTest({ harness, expected: e.expected, expectedLabel: e.label, run: (h) => run("java", h) }) : null;
    report(`java right solution passes ${e.label}`, test && test.passed === true,
      test ? `got ${test.got} expected ${test.expected}` : "no row");
  }
  {
    const harness = T.buildJavaHarness(JAVA_TWO_SUM_WRONG, ex[0]);
    const test = await T.runExampleTest({ harness, expected: ex[0].expected, expectedLabel: ex[0].label, run: (h) => run("java", h) });
    report("java wrong solution fails", test !== null && test.passed === false, test ? `got ${test.got}` : "no row");
  }
  {
    const harness = T.buildJavaHarness(JAVA_TWO_SUM_BOOM, ex[0]);
    const out = await run("java", harness);
    const test = await T.runExampleTest({ harness, expected: ex[0].expected, expectedLabel: ex[0].label, run: (h) => run("java", h) });
    report("java crashing solution yields no test row", test === null, test ? `row passed=${test.passed}` : `no row (correct); stderr=${(out.stderr||"").slice(0,60)}`);
  }
  if (parens) {
    const pex = T.parseAllExamples(parens.description_html);
    for (const e of pex) {
      const harness = T.buildJavaHarness(JAVA_VALID_PARENTHESES, e);
      const test = harness ? await T.runExampleTest({ harness, expected: e.expected, expectedLabel: e.label, run: (h) => run("java", h) }) : null;
      report(`java String->boolean solution passes ${e.label}`, test && test.passed === true,
        test ? `got ${test.got} expected ${test.expected}` : `no row; args=${JSON.stringify(e.args)}`);
    }
  }
  return bad;
};

const javaBad = await runJavaBlock();
console.log(javaBad ? `java: ${javaBad} FAILED` : "java: every case behaved");

  bad += javaBad;
  console.log(bad ? `\n${bad} FAILED` : "\nevery harness ran, and every verdict was the right way round");
  await closePool();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });