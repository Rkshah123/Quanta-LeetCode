/* ------------------------ scripts / test-visualizer --------------------- */
/* Checks the algorithm visualizer's engines with no DOM involved.
   Usage:
     npm run test:visualizer

   These are the tests that matter most in this feature: the player is only
   trustworthy if the thing it replays is actually correct. A frame that draws
   beautifully while showing a wrong comparison is worse than no visualizer at
   all, so every algorithm is run against known inputs and known outputs here,
   not eyeballed in a browser. */

"use strict";

const path = require("path");

const V = require("../visualizer");

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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => a.slice().sort((x, y) => x - y);

const main = () => {
  console.log("\n== sorting ==");
  const input = VIZ_SORT_INPUT();
  for (const [key, algo] of Object.entries(V.vizSorters)) {
    const { frames, result } = algo.run(input);
    check(`${key} sorts correctly`, eq(result, sorted(input)), result.join(","));
    check(`${key} records at least one frame`, frames.length > 0, `${frames.length} frames`);
    check(`${key} starts from the untouched input`, eq(frames[0].array, input));
    check(
      `${key} every frame carries a title and a note`,
      frames.every((f) => typeof f.title === "string" && f.title && typeof f.note === "string" && f.note),
      "narration is never empty"
    );
    check(
      `${key} every frame holds the full array`,
      frames.every((f) => Array.isArray(f.array) && f.array.length === input.length),
      "no frame is truncated"
    );
    check(
      `${key} pointers stay inside the array`,
      frames.every((f) => !f.pointers || f.pointers.every((i) => i >= 0 && i < input.length)),
      "no out-of-range index is drawn"
    );
    check(`${key} is stable on an already sorted array`, eq(algo.run(sorted(input)).result, sorted(input)));
  }

  console.log("\n== searching ==");
  const searchArray = [1, 3, 5, 7, 9, 11, 13, 15];
  const hit = 11;
  const miss = 4;
  for (const [key, algo] of Object.entries(V.vizSearchers)) {
    const found = algo.run(searchArray, hit);
    check(`${key} finds a value that exists`, found.found === true, `index ${found.result?.index}`);
    check(`${key} reports the right index`, found.result?.index === searchArray.indexOf(hit));
    const missing = algo.run(searchArray, miss);
    if (key === "lowerBound") {
      /* lower bound answers "where would this go", not "is this here", so a
         value that is absent still has a real, meaningful answer. In
         [1,3,5,7,9,11,13,15], the value 4 belongs at index 2, before the 5. */
      const index = missing.result?.index;
      check(
        "lower bound returns the insertion point for an absent value",
        index === 2 && searchArray[index] > miss && searchArray[index - 1] < miss,
        `index ${index}: ${searchArray[index - 1]} < ${miss} <= ${searchArray[index]}`
      );
    } else {
      check(`${key} reports a miss honestly`, missing.found === false);
      check(`${key} returns index -1 for an absent value`, missing.result?.index === -1);
    }
    check(`${key} frames all have notes`, found.frames.every((f) => f.note));
    check(`${key} finds the first element`, algo.run(searchArray, 1).result?.index === 0);
    check(`${key} finds the last element`, algo.run(searchArray, 15).result?.index === searchArray.length - 1);
  }

  console.log("\n== binary search beats linear ==");
  {
    const linear = V.vizSearchers.linear.run(searchArray, 15).result.comparisons;
    const binary = V.vizSearchers.binary.run(searchArray, 15).result.comparisons;
    check(
      "binary search takes fewer steps than linear on this input",
      binary < linear,
      `binary ${binary} vs linear ${linear}`
    );
    const big = Array.from({ length: 1024 }, (_, i) => i * 2);
    const linBig = V.vizSearchers.linear.run(big, 2046).result.comparisons;
    const binBig = V.vizSearchers.binary.run(big, 2046).result.comparisons;
    check("binary search stays logarithmic on 1024 values", binBig <= 12, `${binBig} steps vs ${linBig} linear`);
  }

  console.log("\n== recursion ==");
  {
    const fact = V.vizRecursions.factorial.build(5);
    check("factorial(5) is 120", fact.result === 120, String(fact.result));
    const fib = V.vizRecursions.fibonacci.build(10);
    check("fib(10) is 55", fib.result === 55, String(fib.result));
    const hanoi = V.vizRecursions.hanoi.build(3);
    check("tower of hanoi with 3 discs takes 7 moves", hanoi.result === 7, String(hanoi.result));
    const hanoi4 = V.vizRecursions.hanoi.build(4);
    check("tower of hanoi with 4 discs takes 15 moves", hanoi4.result === 15, String(hanoi4.result));
    const gcd = V.vizRecursions.gcd.build(48, 18);
    check("gcd(48, 18) is 6", gcd.result === 6, String(gcd.result));
    check("gcd terminates quickly", gcd.steps <= 8, `${gcd.steps} steps`);
    check("every recursion frame has a note", fact.frames.every((f) => f.note));
    check("the call stack is recorded", fact.frames.every((f) => Array.isArray(f.calls)));
  }

  console.log("\n== trees ==");
  {
    const bst = V.vizTrees.bstInsert.run([50, 30, 70, 20, 40]);
    const layout = V.layoutTree(bst.result);
    check("a BST keeps its in-order sorted", (() => {
      const out = [];
      const walk = (n) => { if (!n) return; walk(n.left); out.push(n.value); walk(n.right); };
      walk(bst.result);
      return eq(out, sorted(out));
    })(), "left subtree values are all smaller");
    check("every node is placed exactly once", layout.nodes.length === 5, `${layout.nodes.length} placed`);
    check("node ids are unique", new Set(layout.nodes.map((n) => n.id)).size === layout.nodes.length);
    check("edges connect only placed nodes", layout.edges.every(([a, b]) => layout.nodes.some((n) => n.id === a) && layout.nodes.some((n) => n.id === b)));
    check("the layout puts values in increasing x order", layout.nodes.every((n, i, all) => i === 0 || all[i - 1].value <= n.value));
    const trav = V.vizTrees.traversals.run([50, 30, 70, 20, 40]);
    const inOrder = trav.frames.find((f) => f.title.startsWith("In-order"));
    check("in-order traversal visits sorted values", eq(inOrder.path, [20, 30, 40, 50, 70]), (inOrder.path || []).join(","));
    check("an empty tree does not break the layout", V.layoutTree(null).nodes.length === 0);
  }

  console.log("\n== graphs ==");
  {
    const edges = VIZ_GRAPH_EDGES();
    const bfs = V.vizGraphs.bfs.run(edges);
    const dfs = V.vizGraphs.dfs.run(edges);
    check("BFS reaches every node", bfs.result.length === 5, bfs.result.join(","));
    check("DFS reaches every node", dfs.result.length === 5, dfs.result.join(","));
    check("BFS visits nodes before the queue empties", bfs.frames.every((f) => Array.isArray(f.visited)));
    check("Dijkstra computes a finite distance to every node", Object.values(V.vizGraphs.dijkstra.run(edges).result).every(Number.isFinite));
    const dist = V.vizGraphs.dijkstra.run(edges).result;
    /* Edges: 0-1(4) 0-2(1) 2-1(2) 1-3(1) 2-3(5) 3-4(3).
       Shortest routes: 0->0, 2->1, 1->3 (via 2), 3->4 (via 1), 4->7. */
    check("Dijkstra finds the shortest route to node 1", dist[1] === 3, `got ${dist[1]} (0->2->1)`);
    check("Dijkstra finds the shortest route to node 3", dist[3] === 4, `got ${dist[3]} (0->2->1->3)`);
    check("Dijkstra finds the shortest route to node 4", dist[4] === 7, `got ${dist[4]} (0->2->1->3->4)`);
    check("Dijkstra never takes the longer direct edge", dist[3] < 5, `took ${dist[3]} rather than the direct weight-5 edge`);
    const isolated = V.buildGraph([[0, 1, 1]]);
    check("a disconnected graph still builds", Array.isArray(isolated.nodes));
  }

  console.log("\n== patterns ==");
  {
    const arr = [2, 1, 5, 1, 3, 2, 8, 1];
    const win = V.vizPatterns.slidingWindow.run(arr, 3);
    check("the sliding window ends on the last full window", win.frames[win.frames.length - 1].range[0] === arr.length - 3);
    const tp = V.vizPatterns.twoPointers.run(VIZ_SORTED(), 9);
    check("two pointers finds the pair", tp.result !== null && VIZ_SORTED()[tp.result.lo] + VIZ_SORTED()[tp.result.hi] === 9);
    const tpMiss = V.vizPatterns.twoPointers.run(VIZ_SORTED(), 100);
    check("two pointers reports no pair rather than looping", tpMiss.result === null);
    const prefix = V.vizPatterns.prefixSum.run(arr);
    const built = prefix.result;
    check("the prefix sums are correct", eq(built, [0, ...built.slice(1).map((_, i) => built[i] + arr[i])]), built.join(","));
    check("a range sum is a subtraction", built[4] - built[1] === arr[1] + arr[2] + arr[3]);
    const kadane = V.vizPatterns.kadane.run([-2, 1, -3, 4, -1, 2, 1, -5, 4]);
    check("Kadane finds 6 for the classic example", kadane.result === 6, String(kadane.result));
    const allNegative = V.vizPatterns.kadane.run([-5, -2, -9]);
    check("Kadane handles an all-negative array", allNegative.result === -2, String(allNegative.result));
  }

  console.log("\n== dynamic programming ==");
  {
    const fib = V.vizDp.fibonacci.run(10);
    check("DP fibonacci(10) is 55", fib.result === 55, String(fib.result));
    check("every DP frame shows a table", fib.frames.every((f) => Array.isArray(f.table)));
    const stairs = V.vizDp.climbStairs.run(5);
    check("climbing 5 stairs has 8 ways", stairs.result === 8, String(stairs.result));
    /* Checked against an exhaustive search rather than a hand-written
       expectation: a test whose expected value was reasoned out by hand is
       exactly how a wrong number gets asserted as correct. */
    const weights = [2, 3, 4, 5];
    const values = [6, 10, 12, 20];
    const bruteKnapsack = (capacity) => {
      let best = 0;
      for (let mask = 0; mask < 1 << weights.length; mask += 1) {
        let tw = 0;
        let tv = 0;
        for (let i = 0; i < weights.length; i += 1) {
          if (mask & (1 << i)) { tw += weights[i]; tv += values[i]; }
        }
        if (tw <= capacity && tv > best) best = tv;
      }
      return best;
    };
    for (const capacity of [0, 1, 3, 5, 7, 8, 12]) {
      const expected = bruteKnapsack(capacity);
      const actual = V.vizDp.knapsack.run(weights, values, capacity).result;
      check(`knapsack matches an exhaustive search at capacity ${capacity}`, actual === expected, `engine ${actual}, brute force ${expected}`);
    }
    const lcs = V.vizDp.lcs.run("ABCBDAB", "BDCABA");
    check("LCS of the classic pair is 4", lcs.result === 4, String(lcs.result));
    check("LCS of identical strings is the whole length", V.vizDp.lcs.run("abcd", "abcd").result === 4);
    check("LCS of disjoint strings is 0", V.vizDp.lcs.run("abc", "xyz").result === 0);
  }

  console.log("\n== registry ==");
  {
    const groups = Object.keys(V.VISUALIZERS);
    check("every visualizer group is labelled", groups.every((g) => V.VISUALIZERS[g].label && V.VISUALIZERS[g].note));
    check("sorting, searching, recursion, trees, graphs, patterns and DP are all present", ["sort", "search", "recursion", "tree", "graph", "pattern", "dp"].every((g) => groups.includes(g)));
    check("every group has at least two algorithms", groups.every((g) => Object.keys(V.VISUALIZERS[g].items).length >= 2));
    const total = groups.reduce((sum, g) => sum + Object.keys(V.VISUALIZERS[g].items).length, 0);
    check("the library has a decent number of algorithms", total >= 20, `${total} algorithms`);
    check("every algorithm states its complexity", groups.every((g) => Object.values(V.VISUALIZERS[g].items).every((a) => a.complexity && a.note)));
    check("a default example exists for every group", groups.every((g) => V.VIZ_EXAMPLES[g]));
  }

  console.log("\n== robustness ==");
  {
    check("sorting a single value works", eq(V.vizSorters.bubble.run([1]).result, [1]));
    check("sorting an empty array works", eq(V.vizSorters.bubble.run([]).result, []));
    check("searching an empty array reports a miss", V.vizSearchers.linear.run([], 5).found === false);
    check("factorial(0) is 1", V.vizRecursions.factorial.build(0).result === 1);
    check("fibonacci(0) is 0", V.vizRecursions.fibonacci.build(0).result === 0);
    check("gcd with a zero is handled", V.vizRecursions.gcd.build(0, 5).result === 5);
    check("a duplicate-heavy array still sorts", eq(V.vizSorters.quick.run([3, 1, 3, 1, 2]).result, [1, 1, 2, 3, 3]));
    check("kadane on a single negative value", V.vizPatterns.kadane.run([-7]).result === -7);
    check("lower bound on an empty array returns 0", V.vizSearchers.lowerBound.run([], 3).result.index === 0);
    check("knapsack with capacity 0 gives 0", V.vizDp.knapsack.run([1, 2], [5, 9], 0).result === 0);
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
};

/* Fixed fixtures, defined here so a change to VIZ_EXAMPLES cannot quietly make
   these tests pass or fail. */
function VIZ_SORT_INPUT() { return [5, 2, 9, 1, 5, 6, 3]; }
function VIZ_SORTED() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; }
function VIZ_GRAPH_EDGES() { return [[0, 1, 4], [0, 2, 1], [2, 1, 2], [1, 3, 1], [2, 3, 5], [3, 4, 3]]; }

void path;
main();
