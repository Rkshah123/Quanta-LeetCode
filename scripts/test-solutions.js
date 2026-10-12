/* ------------------------ scripts / test-solutions --------------------- */
/* Solution comparison, checked without a browser.
   Usage:
     npm run test:solutions

   The whole value of this feature is that it reads the CODE rather than the
   complexity text the user typed. So the tests feed it code with a known shape
   and assert the estimate, including the cases where the honest answer is "I
   cannot tell" - a tool that always produces an estimate would be guessing. */

"use strict";

const S = require("../solutions");

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

const BRUTE = `
function twoSumBrute(nums, target) {
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      if (nums[i] + nums[j] === target) return [i, j];
    }
  }
  return [];
}`;

const BETTER = `
function twoSumHash(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    if (seen.has(target - nums[i])) return [seen.get(target - nums[i]), i];
    seen.set(nums[i], i);
  }
  return [];
}`;

const OPTIMAL_ONE_PASS = `
function maxSubarray(nums) {
  let best = nums[0], current = nums[0];
  for (let i = 1; i < nums.length; i++) {
    current = Math.max(nums[i], current + nums[i]);
    best = Math.max(best, current);
  }
  return best;
}`;

const NO_LOOPS = `function identity(x) { return x * 2; }`;

const BINARY = `
function search(arr, target) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}`;

const main = () => {
  console.log("\n== complexity estimation ==");
  check("a nested pair of data-sized loops is O(n²)", S.estimateComplexity(BRUTE).time === "O(n²)", S.estimateComplexity(BRUTE).reason);
  check("one loop over the input is O(n)", S.estimateComplexity(BETTER).time === "O(n)", S.estimateComplexity(BETTER).reason);
  check("a one-pass loop is O(n)", S.estimateComplexity(OPTIMAL_ONE_PASS).time === "O(n)");
  check("code with no loops is O(1)", S.estimateComplexity(NO_LOOPS).time === "O(1)", S.estimateComplexity(NO_LOOPS).reason);
  check("a halving loop is O(log n)", S.estimateComplexity(BINARY).time === "O(log n)", S.estimateComplexity(BINARY).reason);
  check("every estimate comes with a reason", [BRUTE, BETTER, NO_LOOPS, BINARY].every((code) => {
    const r = S.estimateComplexity(code);
    return typeof r.reason === "string" && r.reason.length > 20;
  }), "an estimate you cannot question is not worth showing");

  console.log("\n== honesty about the limits ==");
  const recursive = `function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }`;
  const recResult = S.estimateComplexity(recursive);
  check("plain recursion is NOT reported as O(1)", recResult.time !== "O(1)", `got ${recResult.time}`);
  check("and it is not silently guessed either", recResult.time === null, `got ${recResult.time}`);
  check("the refusal explains itself", /type the complexity yourself/i.test(recResult.reason), recResult.reason);
  check("empty code does not crash", S.estimateComplexity("").time === "O(1)");
  check("garbage code does not crash", S.estimateComplexity("}{ ][ ;;; ").time !== undefined);

  console.log("\n== comments and strings do not fool it ==");
  const withComment = `
// this comment mentions a for loop and a while loop and nesting
function f(arr) {
  /* a nested for loop for loop for */
  for (let i = 0; i < arr.length; i++) return arr[i];
}`;
  check("a loop mentioned only in a comment is not counted", S.estimateComplexity(withComment).time === "O(n)", S.estimateComplexity(withComment).reason);
  check("nested words in a block comment are ignored", S.analyseCode(withComment).loops.length === 1, `${S.analyseCode(withComment).loops.length} loops found`);
  const withString = `function f(arr) { const s = "for i in range(n): for j in range(n)"; for (let i = 0; i < arr.length; i++) return i; }`;
  check("a loop written in a string is not counted", S.analyseCode(withString).loops.length === 1);

  console.log("\n== space ==");
  check("no allocation is O(1)", S.estimateSpace(NO_LOOPS).space === "O(1)", S.estimateSpace(NO_LOOPS).reason);
  check("allocating a map or array is O(n)", S.estimateSpace(BETTER).space === "O(n)", S.estimateSpace(BETTER).reason);
  check("recursion's stack cost is not guessed", S.estimateSpace(recursive).space === null, S.estimateSpace(recursive).reason);
  check("every space estimate comes with a reason", [BRUTE, NO_LOOPS, recursive].every((c) => {
    const r = S.estimateSpace(c);
    return typeof r.reason === "string" && r.reason.length > 15;
  }));

  console.log("\n== ranking ==");
  const solutions = [
    { title: "brute", code: BRUTE, timeComplexity: "O(n^2)" },
    { title: "optimal", code: OPTIMAL_ONE_PASS, timeComplexity: "O(n)" },
    { title: "better", code: BETTER, timeComplexity: "O(n)" }
  ];
  const ranked = S.rankSolutions(solutions);
  check("all three are returned", ranked.ranked.length === 3);
  check("the brute force sorts last", ranked.ranked[2].title === "brute", ranked.ranked.map((r) => r.title).join(" > "));
  check("the one-pass solutions sort before it", ranked.ranked.slice(0, 2).every((r) => r.title !== "brute"));
  check("a complete ranking is reported", ranked.complete === true, `${ranked.unknownCount} unknown`);
  check("each ranked solution carries its reason", ranked.ranked.every((r) => r.timeReason && r.spaceReason));

  const withUnknown = S.rankSolutions([...solutions, { title: "recursive", code: recursive }]);
  check("an unreadable cost makes the ranking incomplete", withUnknown.complete === false);
  check("and it sorts LAST, never first", withUnknown.ranked[withUnknown.ranked.length - 1].title === "recursive", withUnknown.ranked.map((r) => r.title).join(" > "));
  check("the number of unknowns is reported", withUnknown.unknownCount === 1, String(withUnknown.unknownCount));

  check("one solution ranks fine", S.rankSolutions([{ title: "only", code: BETTER }]).ranked.length === 1);
  check("no solutions does not crash", S.rankSolutions([]).ranked.length === 0);

  console.log("\n== comparing what the user wrote ==");
  check("a matching note is confirmed", S.compareStated("O(n)", "O(n)").state === "agree", S.compareStated("O(n)", "O(n)").text);
  check("a wrong note is flagged, not silently replaced", S.compareStated("O(n)", "O(n²)").state === "disagree");
  check("the flag shows both numbers", /O\(n\)/.test(S.compareStated("O(n)", "O(n²)").text) && /n²/.test(S.compareStated("O(n)", "O(n²)").text), S.compareStated("O(n)", "O(n²)").text);
  check("it does not say the user is right", !/you are right|correct/i.test(S.compareStated("O(n)", "O(n²)").text));
  check("a missing note is reported as missing", S.compareStated("", "O(n)").state === "unstated");
  check("whitespace does not create a false disagreement", S.compareStated("  o( n ) ", "O(n)").state === "agree", S.compareStated("  o( n ) ", "O(n)").text);
  check("an unreadable cost says so", S.compareStated("O(n)", null).state === "unknown");

  console.log("\n== realistic solutions ==");
  /* Whole algorithms written the way someone would actually save them, checked
     against their known complexity. Every one of these was a real bug at some
     point: bubble sort read as O(n) because only the first loop on a line was
     seen, binary search read as O(n) because the halving lives in the body and
     not the header, BFS read as O(n^2) because the adjacency check looked for
     a keyword the header does not contain, merge sort read as O(1) because its
     function name collided with the built-in sort in the recursion allow-list,
     and Kadane read as recursion because Math.max looked like a self-call. */
  const REAL = [
    ["binary search", "O(log n)", `function search(a,t){let lo=0,hi=a.length-1;while(lo<=hi){const mid=lo+((hi-lo)>>1);if(a[mid]===t)return mid;if(a[mid]<t)lo=mid+1;else hi=mid-1;}return -1;}`],
    ["bubble sort", "O(n²)", `function bs(a){for(let i=0;i<a.length;i++)for(let j=0;j<a.length-i-1;j++)if(a[j]>a[j+1])[a[j],a[j+1]]=[a[j+1],a[j]];return a;}`],
    ["kadane", "O(n)", `function mx(a){let best=a[0],cur=a[0];for(let i=1;i<a.length;i++){cur=Math.max(a[i],cur+a[i]);best=Math.max(best,cur);}return best;}`],
    ["breadth-first search", "O(n)", `function bfs(g,s){const q=[s],seen=new Set([s]);while(q.length){const n=q.shift();for(const x of g[n])if(!seen.has(x)){seen.add(x);q.push(x);}}return seen;}`],
    ["two sum with a hash", "O(n)", `function two(a,t){const m=new Map();for(let i=0;i<a.length;i++){if(m.has(t-a[i]))return [m.get(t-a[i]),i];m.set(a[i],i);}return [];}`],
    ["array getter", "O(1)", `function get(a,i){return a[i];}`]
  ];
  for (const [name, expected, code] of REAL) {
    check(`${name} reads as ${expected}`, S.estimateComplexity(code).time === expected, `got ${S.estimateComplexity(code).time}`);
  }

  /* The two that cannot be read off a shape must be refused, not guessed. */
  check("merge sort is refused, not called O(1)", S.estimateComplexity(`function msort(a){if(a.length<2)return a;const m=a.length>>1;return merge(msort(a.slice(0,m)),msort(a.slice(m)));}`).time === null);
  check("factorial is refused, not called O(1)", S.estimateComplexity(`function fact(n){return n<=1?1:n*fact(n-1);}`).time === null);
  check("a user function called sort is not mistaken for the built-in", S.estimateComplexity(`function sort(a){return a.length;}`).time === "O(1)", S.estimateComplexity(`function sort(a){return a.length;}`).reason);
  check("calling Math.max is not mistaken for recursion", S.estimateSpace(`function m(a){return Math.max(...a);}`).space === "O(1)");

  console.log("\n== it never claims correctness ==");
  const allText = [BRUTE, BETTER, OPTIMAL_ONE_PASS].map((c) => S.rankSolutions([{ code: c }]).ranked[0]).flatMap((r) => [r.timeReason, r.spaceReason]).join(" ");
  check("no estimate claims the code is correct or passes", !/\b(correct|passes|accepted|works)\b/i.test(allText));
  check("the label list has no placeholder entries", S.COMPLEXITY_LABELS.every((l) => l && l.startsWith("O(")));

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
};

main();
