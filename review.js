/* Wrapped in an IIFE on purpose.

   These files load as plain <script> tags, so an unwrapped top-level `const`
   joins the single global scope every other script on the page shares. Two
   files declaring the same name is a SyntaxError for the second one - the whole
   file, not just the offending line - and it fails silently from the outside:
   the page still loads, the module simply never ran.

   That happened here: debugger.js and review.js both declared `getAcorn`, and
   review.js's `estimateComplexity` also collided with solutions.js.

   Only what is attached to `window` below is visible from outside. Under Node
   the same block exports through `module.exports`, which is how the test
   suites load them. */
(function () {
"use strict";

/* ============================== code review ===============================
   Static review of a solution: what it costs, what might be wrong, and how it
   lines up with the problem it claims to solve.

   What this is, precisely
   ----------------------
   A static analyser. It parses the code with acorn, walks the tree, and reports
   what it can actually establish from that tree: how many loops are nested, what
   the recursive calls are, which comparison operators were used, whether a
   function can fall off the end without returning.

   What this is not
   ----------------
   It is not a language model and it does not pretend to be one. It cannot tell
   you why your algorithm is correct, it does not read the problem statement,
   and it will not claim a bug is a bug. What it does is check a list of specific,
   named conditions - each one a property of the syntax tree that is either true
   or false - and report the ones that hold.

   That distinction is the whole design. A tool that says "this looks correct"
   based on having read a pattern is worse than no tool, because it transfers a
   belief you have not earned. Every finding here carries the evidence that
   produced it, so you can check it yourself and disagree with it.

   Why the findings are what they are
   ----------------------------------
   Each rule below exists because it is a mistake that appears again and again in
   interview code, or because it is the kind of thing that is invisible when you
   are staring at the screen. Nothing is reported for style preference; a review
   that nits about formatting is a review you learn to skip.

   The complexity estimate is a heuristic and is labelled as one
   -----------------------------------------------------------
   Counting nested loops gives a real bound for the loop-shaped code most
   interview solutions are written in. It does NOT give a real bound for code
   that hides work behind a call - an Array.sort inside a loop is O(n) to the
   counter and O(n log n) in reality. So every estimate lists the constructs it
   was derived from, and anything it could not see is named as a caveat rather
   than folded silently into a number.

   Nothing is sent anywhere. This runs in the page, on the reader's machine. */

const MAX_DEPTH = 6;

/* What a nested loop nest costs. The index is the nesting depth of user-written
   loops; `1` means a single loop over n items. */
const LOOP_COST = ["n", "n^2", "n^3", "n^4", "n^5", "n^6"];

/* The largest input a loop nest of each depth can handle in roughly 10^8
   operations - about where a JavaScript loop stops being fast enough for a
   grader. A rough ceiling, used to compare against the constraint text and
   always reported as a rough one. */
const SAFE_INPUT_SIZE = [1e7, 1e4, 5e2, 1e2, 50, 20];

const REVIEW_RULES = [
  {
    key: "loose-equality",
    title: "== or != instead of === or !==",
    severity: "warning",
    why: "Loose equality coerces types, so 0 == \"\" and null == undefined are both true. In interview code it is almost never what you meant, and the cases where it is are the ones that are hard to see.",
    whyItMatters: "A grader can reject the solution on a case that only differs by type."
  },
  {
    key: "eqeqeq-null",
    title: "== null",
    severity: "warning",
    why: "This one is defensible: == null is true for both null and undefined, which is often exactly what you want. Quanta flags it anyway so the choice is a decision rather than a habit.",
    whyItMatters: "If you meant only null, === null is what you want."
  },
  {
    key: "empty-block",
    title: "An empty loop or if body",
    severity: "warning",
    why: "Usually a leftover from a cut-down attempt, and occasionally a loop that was supposed to do something.",
    whyItMatters: "An empty loop still costs its full time."
  },
  {
    key: "unreachable",
    title: "Code after a return",
    severity: "warning",
    why: "It never runs. Often the sign of a merge or of half-finished editing.",
    whyItMatters: "Whatever that code was meant to do, is not happening."
  },
  {
    key: "no-return",
    title: "A function that can finish without returning",
    severity: "serious",
    why: "One path through the function falls off the end, so the caller gets undefined without being told. The code still parses and still runs.",
    whyItMatters: "undefined turns up somewhere else entirely and is hard to trace back."
  },
  {
    key: "mutate-while-iterating",
    title: "Modifying an array while iterating it",
    severity: "serious",
    why: "Changing the length of an array mid-loop changes where the loop stops and which items it visits. Removing an item makes it skip the next one.",
    whyItMatters: "The loop visits a different set of elements than the one you reasoned about."
  },
  {
    key: "off-by-one",
    title: "A loop that cannot reach its own bound",
    severity: "warning",
    why: "The loop condition and the update step disagree - < with ++, or <= with a step of 2, for instance - so it does not do what the bounds read like it does.",
    whyItMatters: "Usually an off-by-one at the end of the range."
  },
  {
    key: "shadowed-name",
    title: "A variable shadowing another",
    severity: "notice",
    why: "Two different things share one name in nested scopes. It is legal and it is very easy to read the wrong one.",
    whyItMatters: "The value you think you are using may be the outer one."
  },
  {
    key: "var-usage",
    title: "var instead of let or const",
    severity: "notice",
    why: "var is function-scoped, so it is visible after the block it was declared in, and it can be redeclared by accident.",
    whyItMatters: "Mostly a readability and accident risk."
  },
  {
    key: "nested-function-in-loop",
    title: "A function declared inside a loop",
    severity: "notice",
    why: "Legal, and the function is rebuilt on every pass. If it captures the loop variable, it captures the binding, not the value.",
    whyItMatters: "Usually a sign the function should be lifted out and passed what it needs."
  },
  {
    key: "magic-index",
    title: "A hard-coded index into a lookup",
    severity: "notice",
    why: "x[0] and x[1] assume a shape without checking it. An empty input returns undefined rather than a value.",
    whyItMatters: "Fails on the smallest input, which is the one people forget to try."
  }
];

/* Built-ins whose cost a loop counter cannot see. Naming them is the difference
   between an estimate and a guess. */
const HIDDEN_COSTS = {
  sort: { cost: "n log n", note: "Array.prototype.sort" },
  reverse: { cost: "n", note: "Array.prototype.reverse" },
  includes: { cost: "n", note: "Array.prototype.includes" },
  indexOf: { cost: "n", note: "Array.prototype.indexOf" },
  find: { cost: "n", note: "Array.prototype.find" },
  findIndex: { cost: "n", note: "Array.prototype.findIndex" },
  filter: { cost: "n", note: "Array.prototype.filter" },
  map: { cost: "n", note: "Array.prototype.map" },
  forEach: { cost: "n", note: "Array.prototype.forEach" },
  some: { cost: "n", note: "Array.prototype.some" },
  every: { cost: "n", note: "Array.prototype.every" },
  flat: { cost: "n", note: "Array.prototype.flat" },
  push: { cost: "n occasionally", note: "Array.prototype.push" }
};

const getAcorn = () => {
  if (typeof window !== "undefined" && window && window.acorn) return window.acorn;
  return require("acorn");
};

/* ------------------------------ the walker ------------------------------ */

/* One pass over the tree, collecting everything the review needs. Collecting in
   a single walk keeps the analysis honest about the code it actually saw: there
   is one source of truth, not several passes that could disagree. */
const collect = (ast) => {
  const facts = {
    loopDepth: 0,
    maxLoopDepth: 0,
    loops: [],
    functions: [],
    calls: [],
    looseEqualities: [],
    emptyBlocks: [],
    afterReturn: [],
    varDeclarations: [],
    letNeverReassigned: [],
    mutations: [],
    mutationsInLoop: [],
    shadowed: new Set(),
    functionsInLoop: [],
    magicIndexes: [],
    stringConcatenation: [],
    recursion: [],
    /* A loop over the length of the same array it also indexes, the shape that
       produces off-by-ones. */
    lengthOf: []
  };

  const scopes = [new Set()];
  /* The function the walk is currently inside, for the recursion check. */
  let currentFunction = null;

  const declared = (name) => {
    scopes[scopes.length - 1].add(name);
    if (scopes.length > 1 && scopes.some((s, i) => i < scopes.length - 1 && s.has(name))) {
      facts.shadowed.add(name);
    }
  };

  const walk = (node, parent, key) => {
    if (!node || typeof node.type !== "string") return;

    switch (node.type) {
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        facts.loopDepth += 1;
        facts.maxLoopDepth = Math.max(facts.maxLoopDepth, facts.loopDepth);
        facts.loops.push({
          type: node.type,
          line: node.loc?.start?.line ?? null,
          depth: facts.loopDepth,
          subject: loopSubject(node),
          /* Recorded so the off-by-one rule has something concrete to check
             rather than guessing from the operator alone. */
          test: node.test,
          update: node.update || null,
          /* What this loop walks. A mutation of some OTHER array is normal -
             accumulating into a result list while iterating the input is the
             single most common shape there is, and flagging it as "modifying
             an array while iterating" was a serious false positive on correct
             code. */
          subject: loopSubject(node)
        });
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const body = node.body;
        /* A method or a constructor is not expected to return. Telling someone
           that an empty class constructor "can finish without returning" is
           noise on correct code, and noise is what teaches people to ignore a
           reviewer. */
        const isMethod = parent?.type === "Property" || parent?.type === "MethodDefinition";
        const isConstructor = parent?.type === "MethodDefinition" && parent.kind === "constructor";
        const returns = body.type === "BlockStatement" ? collectReturns(body).length : 1;
        facts.functions.push({
          name: node.id?.name || (parent && parent.type === "VariableDeclarator" ? parent.id?.name : null),
          line: node.loc?.start?.line ?? null,
          params: (node.params || []).map(paramName).filter(Boolean),
          hasReturnWithValue: body.type === "BlockStatement" ? collectReturns(body).some((r) => !!r.argument) : false,
          returnCount: returns,
          /* A function whose body is a block falls off the end unless every path
             returns. A concise arrow cannot - its body is the expression. */
          fallsOffEnd: body.type === "BlockStatement" && !returnsEverywhere(body),
          endsWithReturn: body.type === "BlockStatement" ? endsWithReturn(body) : true,
          isArrow: node.type === "ArrowFunctionExpression",
          concise: node.type === "ArrowFunctionExpression" && body.type !== "BlockStatement",
          isMethod,
          isConstructor
        });
        if (node.id && node.type === "FunctionDeclaration") declared(node.id.name);
        /* A function expression bound to a name, or given one, recurses under
           that name. */
        if (!node.id && parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
          declared(parent.id.name);
        }
        for (const param of node.params || []) {
          const name = paramName(param);
          if (name) declared(name);
        }
        break;
      }
      case "BinaryExpression":
        if (["==", "!=", "===", "!=="].includes(node.operator)) {
          if (node.operator === "==" || node.operator === "!=") {
            const rightIsNull = node.right?.type === "Literal" && node.right.value === null;
            const leftIsNull = node.left?.type === "Literal" && node.left.value === null;
            facts.looseEqualities.push({
              line: node.loc?.start?.line ?? null,
              againstNull: rightIsNull || leftIsNull,
              code: textOf(node)
            });
          }
        }
        break;
      case "BlockStatement":
        if (!node.body.length) facts.emptyBlocks.push({ line: node.loc?.start?.line ?? null, kind: "block" });
        break;
      case "VariableDeclaration":
        for (const declarator of node.declarations) {
          const name = declarator.id?.name;
          if (name) declared(name);
          if (node.kind === "var") facts.varDeclarations.push({ name, line: declarator.loc?.start?.line ?? null });
          if (node.kind === "const" && declarator.init) {
            facts.letNeverReassigned.push({ name, line: declarator.loc?.start?.line ?? null });
          }
        }
        break;
      case "MemberExpression":
        if (node.computed && node.property?.type === "Literal" && typeof node.property.value === "number") {
          facts.magicIndexes.push({ line: node.loc?.start?.line ?? null, index: node.property.value, code: textOf(node) });
        }
        break;
      case "BinaryExpression++":
        break;
      default:
        break;
    }

    /* --mutating the array you are looping over-- */
    if (node.type === "AssignmentExpression") {
      /* For `xs[i] = 0` the mutation is in the TARGET. Checking the right-hand
         side - the way this first did - only ever caught `xs[0] = ys[0]`. */
      const target = memberTarget(node.left);
      if (target) {
        const entry = { line: node.loc?.start?.line ?? null, target, code: textOf(node) };
        facts.mutations.push(entry);
        if (facts.loopDepth > 0) facts.mutationsInLoop.push(entry);
      }
    }
    if (node.type === "UpdateExpression") {
      const target = memberTarget(node.argument);
      if (target && isMutation(node)) {
        const entry = { line: node.loc?.start?.line ?? null, target, code: textOf(node) };
        facts.mutations.push(entry);
        if (facts.loopDepth > 0) facts.mutationsInLoop.push(entry);
      }
    }
    if (node.type === "CallExpression" && isMutation(node)) {
      /* xs.splice(i, 1) inside a loop is the classic way to skip the next
         element. An assignment form alone would have missed it entirely. */
      const target = memberTarget(node.callee);
      if (target) {
        const entry = { line: node.loc?.start?.line ?? null, target, code: textOf(node) };
        facts.mutations.push(entry);
        if (facts.loopDepth > 0) facts.mutationsInLoop.push(entry);
      }
    }

    /* Function declared inside a loop. */
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && facts.loopDepth > 0) {
      facts.functionsInLoop.push({ line: node.loc?.start?.line ?? null, name: node.id?.name || "anonymous" });
    }

    /* Calls. A call is only RECURSION when the callee is the function the call
       sits inside - calling a function you declared is ordinary code, and
       counting it as recursion made every single-call snippet report an
       exponential bound. */
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const calleeName = callee?.type === "Identifier"
        ? callee.name
        : callee?.type === "MemberExpression" && !callee.computed && callee.property?.type === "Identifier"
          ? `${callee.object?.name || "?"}.${callee.property.name}`
          : null;
      if (calleeName) {
        facts.calls.push({ name: calleeName, line: node.loc?.start?.line ?? null });
        if (currentFunction && calleeName === currentFunction) {
          facts.recursion.push({ name: calleeName, line: node.loc?.start?.line ?? null });
        }
      }
    }

    if (node.type === "ReturnStatement" && key === "consequent" && parent?.type) {
      /* handled by the path checker below */
    }

    /* Track whether a statement follows a return in the same block. */
    if (Array.isArray(node.body) && node.type === "BlockStatement") {
      for (let i = 0; i < node.body.length; i += 1) {
        if (node.body[i].type === "ReturnStatement" && i < node.body.length - 1) {
          facts.afterReturn.push({ line: node.body[i + 1].loc?.start?.line ?? null });
        }
        if (node.body[i].type === "IfStatement" && node.body[i].alternate) {
          facts.afterReturn.push({ line: node.body[i].loc?.start?.line ?? null, note: "branches do not all return" });
        }
      }
    }

    /* --descend-- */
    const isFunction = node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
    const outerFunction = currentFunction;
    if (isFunction) {
      scopes.push(new Set());
      currentFunction = node.id?.name || null;
    }

    for (const childKey of Object.keys(node)) {
      if (["loc", "start", "end", "type"].includes(childKey)) continue;
      const value = node[childKey];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object" && child.type) walk(child, node, childKey);
      } else if (value && typeof value === "object" && typeof value.type === "string") {
        walk(value, node, childKey);
      }
    }

    if (isFunction) {
      scopes.pop();
      currentFunction = outerFunction;
    }

    if (["ForStatement", "ForOfStatement", "ForInStatement", "WhileStatement", "DoWhileStatement"].includes(node.type)) {
      facts.loopDepth -= 1;
    }
  };

  for (const node of ast.body) walk(node, null, null);

  return facts;
};

/* The collection a loop walks over, as a name where one is obvious: the
   right-hand side of a for...of, or whatever `.length` is being read in the
   test. Null when the loop is over something this cannot name, in which case no
   mutation is attributed to it. */
const loopSubject = (node) => {
  if (node.type === "ForOfStatement") {
    const right = node.right;
    if (right?.type === "Identifier") return right.name;
    if (right?.type === "CallExpression" && right.callee?.type === "Identifier") return null;
    return null;
  }
  if (node.type === "ForInStatement") {
    return node.right?.type === "Identifier" ? node.right.name : null;
  }
  if (node.test?.type === "BinaryExpression") {
    const { left, right } = node.test;
    /* `i < xs.length` - the collection is the OBJECT of the .length read, not
       the other side of the comparison, which is the counter. Reading it the
       other way round named every loop after its own index and then matched no
       mutation against it. */
    const lengthOf = (side) =>
      side?.type === "MemberExpression" && !side.computed &&
      side.property?.type === "Identifier" && side.property.name === "length" &&
      side.object?.type === "Identifier"
        ? side.object.name
        : null;
    return lengthOf(right) || lengthOf(left) || null;
  }
  return null;
};

const ordinalSuffix = (n) => {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] || "th";
};

const paramName = (param) => {
  if (!param) return null;
  if (param.type === "Identifier") return param.name;
  if (param.type === "AssignmentPattern") return paramName(param.left);
  return null;
};

/* `xs[i] = ...`, `xs.push(...)`, `xs.pop()` - the shapes that change an array. */
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"]);

const memberTarget = (node) => {
  if (!node || node.type !== "MemberExpression") return null;
  return node.object?.type === "Identifier" ? node.object.name : null;
};

const isMutation = (node) => {
  if (!node) return false;
  if (node.type === "CallExpression" && node.callee?.type === "MemberExpression" && !node.callee.computed) {
    return MUTATORS.has(node.callee.property?.name);
  }
  return node.type === "MemberExpression";
};

const textOf = (node) => {
  const source = node?.start != null && node?.end != null ? globalThis.__reviewSource : null;
  if (source && typeof source.slice === "function") return source.slice(node.start, node.end);
  return node?.type || "";
};

const collectReturns = (block) => {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node.type !== "string") return;
    /* A nested function's returns are its own, not this function's. */
    if (node !== block && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) return;
    if (node.type === "ReturnStatement") found.push(node);
    for (const key of Object.keys(node)) {
      if (["loc", "start", "end", "type"].includes(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) if (child && child.type) walk(child);
      else if (value && value.type) walk(value);
    }
  };
  for (const child of block.body) walk(child);
  return found;
};

/* Whether every path through a block returns. An `if` with no else can be
   skipped; a `while (true)` with no break cannot be left. A try returns if either
   branch does. */
const returnsEverywhere = (block) => {
  const alwaysReturns = (node) => {
    if (!node) return false;
    switch (node.type) {
      case "ReturnStatement": return true;
      case "ThrowStatement": return true;
      case "BlockStatement": return node.body.length > 0 && node.body.every(alwaysReturns);
      case "IfStatement":
        return Boolean(node.alternate) && alwaysReturns(node.consequent) && alwaysReturns(node.alternate);
      case "WhileStatement": {
        /* `while (true)` with no break in the body cannot be exited. */
        const test = node.test;
        if (test?.type === "Literal" && test.value === true && !containsBreak(node.body)) return true;
        return false;
      }
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement":
        return Boolean(node.test === null && !containsBreak(node.body));
      case "DoWhileStatement": return false;
      case "TryStatement": {
        if (node.finalizer && alwaysReturns(node.finalizer)) return true;
        if (!node.handler) return false;
        return alwaysReturns(node.block) || alwaysReturns(node.handler.body);
      }
      case "SwitchStatement": {
        if (!node.cases?.length) return false;
        const hasDefault = node.cases.some((c) => c.test === null);
        if (!hasDefault) return false;
        return node.cases.every((c) => c.consequent.length === 0 || c.consequent.every(alwaysReturns) || containsBreak(c.consequent));
      }
      case "LabeledStatement": return alwaysReturns(node.body);
      default: return false;
    }
  };
  return block.body.length > 0 && block.body.every(alwaysReturns);
};

/* Whether a statement's last act is to return. Takes a statement, not only a
   block, because `else if` hands back an IfStatement whose `alternate` is
   another IfStatement - reading `.body` off one of those is undefined, not an
   empty list. */
const endsWithReturn = (node) => {
  if (!node) return false;
  if (node.type === "ReturnStatement" || node.type === "ThrowStatement") return true;
  if (node.type === "BlockStatement") {
    const last = node.body[node.body.length - 1];
    return last ? endsWithReturn(last) : false;
  }
  if (node.type === "IfStatement") {
    return endsWithReturn(node.consequent) && Boolean(node.alternate) && endsWithReturn(node.alternate);
  }
  if (node.type === "TryStatement") {
    return Boolean(node.finalizer && endsWithReturn(node.finalizer));
  }
  return false;
};

const containsBreak = (node) => {
  let found = false;
  const walk = (n) => {
    if (found || !n || typeof n.type !== "string") return;
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(n.type)) return;
    if (n.type === "BreakStatement") { found = true; return; }
    for (const key of Object.keys(n)) {
      if (["loc", "start", "end", "type"].includes(key)) continue;
      const value = n[key];
      if (Array.isArray(value)) for (const child of value) if (child && child.type) walk(child);
      else if (value && value.type) walk(value);
    }
  };
  for (const child of node.body || []) walk(child);
  return found;
};

/* ------------------------------ complexity ------------------------------ */

/* An estimate, from loop nesting and recursion, with the evidence attached.

   The estimate is only as good as what it saw, so the caveats travel with it.
   A loop containing Array.sort is O(n) to this counter and O(n^2) in reality,
   and a page that reported "O(n)" without saying so would be teaching a false
   bound. */
const estimateComplexity = (facts) => {
  const depth = facts.maxLoopDepth;
  const loopLabel = depth === 0 ? "constant" : LOOP_COST[Math.min(depth, LOOP_COST.length) - 1];

  const caveats = [];
  const hidden = new Map();

  for (const call of facts.calls) {
    const key = call.name.includes(".") ? call.name.split(".")[1] : call.name;
    if (HIDDEN_COSTS[key]) {
      const entry = hidden.get(key) || { ...HIDDEN_COSTS[key], count: 0, line: call.line };
      entry.count += 1;
      hidden.set(key, entry);
    }
  }

  for (const entry of hidden.values()) {
    caveats.push({
      title: entry.note,
      detail: entry.count > 1 ? `called ${entry.count} times` : "called once",
      cost: entry.cost,
      line: entry.line
    });
  }

  if (facts.loops.some((loop) => loop.type === "ForOfStatement" || loop.type === "ForInStatement")) {
    caveats.push({
      title: "for...of and for...in",
      detail: "Treated as a single pass. for...in on an object walks its keys, which is linear in the number of keys.",
      cost: "n",
      line: null
    });
  }

  /* Recursion comes from the walk's own finding - a call to the function it
     sits inside - not from "this function was called once". Using the latter
     made every single-call snippet report an exponential bound. */
  const selfRecursive = facts.recursion || [];

  const time = depth === 0 && !selfRecursive.length
    ? "constant"
    : depth === 0 && selfRecursive.length
      ? "O(n) if the recursion is linear; O(2^n) if it branches twice"
      : loopLabel;

  return {
    time,
    timeIsHeuristic: true,
    space: facts.maxLoopDepth > 1 ? "O(n) if each pass allocates, otherwise O(1)" : "O(1) beyond the input",
    loopDepth: depth,
    loopCount: facts.loops.length,
    loopLines: facts.loops.map((l) => l.line),
    recursion: selfRecursive.map((fn) => ({ name: fn.name, line: fn.line })),
    caveats,
    /* Stated plainly: this is not a proof, and the page must not present it as
       one. */
    basis: depth
      ? `${depth} nested loop${depth === 1 ? "" : "s"} counted in the code`
      : "no loops found"
  };
};

/* -------------------------------- findings ------------------------------ */

const SEVERITY_ORDER = { serious: 0, warning: 1, notice: 2 };

const makeFinding = (ruleKey, line, detail, evidence) => {
  const rule = REVIEW_RULES.find((r) => r.key === ruleKey);
  if (!rule) return null;
  return {
    key: rule.key,
    title: rule.title,
    severity: rule.severity,
    why: rule.why,
    whyItMatters: rule.whyItMatters,
    line: line ?? null,
    detail: detail || null,
    evidence: evidence || null
  };
};

const findIssues = (facts) => {
  const findings = [];

  for (const hit of facts.looseEqualities) {
    if (hit.againstNull) findings.push(makeFinding("eqeqeq-null", hit.line, `\`${hit.code}\``, "the right-hand side is null"));
    else findings.push(makeFinding("loose-equality", hit.line, `\`${hit.code}\``, "neither side is null"));
  }

  for (const block of facts.emptyBlocks) findings.push(makeFinding("empty-block", block.line));

  for (const hit of facts.afterReturn) {
    findings.push(makeFinding("unreachable", hit.line, hit.note || null));
  }

  for (const fn of facts.functions) {
    if (fn.fallsOffEnd && !fn.hasReturnWithValue && !fn.isArrow && !fn.isMethod && !fn.isConstructor) {
      findings.push(makeFinding("no-return", fn.line, fn.name ? `\`${fn.name}\`` : "an anonymous function"));
    }
  }

  /* De-duplicate: several mutations of one array in one loop is one finding. */
  /* Only a mutation of the collection THIS loop is walking. Mutating a
     different array is what accumulating a result looks like. */
  const seenMutation = new Set();
  for (const hit of facts.mutationsInLoop) {
    const owning = facts.loops.find((loop) => loop.subject === hit.target && loop.depth > 0);
    if (!owning) continue;
    const key = `${hit.target}:${hit.line}`;
    if (seenMutation.has(key)) continue;
    seenMutation.add(key);
    findings.push(makeFinding("mutate-while-iterating", hit.line, `\`${hit.code}\``, `\`${hit.target}\` is both the loop's input and is being changed`));
  }

  for (const loop of facts.loops) {
    const mismatch = loopBoundsDisagree(loop);
    if (mismatch) findings.push(makeFinding("off-by-one", loop.line, mismatch));
  }

  for (const name of facts.shadowed) {
    findings.push(makeFinding("shadowed-name", null, `\`${name}\``, "declared more than once in nested scopes"));
  }

  for (const hit of facts.varDeclarations) {
    findings.push(makeFinding("var-usage", hit.line, `\`${hit.name}\``));
  }

  for (const hit of facts.functionsInLoop) {
    findings.push(makeFinding("nested-function-in-loop", hit.line, `\`${hit.name}\``));
  }

  for (const hit of facts.magicIndexes) {
    findings.push(makeFinding("magic-index", hit.line, `\`${hit.code}\``, "a fixed index into something whose length is not checked"));
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.line ?? 999) - (b.line ?? 999));
  return findings;
};

/* Compares a loop's test with its update step.

   `i < n` with `i++` reaches n-1 and stops - which is right. `i <= n` with
   `i++` reaches n - also right. `i < n` with `i += 2` steps over the last
   element when n is odd. The rule only reports the combinations that genuinely
   cannot reach the bound, and says which. */
const loopBoundsDisagree = (loop) => {
  const test = loop.test;
  const update = loop.update;
  if (!test || !update) return null;
  if (test.type !== "BinaryExpression") return null;

  const op = test.operator;
  const step = update.type === "UpdateExpression"
    ? (update.operator === "++" ? 1 : update.operator === "--" ? -1 : 0)
    : update.type === "AssignmentExpression" && update.operator === "+="
      ? (typeof update.right?.value === "number" ? update.right.value : null)
      : null;
  if (step === null || step === 0) return null;

  const increasing = step > 0;
  const rightBound = test.right?.type === "Identifier" ? test.right.name : null;
  const leftBound = test.left?.type === "Identifier" ? test.left.name : null;
  const counter = update.argument?.type === "Identifier"
    ? update.argument.name
    : update.type === "AssignmentExpression" && update.left?.type === "Identifier"
      ? update.left.name
      : null;
  if (!counter) return null;

  /* The bound does not have to be the counter itself - `i < n` is the normal
     shape. What matters is whether the step and the comparison can ever agree
     on an end. */
  const bound = increasing ? (rightBound || "the bound") : (leftBound || "the bound");
  if (counter !== null && counter !== rightBound && counter !== leftBound) return null;

  const magnitude = Math.abs(step);
  const inclusive = op === "<=" || op === ">=";

  if (magnitude > 1) {
    const visits = `it only ever lands on every ${magnitude}${ordinalSuffix(magnitude)} step, so`;
    const ending = inclusive ? "may also overshoot the end" : "stops short of the end";
    return `\`${counter} ${op} ${bound}\` advances by ${magnitude} - ${visits} ${ending}`;
  }
  return null;
};

/* --------------------------- cross-referencing -------------------------- */

/* Compares the code against the problem it is supposedly solving.

   This is a sanity check, not a verdict. It can point out that a nested loop
   does not fit the constraints, or that the code never reads its input, and it
   can say nothing at all about whether the algorithm is right. */
const crossCheck = (facts, complexity, problem) => {
  /* Said rather than left empty. An empty panel here reads as "nothing to say"
     - which is a different claim from "there was nothing to compare against". */
  if (!problem) {
    return {
      checks: [],
      summary: "No problem selected, so there was nothing to compare this against. Pick a problem above and the constraints get checked too."
    };
  }
  const checks = [];

  /* Does the code use the input at all? A solution that never mentions its
     parameter is either not reading the input or reading a global. */
  const readsInput = facts.calls.some((c) => problem.paramHint && c.name === problem.paramHint) ||
    facts.functions.some((fn) => fn.params.includes(problem.paramHint));

  if (problem.paramHint) {
    checks.push({
      key: "reads-input",
      ok: readsInput,
      title: "Reads its input",
      detail: readsInput
        ? `\`${problem.paramHint}\` appears as a parameter or is passed on.`
        : `\`${problem.paramHint}\` never appears. If that is the input, nothing here uses it.`,
      severity: readsInput ? "ok" : "serious"
    });
  }

  /* The useful one: constraints versus the estimate. */
  if (problem.constraintsHint) {
    /* The largest exponent in the constraint text is the input size that matters.
       It is compared against the largest n this loop nest can still handle
       inside roughly 10^8 operations - about where a JavaScript loop stops being
       fast enough for a grader.

       That ceiling is a judgement call, and it is stated as one. It is not a
       proof either way: it will not catch a constant factor, and it cannot see
       work done behind a call. What it does reliably catch is the shape that
       actually fails - an O(n^2) against 10^9 - without crying wolf about a
       correct O(n) against 10^5, which is what a naive threshold did. */
    /* Both `10^9` and `1e9` appear in constraint text and both mean nine
       billion. Capturing the exponent and comparing THAT to an input ceiling
       would compare 9 against 10,000,000,000 and pass every solution. */
    const match = /10\^?(\d+)|1e(\d+)/i.exec(problem.constraintsHint);
    const power = match ? Number(match[1] ?? match[2]) : null;
    const size = power === null ? null : Math.pow(10, power);
    if (size) {
      /* Indexed by depth - 1: a single loop is row 0, not row 1. Using the raw
         depth put every one-loop solution on the two-loop ceiling, which made
         a correct O(n) solution at 10^5 raise a warning. */
      const ceiling = SAFE_INPUT_SIZE[Math.min(Math.max(complexity.loopDepth - 1, 0), SAFE_INPUT_SIZE.length - 1)];
      const extra = complexity.caveats.some((c) => /log n/.test(c.cost)) ? 10 : 1;
      const workable = ceiling * extra;
      if (size > workable) {
        checks.push({
          key: "constraint-fit",
          ok: false,
          title: "Complexity against the constraints",
          detail: `At ${complexity.time} an input of 10^${power} is well past the ~10^8 operations this can do. Constraints reach ${problem.constraintsHint} - this is the shape that times out. Check whether a hash set, a sort or a monotonic pointer avoids it.`,
          severity: "warning"
        });
      } else {
        checks.push({
          key: "constraint-fit",
          ok: true,
          title: "Complexity against the constraints",
          detail: `Estimate ${complexity.time} against constraints reaching ${problem.constraintsHint}, which is within range for this loop nest. The estimate is a heuristic - confirm it yourself.`,
          severity: "ok"
        });
      }
    }
  }

  if (complexity.caveats.length) {
    checks.push({
      key: "hidden-cost",
      ok: false,
      title: "Work the loop counter could not see",
      detail: complexity.caveats.map((c) => `${c.title} (${c.cost}, ${c.detail})`).join("; "),
      severity: "warning"
    });
  }

  return {
    checks,
    /* Not a pass mark. The page must not turn "no problems found" into
       "correct". */
    summary: checks.length
      ? null
      : "Nothing to cross-check without a problem. Paste one above to compare."
  };
};

/* ------------------------------ public API ------------------------------ */

const review = (source, problem = null) => {
  const text = String(source ?? "");
  if (!text.trim()) {
    return { ok: false, error: "There is no code to review." };
  }

  let acorn;
  try {
    acorn = getAcorn();
  } catch {
    return { ok: false, error: "The parser did not load, so nothing can be checked. Reload the page." };
  }

  let ast;
  try {
    ast = acorn.parse(text, { ecmaVersion: 2022, sourceType: "script", locations: true });
  } catch (error) {
    return {
      ok: false,
      error: `That is not valid JavaScript: ${error.message}`,
      line: error.loc?.line ?? null
    };
  }

  /* The walker needs the raw text to quote a fragment back, and passing it on
     a module-level variable is not something worth doing: a second review in the
     same tick would read the wrong source. It is scoped to this call instead. */
  const previous = globalThis.__reviewSource;
  globalThis.__reviewSource = text;
  try {
    const facts = collect(ast);
    const complexity = estimateComplexity(facts);
    const findings = findIssues(facts);
    const cross = crossCheck(facts, complexity, problem);

    return {
      ok: true,
      source: text,
      lineCount: text.split("\n").length,
      complexity,
      findings,
      cross,
      counts: {
        serious: findings.filter((f) => f.severity === "serious").length,
        warning: findings.filter((f) => f.severity === "warning").length,
        notice: findings.filter((f) => f.severity === "notice").length
      },
      facts: {
        functions: facts.functions.length,
        loops: facts.loops.length,
        calls: facts.calls.length,
        recursion: facts.recursion.length
      }
    };
  } finally {
    if (previous === undefined) delete globalThis.__reviewSource;
    else globalThis.__reviewSource = previous;
  }
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    REVIEW_RULES,
    HIDDEN_COSTS,
    LOOP_COST,
    collect,
    estimateComplexity,
    findIssues,
    crossCheck,
    loopBoundsDisagree,
    review
  };
}

if (typeof window !== "undefined" && window) {
  window.reviewEngine = {
    REVIEW_RULES,
    review,
    estimateComplexity,
    findIssues
  };
}

})();
