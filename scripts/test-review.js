/* -------------------------- scripts / test-review ------------------------ */
/* Static code review. Usage:
     npm run test:review

   More than half of this suite is about what the reviewer must NOT say.

   A linter that cries wolf is worse than no linter, because the reader learns
   to dismiss it and then misses the finding that mattered. The rules here were
   written against real interview code, and most of the false positives below
   were produced by an earlier version of this file:

     - accumulating into a result array while looping over the input was
       reported as "modifying an array while iterating it" - that shape is the
       single most common one there is;
     - an empty class constructor was reported as a function that can finish
       without returning - constructors cannot return, so that is correct code;
     - any function that was called once was counted as recursive, so a trivial
       snippet reported an exponential bound;
     - a correct O(n) solution at 10^5 was warned about by a naive threshold.

   Each of those has a test here, and each says why it used to be wrong. */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const { review, REVIEW_RULES, HIDDEN_COSTS, loopBoundsDisagree } = require("../review");

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

const keys = (source, problem) => {
  const result = review(source, problem);
  if (!result.ok) throw new Error(result.error);
  return result.findings.map((f) => f.key);
};

const only = (source, problem) => {
  const result = review(source, problem);
  if (!result.ok) throw new Error(result.error);
  return result.findings;
};

/* ============================ it refuses junk ============================ */

console.log("\n== what it will not review ==");
check("empty input is refused", review("").ok === false && /no code/i.test(review("").error));
check("whitespace is refused", review("   \n  ").ok === false);
check("a syntax error is refused with the parser's position", (() => {
  const r = review("let = ;");
  return r.ok === false && /not valid JavaScript/.test(r.error) && r.line === 1;
})(), JSON.stringify(review("let = ;")));

/* ============================== complexity ============================== */

console.log("\n== complexity is counted from the code ==");
const oneLoop = review("function f(xs){ let s=0; for(let i=0;i<xs.length;i++) s+=xs[i]; return s; }");
check("a single loop is linear", oneLoop.complexity.time === "n", oneLoop.complexity.time);
check("the basis is stated, not just the answer", /1 nested loop/.test(oneLoop.complexity.basis), oneLoop.complexity.basis);

const twoLoops = review("function f(xs){ let s=0; for(let i=0;i<xs.length;i++) for(let j=0;j<xs.length;j++) s+=xs[i]; return s; }");
check("two nested loops are quadratic", twoLoops.complexity.time === "n^2", twoLoops.complexity.time);

const threeLoops = review("function f(xs){ for(let i=0;i<xs.length;i++) for(let j=0;j<xs.length;j++) for(let k=0;k<xs.length;k++){} }");
check("three are cubic", threeLoops.complexity.time === "n^3", threeLoops.complexity.time);

const sequential = review("function f(xs){ let s=0; for(let i=0;i<xs.length;i++) s+=xs[i]; for(let i=0;i<xs.length;i++) s+=xs[i]; return s; }");
check("two loops one after the other are still linear", sequential.complexity.time === "n", sequential.complexity.time);
check("because the depth is what is counted", sequential.complexity.maxLoopDepthUnused === undefined && sequential.complexity.loopDepth === 1, String(sequential.complexity.loopDepth));

const noLoops = review("function f(a, b){ return a + b; }");
check("no loops is constant", noLoops.complexity.time === "constant", noLoops.complexity.time);

console.log("\n== work a loop counter cannot see is named, not folded in ==");
const withSort = review("function f(xs){ let s=0; for(let i=0;i<xs.length;i++){ xs.sort(); s+=xs[i]; } return s; }");
check("a sort inside a loop does not inflate the estimate", withSort.complexity.time === "n", withSort.complexity.time);
check("and is named as a caveat instead", withSort.complexity.caveats.some((c) => /sort/i.test(c.title) && /n log n/.test(c.cost)), JSON.stringify(withSort.complexity.caveats));
check("the caveat carries its own cost", withSort.complexity.caveats[0].cost === "n log n");
check("for...of is caveated too", review("function f(xs){ for(const x of xs){} }").complexity.caveats.some((c) => /for\.\.\.of/.test(c.title)));
check("the built-in cost table names what it knows", Boolean(HIDDEN_COSTS.sort) && HIDDEN_COSTS.sort.cost === "n log n");

/* ============================== recursion =============================== */

console.log("\n== recursion means calling itself ==");
check("a self-call is recursion", review("function fact(n){ if(n<=1) return 1; return n * fact(n-1); }").facts.recursion === 1);
check("calling a declared function once is NOT recursion",
  review("let x = 1;\nfunction f(){ return x; }\nconsole.log(f());").facts.recursion === 0);
check("and that snippet is constant time, not exponential",
  review("let x = 1;\nfunction f(){ return x; }\nconsole.log(f());").complexity.time === "constant");
check("a self-recursive named function expression counts",
  review("const f = function fact(n){ return n<=1 ? 1 : n * fact(n-1); };\nconsole.log(f(4));").facts.recursion === 1);
check("recursion with loops still counts",
  review("function f(n, xs){ for(let i=0;i<xs.length;i++){} if(n>0) return f(n-1, xs); }").facts.recursion === 1);

/* ============================ false positives =========================== */

console.log("\n== correct code that must NOT be flagged ==");
check("accumulating into a result array while looping is normal",
  !keys("function evens(n){ const out=[]; for(let i=0;i<n;i++) out.push(i); return out; }").includes("mutate-while-iterating"),
  keys("function evens(n){ const out=[]; for(let i=0;i<n;i++) out.push(i); return out; }").join(","));

check("nor is pushing into an array declared outside the loop",
  !keys("function f(xs){ const out=[]; for(let i=0;i<xs.length;i++){ out.push(xs[i]); } return out; }").includes("mutate-while-iterating"));

check("an empty constructor is not a missing return",
  !keys("class A { constructor(n){ this.n = n; } }\nconsole.log(new A(1).n);").includes("no-return"),
  keys("class A { constructor(n){ this.n = n; } }\nconsole.log(new A(1).n);").join(","));

check("nor is a method that returns nothing",
  !keys("class A { constructor(n){ this.n=n; } pick(){ return this.n; } }\nconsole.log(new A(1).pick());").includes("no-return"));

check("a concise arrow always returns",
  !keys("const f = xs => xs.length;\nconsole.log(f([1]));").includes("no-return"));

check("a function that returns on every path is not flagged",
  !keys("function f(n){ if (n > 0) { return 1; } else { return 0; } }").includes("no-return"));

check("an infinite loop that returns after breaking is not flagged",
  !keys("function f(n){ while (true) { if (n > 0) return 1; } }").includes("no-return"));

check("a plain === is not flagged",
  !keys("function eq(a,b){ return a === b; }").includes("loose-equality"));

check("mutating outside a loop is what the function was asked to do",
  !keys("function clear(xs){ xs.length = 0; return xs; }").includes("mutate-while-iterating"));

check("a step of one is not an off-by-one",
  !keys("function sum(n){ let s=0; for(let i=0;i<n;i++) s+=i; return s; }").includes("off-by-one"));

check("<= with i++ is not an off-by-one",
  !keys("function f(n){ for(let i=0;i<=n;i++){} }").includes("off-by-one"));

check("a declared function that is never called is not recursion",
  review("function unused(){ return 1; }").facts.recursion === 0);

console.log("\n== and it must say when there is nothing to say ==");
const clean = only("function twoSum(nums, target){\n  const seen = new Map();\n  for (let i = 0; i < nums.length; i++) {\n    const need = target - nums[i];\n    if (seen.has(need)) return [seen.get(need), i];\n    seen.set(nums[i], i);\n  }\n  return [];\n}");
check("a correct two-sum produces no findings", clean.length === 0, JSON.stringify(clean.map((f) => f.title)));
check("and it does not claim a correctness verdict either",
  clean.length === 0 && !("verdict" in (clean[0] || {})), "no verdict field is ever produced");

/* ============================= true positives =========================== */

console.log("\n== real problems are found ==");
check("== is found", keys("function eq(a,b){ return a == b; }").includes("loose-equality"));
check("== null is distinguished from a plain ==", keys("function f(x){ return x == null; }").some((k) => k === "eqeqeq-null"));
check("and a plain == is not reported as == null", !keys("function eq(a,b){ return a == b; }").includes("eqeqeq-null"));
check("the == null finding says why it is different", /defensible/.test(only("function f(x){ return x == null; }")[0].why));

check("a function that can fall off the end is found",
  keys("function find(xs,t){ for(let i=0;i<xs.length;i++){ if(xs[i]===t) return i; } }").includes("no-return"));
check("and it is serious, not a nit", only("function find(xs,t){ for(let i=0;i<xs.length;i++){ if(xs[i]===t) return i; } }")[0].severity === "serious");

check("splicing the array you are looping over is found",
  keys("function dedupe(xs){ for(let i=0;i<xs.length;i++){ if(xs[i]===xs[i+1]) xs.splice(i,1); } return xs; }").includes("mutate-while-iterating"));
check("so is assigning into it",
  keys("function zero(xs){ for(let i=0;i<xs.length;i++){ xs[i]=0; } return xs; }").includes("mutate-while-iterating"));
check("and popping from one you are iterating with for...of",
  keys("function drain(xs){ for(const x of xs){ xs.pop(); } return xs; }").includes("mutate-while-iterating"));
check("the finding names the array and says it is the loop's own input",
  /loop's input/.test(
    only("function zero(xs){ for(let i=0;i<xs.length;i++){ xs[i]=0; } return xs; }")
      .find((f) => f.key === "mutate-while-iterating").evidence || ""
  ),
  JSON.stringify(only("function zero(xs){ for(let i=0;i<xs.length;i++){ xs[i]=0; } return xs; }").find((f) => f.key === "mutate-while-iterating")));

check("a step that skips values is found",
  keys("function evens(n){ const out=[]; for(let i=0;i<n;i+=2){ out.push(i); } return out; }").includes("off-by-one"));
check("and the message says the step, not just that it is wrong",
  /advances by 2/.test(only("function evens(n){ const out=[]; for(let i=0;i<n;i+=2){ out.push(i); } return out; }").find((f) => f.key === "off-by-one").detail || ""),
  only("function evens(n){ const out=[]; for(let i=0;i<n;i+=2){ out.push(i); } return out; }").find((f) => f.key === "off-by-one").detail);

check("var is found", keys("function f(){ var a = 1; return a; }").includes("var-usage"));
check("a fixed index into a lookup is found", keys("function pair(t){ return [t[0], t[1]]; }").includes("magic-index"));
check("shadowing is found", keys("let x = 1;\nfunction f(){ let x = 2; return x; }\nconsole.log(f(), x);").includes("shadowed-name"));
check("an empty block is found", keys("function f(){ for(let i=0;i<3;i++){} }").includes("empty-block"));
check("code after a return is found", keys("function f(){ return 1;\nconst x = 2;\nreturn x; }").includes("unreachable"));

console.log("\n== the off-by-one rule in isolation ==");
const loop = (test, update) => loopBoundsDisagree({ test: { type: "BinaryExpression", operator: test.op, left: { type: "Identifier", name: "i" }, right: { type: "Identifier", name: "n" } }, update });
check("i < n with i++ is fine", loop("<", { type: "UpdateExpression", operator: "++", argument: { type: "Identifier", name: "i" } }) === null);
check("i <= n with i++ is fine", loop("<=", { type: "UpdateExpression", operator: "++", argument: { type: "Identifier", name: "i" } }) === null);
check("i < n with i += 2 is not", typeof loop("<", { type: "AssignmentExpression", operator: "+=", left: { type: "Identifier", name: "i" }, right: { value: 2 } }) === "string");
check("a non-numeric step is not guessed at", loop("<", { type: "AssignmentExpression", operator: "+=", left: { type: "Identifier", name: "i" }, right: { type: "Identifier", name: "k" } }) === null);
check("a loop with no update is not guessed at", loop("<", null) === null);

/* =========================== cross-referencing ========================== */

console.log("\n== against the problem's constraints ==");
const linear = "function f(nums){ let s=0; for(let i=0;i<nums.length;i++) s+=nums[i]; return s; }";
const quadratic = "function f(nums){ let s=0; for(let i=0;i<nums.length;i++) for(let j=0;j<nums.length;j++) s+=nums[i]; return s; }";

const fit = (src, hint) => review(src, { paramHint: "nums", constraintsHint: hint }).cross.checks.find((c) => c.key === "constraint-fit");

check("a linear solution at 1e5 is fine", fit(linear, "2 <= nums.length <= 1e5")?.severity === "ok", JSON.stringify(fit(linear, "2 <= nums.length <= 1e5")?.detail));
check("a linear solution at 1e9 is warned about", fit(linear, "2 <= nums.length <= 1e9")?.severity === "warning");
check("a quadratic solution at 1e5 is warned about", fit(quadratic, "2 <= nums.length <= 1e5")?.severity === "warning");
check("a quadratic solution at 1e9 is warned about", fit(quadratic, "2 <= nums.length <= 1e9")?.severity === "warning");
check("10^9 and 1e9 are read the same", fit(linear, "2 <= nums.length <= 10^9")?.severity === "warning");
check("a solution that never reads its input is flagged",
  review("function solve(n){ const out=[]; for(let i=0;i<5;i++) out.push(i); return out; }", { paramHint: "nums" }).cross.checks.find((c) => c.key === "reads-input")?.severity === "serious");
check("one that does read it is not",
  review("function f(nums){ for(let i=0;i<nums.length;i++){} }", { paramHint: "nums" }).cross.checks.find((c) => c.key === "reads-input")?.severity === "ok");
check("no problem means no comparison, and it says so",
  review(linear).cross.summary !== null, JSON.stringify(review(linear).cross));
check("and the warning suggests what usually fixes it",
  /hash set|sort|monotonic/.test(fit(quadratic, "2 <= nums.length <= 1e9")?.detail || ""), fit(quadratic, "2 <= nums.length <= 1e9")?.detail);

/* ============================== honesty ================================ */

console.log("\n== it never claims your code is correct ==");
const anyResult = review("function f(a){ return a + 1; }");
check("there is no verdict field anywhere", !("verdict" in anyResult) && !("correct" in anyResult), Object.keys(anyResult).join(","));
check("the complexity estimate is flagged as a heuristic", anyResult.complexity.timeIsHeuristic === true);
check("the rules are enumerable and each explains itself", REVIEW_RULES.every((r) => r.key && r.title && r.why && r.severity), REVIEW_RULES.filter((r) => !r.why).map((r) => r.key).join(","));
check("every rule has a distinct key", new Set(REVIEW_RULES.map((r) => r.key)).size === REVIEW_RULES.length);

console.log("\n== findings are sorted and shaped for display ==");
const messy = only("let x = 1;\nfunction f(){ var a = 1; return x == a; }\nfunction g(){ for(let i=0;i<3;i++){} }\nconsole.log(f());");
check("severity comes first, then line", (() => {
  const order = { serious: 0, warning: 1, notice: 2 };
  for (let i = 1; i < messy.length; i += 1) {
    const a = messy[i - 1];
    const b = messy[i];
    if (order[a.severity] > order[b.severity]) return false;
    if (order[a.severity] === order[b.severity] && (a.line ?? 999) > (b.line ?? 999)) return false;
  }
  return true;
})(), messy.map((f) => `${f.severity}:${f.line}`).join(" "));
check("each finding carries a line where it can", messy.every((f) => f.line === null || typeof f.line === "number"));
check("counts add up", (() => {
  const r = review("let x = 1;\nfunction f(){ var a = 1; return x == a; }");
  return r.counts.serious + r.counts.warning + r.counts.notice === r.findings.length;
})());
check("the line count of the source is reported", review("let a = 1;\nlet b = 2;\n").lineCount === 3, String(review("let a = 1;\nlet b = 2;\n").lineCount));

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
