/* ========================= DSA pattern trainer ==========================
   The bridge between "I have heard of sliding window" and "I can write one".

   The gap this fills
   -----------------
   The catalog knows what topic each problem belongs to, but knowing a problem
   is tagged "Two Pointers" does not tell you what to do when you meet one. This
   module gives each pattern three things:

     - a shape: the situation that calls for it, in words;
     - a skeleton: the code that is the same every time, with the parts that
       change marked;
     - a checklist: the mistakes that pattern actually makes, drawn from what
       goes wrong rather than from generic advice.

   Problems are attached by TOPIC TAG, not hand-picked one by one. That means
   the practice list is real catalog data - it updates when the catalog does -
   and it cannot drift into listing a problem that is no longer there or was
   never really an example of the pattern.

   What this deliberately is not: it does not claim a problem is a
   "must-know" for any company, because no permitted source says that. */

const PATTERNS = [
  {
    key: "two-pointers",
    title: "Two pointers",
    topics: ["Two Pointers"],
    when: "The input is sorted, or the answer is a pair. Two indices walk toward each other or in the same direction, and each step rules something out.",
    shape: "Start one index at each end. Compare, then move exactly one of them - which one depends on whether you need a bigger or a smaller result.",
    skeleton: `let lo = 0, hi = n - 1;
while (lo < hi) {
  const sum = a[lo] + a[hi];
  if (sum === target) return [lo, hi];
  if (sum < target) lo++;   // too small: the left value can never help again
  else              hi--;   // too big:  the right value can never help again
}
// no pair exists`,
    checklist: [
      "Sorted input is required. On unsorted input the 'move one pointer' step is not justified and the answer can be missed.",
      "lo < hi, not lo <= hi, unless a single element really can be the answer - otherwise you compare an element with itself.",
      "Returning two indices rather than the value is usually what the interviewer wants."
    ],
    alsoKnownAs: "Opposed pointers"
  },
  {
    key: "sliding-window",
    title: "Sliding window",
    topics: ["Sliding Window"],
    when: "You are looking at every window of a fixed size, or over a stretch that grows and shrinks to satisfy a condition like 'at most k distinct'.",
    shape: "Keep a running state for the current window. Add the element entering on the right, remove the one leaving on the left. Never recompute from scratch.",
    skeleton: `let left = 0;
for (let right = 0; right < n; right++) {
  add(a[right]);            // update running state
  while (windowIsInvalid()) {
    remove(a[left]);        // shrink from the left
    left++;
  }
  record(bestSoFar);        // the window is now the longest valid one ending at right`,
    checklist: [
      "The inner while loop must actually shrink. Forgetting it is the single most common bug, and it looks fine until the window grows without bound.",
      "Longest subarray with at most k is the classic: monotonic window. Longest subarray with at most k distinct is the same shape with a different validity test.",
      "Every element enters once and leaves once, so this is O(n) even though it looks nested."
    ],
    alsoKnownAs: "Fixed and variable windows"
  },
  {
    key: "prefix-sum",
    title: "Prefix sum",
    topics: ["Prefix Sum"],
    when: "You ask the same question about many ranges: 'what is the sum between i and j?'. Answering each from scratch is O(n) per query.",
    shape: "Precompute cumulative totals once, then any range sum is one subtraction.",
    skeleton: `const prefix = [0];
for (let i = 0; i < n; i++) prefix.push(prefix[i] + a[i]);

// sum of a[i..j] inclusive, in O(1)
const rangeSum = (i, j) => prefix[j + 1] - prefix[i];`,
    checklist: [
      "Decide whether prefix[0] is 0 or the first element, then be consistent. Off-by-one here wrecks every query.",
      "Works with subtraction. If you need the sum and the count (the average), the count needs its own array.",
      "The same trick answers 'is this subarray a permutation of the target' by comparing sums AND XORs - sum alone is not enough, because different multisets can share a sum."
    ],
    alsoKnownAs: "Cumulative sum"
  },
  {
    key: "binary-search",
    title: "Binary search",
    topics: ["Binary Search"],
    when: "The answer space is sorted or monotonically changing: a sorted array, or a predicate that flips exactly once from false to true.",
    shape: "Halve the range every step. The whole difficulty is choosing the invariant and getting the boundaries right.",
    skeleton: `let lo = 0, hi = n - 1;
while (lo <= hi) {
  const mid = lo + Math.floor((hi - lo) / 2);
  if (a[mid] === target) return mid;
  if (a[mid] < target) lo = mid + 1;
  else                hi = mid - 1;
}
return -1;`,
    checklist: [
      "Use lo + (hi - lo) / 2, not (lo + hi) / 2. In Java the second overflows for large indices, and it is a habit worth building now.",
      "Prefer the half-open interval lo < hi with hi = n for lower-bound problems; mixing the two conventions is where the bugs live.",
      "Write the loop invariant as a sentence before writing the code. If you cannot finish the sentence, the boundary handling is wrong.",
      "Binary search on the ANSWER, not just the array: if the array is unsorted but the answer is monotonic, search over candidate answers."
    ],
    alsoKnownAs: "Half-open search"
  },
  {
    key: "merge-intervals",
    title: "Merge intervals",
    topics: ["Arrays", "Sorting"],
    when: "Overlapping ranges have to become a minimal set of non-overlapping ranges.",
    shape: "Sort by start, then keep a running result and extend the last interval whenever the next one overlaps it.",
    skeleton: `ranges.sort((x, y) => x[0] - y[0]);
const out = [];
for (const [start, end] of ranges) {
  const last = out[out.length - 1];
  if (last && start <= last[1]) last[1] = Math.max(last[1], end);
  else out.push([start, end]);
}`,
    checklist: [
      "Sorting is the first step and the one most often forgotten.",
      "start <= last[1] merges touching intervals. Whether that is correct depends on the problem - it is a real ambiguity, so decide and say so out loud.",
      "The result array must hold copies or be mutated in place; pushing references to the input can corrupt it."
    ],
    alsoKnownAs: "Interval consolidation"
  },
  {
    key: "two-sum-variants",
    title: "Hashing",
    topics: ["Hashing"],
    when: "You need to find a partner for each value, and you do not care about order.",
    shape: "Walk once. For each value, ask whether its complement has already been seen.",
    skeleton: `const seen = new Map();      // value -> index
for (let i = 0; i < nums.length; i++) {
  const need = target - nums[i];
  if (seen.has(need)) return [seen.get(need), i];
  seen.set(nums[i], i);     // set AFTER the check, so a value cannot pair with itself
}`,
    checklist: [
      "Check before you insert. The reverse order lets one element pair with itself.",
      "A Map keeps insertion order and works with any key type; an object coerces keys to strings, which breaks for numbers like 1 and '1'.",
      "If you only need the values, a Set is enough and slightly cheaper.",
      "Hash lookups are O(1) on average but O(n) worst case on a pathological hash; this is why the worst case is still O(n^2) in theory."
    ],
    alsoKnownAs: "Complement lookup"
  },
  {
    key: "linked-list",
    title: "Linked list",
    topics: ["Linked List"],
    when: "You need pointer manipulation: reversing, detecting a cycle, finding a middle, merging, or removing the nth from the end.",
    shape: "Three pointers cover most of it - previous, current, and one that runs ahead.",
    skeleton: `// reverse
let prev = null, curr = head;
while (curr) {
  const next = curr.next;
  curr.next = prev;
  prev = curr;
  curr = next;
}
// head is now prev`,
    checklist: [
      "Save next BEFORE overwriting curr.next, or the rest of the list is lost.",
      "For 'nth from the end' use two pointers a gap apart, advance the head pointer n times, then walk both. One pass, O(1) space.",
      "For a cycle use slow and fast pointers. If they meet, there is a cycle.",
      "Always ask whether the list is singly or doubly linked - the answer changes the design."
    ],
    alsoKnownAs: "Pointer chasing"
  },
  {
    key: "stack",
    title: "Stack",
    topics: ["Stack"],
    when: "The most recent thing matters most: nested structures, backtracking, and anything that must undo in reverse order.",
    shape: "Push on the way in, pop on the way out. The stack remembers the path.",
    skeleton: `const stack = [];
for (const ch of s) {
  if (isOpen(ch)) stack.push(ch);
  else if (stack.pop() !== matchOf(ch)) return false;   // mismatch
}
return stack.length === 0;`,
    checklist: [
      "At the end, an empty stack means balanced. Non-empty means an unclosed opener - forgetting this check accepts '([)]'.",
      "Valid parentheses is the template for balanced brackets, HTML tag matching and expression parsing.",
      "A stack also implements an iterative DFS and is the natural structure for 'undo'."
    ],
    alsoKnownAs: "LIFO"
  },
  {
    key: "queue",
    title: "Queue / BFS",
    topics: ["Queue"],
    when: "You need the order of arrival rather than the order of nesting: shortest paths, level order, or anything 'nearest first'.",
    shape: "A FIFO queue holds the frontier. Process one level fully before the next.",
    skeleton: `const queue = [start];
const seen = new Set([start]);
while (queue.length) {
  const node = queue.shift();        // O(n) on an array - use an index instead
  for (const next of neighbours(node)) {
    if (seen.has(next)) continue;    // mark on ENQUEUE, not on dequeue
    seen.add(next);
    queue.push(next);
  }
}`,
    checklist: [
      "Mark visited when you ENQUEUE. Marking on dequeue lets a node sit in the queue twice and the work explodes.",
      "For 'shortest path in an unweighted graph', BFS is correct and DFS is not.",
      "Use a head index instead of shift() to avoid the O(n) cost of removing from the front of an array."
    ],
    alsoKnownAs: "FIFO, level order"
  },
  {
    key: "tree-traversal",
    title: "Tree traversal",
    topics: ["Trees", "BST"],
    when: "Visiting every node, or every node in a specific order, in a tree or a graph.",
    shape: "Depth-first goes down then back up. Breadth-first goes across a level. The order is a choice, not a detail.",
    skeleton: `// in-order on a BST visits values in sorted order
function inorder(node, out = []) {
  if (!node) return out;
  inorder(node.left, out);
  out.push(node.value);
  inorder(node.right, out);
  return out;
}

// iterative in-order, which is what you need for a deep tree
function inorderIter(root) {
  const out = [], stack = [];
  let cur = root;
  while (cur || stack.length) {
    while (cur) { stack.push(cur); cur = cur.left; }
    cur = stack.pop();
    out.push(cur.value);
    cur = cur.right;
  }
  return out;
}`,
    checklist: [
      "Recursion can overflow the call stack on a deep tree (a sorted 10,000-node tree is a linked list). The iterative version does not.",
      "For a BST, in-order is sorted. That is the property to remember and it answers many problems for free.",
      "Pre-, in- and post-order are the same walk with the visit in three different places."
    ],
    alsoKnownAs: "DFS and BFS on trees"
  },
  {
    key: "heap",
    title: "Heap / priority queue",
    topics: ["Heaps"],
    when: "You repeatedly need the smallest or largest remaining thing, and you do not care about the rest of the order.",
    shape: "Push everything in, then pop repeatedly. Each operation is O(log n).",
    skeleton: `// k smallest: push all, then pop k times - O(n log k)
const heap = new MinHeap();
for (const v of nums) heap.push(v);
const out = [];
for (let i = 0; i < k; i++) out.push(heap.pop());`,
    checklist: [
      "A heap gives O(1) access to the top only. It cannot be sorted or indexed usefully.",
      "K-way merge of sorted lists: push the first of each, pop the smallest and push its successor. O(N log k).",
      "Dijkstra's algorithm is a priority queue on the frontier distance. That is the same structure doing the same job."
    ],
    alsoKnownAs: "Priority queue"
  },
  {
    key: "graph",
    title: "Graph traversal",
    topics: ["Graphs"],
    when: "Nodes and the paths between them: reachability, cycles, components, shortest path.",
    shape: "Keep a visited set. Choose BFS for shortest-in-hops, DFS for components and cycle detection.",
    skeleton: `function dfs(node, seen, visit) {
  seen.add(node);
  visit(node);
  for (const next of neighbours(node)) {
    if (!seen.has(next)) dfs(next, seen, visit);
  }
}
// call it once per unvisited node to cover every component`,
    checklist: [
      "Visited is essential. Without it a cycle recurses forever.",
      "For an undirected graph, a node is in a cycle if a neighbour is already visited AND is not the parent you came from.",
      "BFS gives shortest hops; DFS gives components. Using the wrong one is the usual mistake.",
      "Recursion depth equals the node count - use an explicit stack on large graphs."
    ],
    alsoKnownAs: "BFS and DFS"
  },
  {
    key: "backtracking",
    title: "Backtracking",
    topics: ["Backtracking"],
    when: "You build a solution one choice at a time, and have to undo choices that lead nowhere: all permutations, subsets, N-Queens, Sudoku.",
    shape: "Choose, explore, un-choose. The undo step is the algorithm.",
    skeleton: `function backtrack(path, used) {
  if (isComplete(path)) { results.push([...path]); return; }

  for (const choice of options) {
    if (!isValid(choice, path, used)) continue;

    path.push(choice);        // choose
    used.add(choice);
    backtrack(path, used);    // explore
    used.delete(choice);      // un-choose - forgetting this is infinite recursion
    path.pop();
  }
}`,
    checklist: [
      "Always copy the path when you record it (results.push([...path])). Pushing the same array reference records every answer as the final one.",
      "The undo must restore EVERY piece of state the choice changed - the array, the set, the board. Miss one and you get wrong answers rather than an error.",
      "Prune early where you can: if the remaining positions cannot satisfy the constraints, return before recursing.",
      "The problem is exponential and that is expected. Often you are only asked for the count, not the list, which DP can do far faster."
    ],
    alsoKnownAs: "DFS with state"
  },
  {
    key: "greedy",
    title: "Greedy",
    topics: ["Greedy"],
    when: "A local choice that is safe turns into a global optimum. Activity selection, scheduling, Huffman.",
    shape: "Sort by the thing that matters, then take each item if it still fits.",
    skeleton: `jobs.sort((a, b) => a.end - b.end);   // finish earliest
let count = 0, lastEnd = -Infinity;
for (const job of jobs) {
  if (job.start >= lastEnd) { count++; lastEnd = job.end; }
}`,
    checklist: [
      "Greedy is only correct when you can PROVE the local choice cannot be undone later. Coin change with {1,3,4} and 6 is the classic counter-example: greedy gives 4+1+1, the answer is 3+3.",
      "When a greedy choice is not obviously safe, DP is the honest answer. Do not force it.",
      "Most greedy problems are 'sort by one key, then scan'. The sorting key is the whole idea."
    ],
    alsoKnownAs: "Locally optimal"
  },
  {
    key: "dp",
    title: "Dynamic programming",
    topics: ["Dynamic Programming"],
    when: "The problem has overlapping subproblems and an optimal substructure: many ways to reach the same state, and you need the best.",
    shape: "Name the state, write the recurrence, define the base cases, then fill the table in an order where the state you need is already computed.",
    skeleton: `// dp[i] = the answer for the first i items
const dp = new Array(n + 1).fill(0);
for (let i = 1; i <= n; i++) {
  dp[i] = Math.max(dp[i - 1] + value(i), dp[i - 2] + pairedValue(i));
}
// dp[n] is the answer`,
    checklist: [
      "Write the state as a sentence before any code: 'dp[i][j] is the answer for the first i items with capacity j'. If you cannot, the recurrence is not clear yet.",
      "Two questions decide the complexity: how many states, and how many transitions per state. That product is your running time.",
      "1D only when the previous row is all you need - otherwise you are throwing away information you will want.",
      "If the answer is a COUNT rather than a list, you often do not need to store the choices at all.",
      "Top-down with memoisation and bottom-up are the same recurrence; top-down is easier to write, bottom-up is usually faster."
    ],
    alsoKnownAs: "DP"
  },
  {
    key: "bit",
    title: "Bit manipulation",
    topics: ["Bit Manipulation"],
    when: "The problem is phrased in binary, or a parity/counting trick replaces arithmetic.",
    shape: "Work on the bits directly: XOR to cancel pairs, AND to keep a subset, shift to move.",
    skeleton: `// count the set bits, one removal per iteration
function popcount(x) {
  let count = 0;
  while (x) {
    x &= x - 1;      // clear the lowest set bit
    count++;
  }
  return count;
}

// the value that appears once when every other value appears twice
function single(numbers) {
  let result = 0;
  for (const n of numbers) result ^= n;   // pairs cancel: x ^ x === 0
  return result;
}

// is this a positive power of two?
const isPowerOfTwo = (x) => x > 0 && (x & (x - 1)) === 0;

// odd or even, without %
const isOdd = (x) => (x & 1) === 1;`,
    checklist: [
      "x ^ x === 0 and x ^ 0 === x - these two facts power most of the clever tricks.",
      "Counting set bits: Brian Kernighan's algorithm, n &= n - 1, runs in the number of set bits.",
      "Beware signed shifts in Java: >> is arithmetic, >>> is logical.",
      "For 'is a power of two': x > 0 && (x & (x - 1)) === 0."
    ],
    alsoKnownAs: "Bits"
  },
  {
    key: "trie",
    title: "Trie / prefix tree",
    topics: ["Tries"],
    when: "Many strings share prefixes, or you need autocomplete, word search in a grid, or a fast prefix query.",
    shape: "Each node is a prefix. Walk the string once, creating nodes as needed.",
    skeleton: `class Trie {
  insert(word) {
    let node = this.root;
    for (const ch of word) {
      node = node.children[ch] ||= new TrieNode();
    }
    node.isWord = true;      // without this, prefixes are indistinguishable
  }
}`,
    checklist: [
      "Set a terminal flag. Without it, 'car' is found inside 'cart'.",
      "Each node needs a map for children - an array of 26 works too and is faster.",
      "The time is O(total characters), independent of how many words share the prefix."
    ],
    alsoKnownAs: "Prefix tree"
  },
  {
    key: "math-number",
    title: "Maths and number theory",
    topics: ["Math", "Number Theory"],
    when: "The answer is a property of the numbers rather than their order: divisibility, primes, digit manipulation.",
    shape: "Usually a closed-form observation, sometimes a gcd.",
    skeleton: `const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

// divisible by 3 and 5 in one pass
for (let i = 1; i <= n; i++) if (i % 15 === 0) count++;`,
    checklist: [
      "Digit sum mod 9 equals the number mod 9 - the trick behind most 'digit' divisibility questions.",
      "Sieve of Eratosthenes for primes up to n: O(n log log n), and it is almost always what a prime question wants.",
      "Fast exponentiation for anything raised to a large power: O(log n) instead of O(n).",
      "Watch for overflow when a formula multiplies large values."
    ],
    alsoKnownAs: "Number theory"
  },
  {
    key: "star-patterns",
    title: "Printing patterns",
    topics: ["Strings", "Arrays"],
    when: "An interview asks for a printed shape. They are testing loop control and whether you can reason about rows and columns, not creativity.",
    shape: "Work out, for each row, what goes in each column. Then nest the loops in that order.",
    skeleton: `// diamond outline
for (let row = 0; row < 2 * n - 1; row++) {
  const dist = Math.abs(n - 1 - row);
  let line = "";
  for (let col = 0; col < 2 * n - 1; col++) {
    const onEdge = col === dist || col === 2 * n - 2 - dist;
    line += onEdge && Math.abs(col - (n - 1)) <= dist ? "*" : " ";
  }
  console.log(line);
}`,
    checklist: [
      "Derive one formula per column position first. Printing while you are still thinking usually produces asymmetric output.",
      "Leading spaces matter as much as the stars - that is usually what is being tested.",
      "Say the shape out loud as rows and columns. Most pattern questions become trivial once you do.",
      "Trailing spaces are usually not checked, but avoid printing them anyway."
    ],
    alsoKnownAs: "Pattern printing"
  }
];

/* Builds the practice list for a pattern from whatever catalog it is given.
   Problems come from topic tags, so the list is always real catalog data. */
const patternProblems = (patterns, key, problems, perPattern = 8) => {
  const pattern = patterns.find((p) => p.key === key);
  if (!pattern) return [];
  const wanted = new Set(pattern.topics.map((t) => t.toLowerCase()));
  const matched = problems.filter((problem) => {
    const topics = Array.isArray(problem.topics) ? problem.topics : [];
    return topics.some((topic) => wanted.has(String(topic).toLowerCase()));
  });
  /* Easiest first: a pattern page is for learning the shape, and a hard
     problem in an unfamiliar pattern teaches the pattern badly. */
  const order = { Easy: 0, Medium: 1, Hard: 2 };
  return matched
    .slice()
    .sort((a, b) => (order[a.difficulty] ?? 3) - (order[b.difficulty] ?? 3) || String(a.title || a.name).localeCompare(String(b.title || b.name)))
    .slice(0, perPattern);
};

/* The catalog topics that no pattern claims. Reported rather than hidden, so a
   topic with problems but no teaching page is visible rather than looking like
   a bug. */
const patternGaps = (patterns, problems) => {
  const claimed = new Set(patterns.flatMap((p) => p.topics.map((t) => t.toLowerCase())));
  const counts = new Map();
  for (const problem of problems) {
    for (const topic of Array.isArray(problem.topics) ? problem.topics : []) {
      if (typeof topic !== "string" || !topic) continue;
      const key = topic.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([topic]) => !claimed.has(topic))
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count);
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PATTERNS, patternProblems, patternGaps };
}

if (typeof window !== "undefined" && window) {
  window.PATTERNS = PATTERNS;
  window.patternProblems = patternProblems;
  window.patternGaps = patternGaps;
  window.patternEngine = { PATTERNS, patternProblems, patternGaps };
}
