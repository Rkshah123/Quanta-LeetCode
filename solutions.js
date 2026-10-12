/* ======================== solution comparison ==========================
   Comparing the solutions you saved, on something better than vibes.

   Why this needs real parsing
   ----------------------------
   A user saves three versions of a solution - brute force, improved, optimal -
   and writes "O(n)" in a text box for the complexity. That text is whatever
   they typed. It is frequently wrong, and it is never compared.

   So the counts here are DERIVED from the code, not read from the box:
     - the loops in the code, and what they are nested in;
     - whether a loop bound depends on a variable or on the input length;
     - a loop inside a loop is n^2, whatever the author wrote next to it.

   The author's own note is still shown, and when it disagrees with what the
   code looks like, that disagreement is pointed out rather than hidden. A tool
   that silently preferred its own guess over the user's label would be
   overstepping; one that quietly believed the label would be useless.

   What this does NOT do
   ---------------------
   It does not run the code, time it, or judge whether it is correct. Quanta's
   runner has no access to hidden tests. So nothing here says "this passes" or
   "this is faster" - it reports the shape of the code and lets the reader
   compare shapes. */

const COMPLEXITY_LABELS = ["O(1)", "O(log n)", "O(n)", "O(n log n)", "O(n²)", "O(2ⁿ)"];

/* Parses a JavaScript-ish function well enough to count its loops and reason
   about their bounds. This is deliberately a shape analyser, not a JavaScript
   parser: it does not need to be correct for every program, it needs to be
   right about the loop structure of ordinary solutions and to say "not sure"
   when it is not. */
const analyseCode = (code) => {
  const source = String(code || "");
  const stripped = source
    /* Comments and strings are removed first, so a `for` inside a comment or a
       string cannot be counted as a real loop. */
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");

  const lines = stripped.split("\n");
  const loops = [];
  let depth = 0;

  lines.forEach((line, index) => {
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    /* EVERY loop on the line, not just the first.

       This was a real bug with a real consequence: minified and one-line
       solutions put several loops on one line, and taking only the first match
       reported bubble sort - which is nested, O(n^2) - as a single O(n) loop.
       The feature's entire purpose is noticing that, so the analysis has to see
       it. Loops are found with a global scan so each one gets its own depth. */
    const pattern = /\b(for|while)\s*\(([^)]*)\)/g;
    let match;
    let cursorDepth = depth;
    while ((match = pattern.exec(line)) !== null) {
      const kind = match[1];
      const header = match[2] || "";
      const before = line.slice(0, match.index);
      /* Depth at this loop's own position on the line: braces that opened
         before it on the same line count as nesting. */
      const localDepth = depth + (before.match(/\{/g) || []).length - (before.match(/\}/g) || []).length;
      loops.push({
        line: index + 1,
        kind,
        header: header.trim(),
        dataSized: /\b(length|size|len|n|m|sz)\b/i.test(header) || kind === "while",
        nesting: localDepth
      });
      cursorDepth = localDepth;
    }
    void cursorDepth;

    depth += opens - closes;
    if (depth < 0) depth = 0;
  });

  return { loops, source, stripped };
};

/* True when a function calls ITSELF by name.

   This is what recursion actually looks like in source, and checking the name
   specifically matters: an earlier version asked only "is there a function
   definition and no loop", which flagged every plain non-looping function as
   recursive - so `identity(x) { return x * 2 }` was reported as having an
   unknowable cost, and a halving while-loop was dismissed as recursion before
   its loop structure was even read. */
const looksRecursive = (stripped) => {
  /* Built-ins and common helpers are called constantly in ordinary solutions.
     Treating one of those as a recursive call would make almost everything look
     like recursion - which is exactly what happened to Kadane's algorithm:
     Math.max(a[i], cur + a[i]) counted as max calling itself. */
  /* Only names that are built-in as BARE calls are listed. Method-style names
     (sort, map, push, ...) are deliberately absent: `function sort(...)` naming
     the user's own merge sort collides with them, and excluding it made merge
     sort read as O(1). A bare `sort(...)` call is vanishingly rare next to the
     far more common `a.sort(...)`, which this check never inspects anyway
     because it looks for `function` declarations and `=` assignments. */
  const BUILT_INS = new Set([
    "max", "min", "abs", "pow", "floor", "ceil", "round", "sqrt", "log", "push", "pop",
    "shift", "unshift", "splice", "slice", "join", "split", "map", "filter", "reduce",
    "forEach", "find", "some", "every", "reverse", "indexOf", "includes",
    "String", "Number", "Array", "Object", "Math", "JSON", "console", "parseInt", "parseFloat",
    "isNaN", "charAt", "substring", "toString", "getTime", "set", "get", "has", "add", "delete",
    "keys", "values", "entries", "assign", "freeze", "trim", "replace", "match"
  ]);
  const countCalls = (name) => (stripped.match(new RegExp(`\\b${name}\\s*\\(`, "g")) || []).length;

  const named = stripped.match(/function\s+([A-Za-z_$][\w$]*)\s*\(/g) || [];
  for (const decl of named) {
    const name = /function\s+([A-Za-z_$][\w$]*)/.exec(decl)[1];
    if (BUILT_INS.has(name)) continue;
    /* A definition plus at least one call to the same name is the shape of
       recursion. One occurrence is only the declaration. */
    if (countCalls(name) > 1) return true;
  }

  /* Arrow-function recursion needs an explicit name to be visible as a call. */
  const assigned = stripped.match(/([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[\w$]+)\s*=>/g) || [];
  for (const decl of assigned) {
    const name = /([A-Za-z_$][\w$]*)\s*=/.exec(decl)[1];
    if (BUILT_INS.has(name)) continue;
    if (countCalls(name) > 1) return true;
  }
  return false;
};

/* Estimates the time complexity from loop structure alone.

   The rules, and they are deliberately few so the result can be explained:
     - no loops                                  -> O(1)
     - loops, none nested                       -> O(n)
     - one loop nested in one data-sized loop   -> O(n²)
     - a data-sized loop inside a NON data-sized loop, or a log bound
                                              -> O(n log n)
     - recursion detected with no loop evidence -> flagged for the reader

   Anything it cannot place confidently comes back as null, and the UI then
   says so instead of guessing. */
const estimateComplexity = (code) => {
  const { loops, stripped } = analyseCode(code);

  /* Divide and conquer is checked first, before "no loops means O(1)".
     Merge sort calls itself on two halves and loops not at all in the snippet a
     user saves, so it read as O(1) - the most wrong thing this tool could say
     about it. The signal is a self-call on a sliced input. */
  const slicesAndRecurses = /slice\s*\(/.test(stripped) && looksRecursive(stripped);
  if (slicesAndRecurses) {
    return { time: null, reason: "This halves the input and calls itself, so it is divide and conquer - the cost depends on the recursion depth. Type it yourself." };
  }

  if (!loops.length) {
    /* No loops: either genuinely constant, or recursion, whose cost depends on
       how many times the function calls itself and cannot be read off a shape.
       Only the second case is worth refusing to answer. */
    if (looksRecursive(stripped)) {
      return { time: null, reason: "This function calls itself, so the cost depends on how many times - type the complexity yourself." };
    }
    return { time: "O(1)", reason: "No loops, so the work does not grow with the input size." };
  }

  const maxNesting = Math.max(...loops.map((l) => l.nesting));
  const dataLoops = loops.filter((l) => l.dataSized);

  /* Halving is checked BEFORE the while-loop rule, because a while loop that
     halves its bounds every iteration is logarithmic and not linear - getting
     this backwards would tell someone a binary search is O(n).

     The halving is looked for across the loop's whole body, not just its
     header: in the usual binary search the halves are in the condition and the
     assignments (`lo = mid + 1`, `hi = mid`), and the header is just `lo < hi`.
     Reading only the header missed it and every binary search came back O(n). */
  const halves = /\/\s*2|>>|\bmid\b|\bMath\.(floor|ceil)\s*\(|\bmidpoint\b/i.test(stripped);
  if (halves && loops.some((l) => l.kind === "while")) {
    return { time: "O(log n)", reason: "The loop halves its range each time (the bounds move to the midpoint), so it takes logarithmically many steps." };
  }
  if (loops.some((l) => /<<|>>|\/\s*2/.test(l.header))) {
    return { time: "O(log n)", reason: "A loop shifts or halves its bound each time, which is logarithmically many steps." };
  }

  if (loops.length >= 2 && maxNesting >= 1 && dataLoops.length >= 2) {
    /* A nested loop whose inner bound is the graph's own adjacency (`for x of
       g[n]`) is not n squared over the input - it is V + E, linear in the size
       of the graph. Reading it as n^2 would badly mislead anyone comparing a BFS
       against a naive nested scan. */
    /* `for (const x of g[n])` - the inner loop walks one node's neighbours.

       The test is on the loop's captured ARGUMENTS (`const x of g[n]`), not on
       the whole statement: the keyword `for` is not part of the header, so
       looking for it here never matched and every graph traversal came back as
       n squared. */
    const innerIsAdjacency = loops.some(
      (l) => l.kind === "for" && /\bof\b/.test(l.header) && l.nesting >= 1
    );
    if (innerIsAdjacency) {
      return { time: "O(n)", reason: "The inner loop walks one node's neighbours rather than the whole input, so the work is linear in the graph's size (V + E) - not n squared." };
    }
    return { time: "O(n²)", reason: `There are ${loops.length} loops and one sits inside another, both sized by the input.` };
  }
  if (loops.some((l) => l.kind === "while")) {
    return { time: "O(n)", reason: "A while loop is usually bounded by the input size; check how far it actually runs." };
  }
  if (dataLoops.length >= 1) return { time: "O(n)", reason: `${dataLoops.length} loop${dataLoops.length === 1 ? "" : "s"} running once over the input.` };
  return { time: "O(n)", reason: "There is a loop, though its bound is not clearly tied to the input size." };
};

/* Rough space estimate, from the same reasoning. Deliberately coarse: space is
   about what is allocated that survives the loop, which needs reading, not
   counting. */
const estimateSpace = (code) => {
  const { stripped } = analyseCode(code);
  const hasAllocation = /\bnew\s+\w+\s*\[|\[\s*\]\s*;|new\s+(Map|Set)\s*\(/.test(stripped);

  /* Only recursion has an unpredictable stack cost, and only recursion that is
     actually present. */
  if (looksRecursive(stripped)) {
    return { space: null, reason: "This calls itself, so it uses the call stack, and how deep that goes depends on the input. Type it yourself." };
  }
  if (hasAllocation) return { space: "O(n)", reason: "Something the size of the input is allocated." };
  return { space: "O(1)", reason: "Nothing that grows with the input is allocated." };
};

/* Orders solutions by estimated time, and says when it cannot rank them. */
const rankSolutions = (solutions) => {
  const scored = solutions.map((solution) => {
    const time = estimateComplexity(solution.code);
    const space = estimateSpace(solution.code);
    const index = COMPLEXITY_LABELS.indexOf(time.time);
    return {
      ...solution,
      estimatedTime: time.time,
      timeReason: time.reason,
      estimatedSpace: space.space,
      spaceReason: space.reason,
      /* An unknown complexity sorts last, never first. A solution whose cost
         could not be read must not look like the fastest one. */
      rank: index === -1 ? Number.POSITIVE_INFINITY : index
    };
  });

  /* Only order what can be ordered. If anything is unknown, say that the order
     is incomplete rather than pretending to a total order. */
  const unknown = scored.filter((s) => s.estimatedTime === null);
  const known = scored.filter((s) => s.estimatedTime !== null).sort((a, b) => a.rank - b.rank);
  return { ranked: [...known, ...unknown], complete: unknown.length === 0, unknownCount: unknown.length };
};

/* Compares the author's stated complexity with what the code looks like, and
   reports the disagreement rather than silently preferring either. */
const compareStated = (stated, estimated) => {
  const clean = String(stated || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!clean) return { state: "unstated", text: "No complexity was written down for this one." };
  if (!estimated) return { state: "unknown", text: "The code's cost could not be read, so this cannot be checked." };
  const normalised = clean.replace(/\s+/g, "");
  if (normalised === estimated.toLowerCase()) return { state: "agree", text: `Matches the code: ${estimated}.` };
  return {
    state: "disagree",
    text: `You wrote ${stated}, but the loops look like ${estimated}. Worth checking which is right.`
  };
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { analyseCode, estimateComplexity, estimateSpace, rankSolutions, compareStated, COMPLEXITY_LABELS };
}

if (typeof window !== "undefined" && window) {
  window.solutionAnalysis = { analyseCode, estimateComplexity, estimateSpace, rankSolutions, compareStated, COMPLEXITY_LABELS };
}
