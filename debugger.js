/* ========================== interactive debugger ==========================
   Step through JavaScript and watch it run, in the page, with no server.

   What it is
   ----------
   You paste JavaScript. Quanta parses it, rewrites it so that every statement
   is a pause point, and runs it as a generator. Stepping is then "resume the
   generator one yield", which means the debugger can stop between any two
   statements and read the live values of the variables at that instant.

   Why it is built this way
   ------------------------
   A debugger that fakes execution is worse than no debugger: it teaches a wrong
   model of what code does. So this one actually runs the code, and the state it
   shows is the real state, read out of the running scope.

   Reading the real state
   ----------------------
   A browser page has no hook that hands you a scope's bindings. The workaround
   here is a snapshot function built from LITERAL eval calls:

       const __snap = () => ({
         x: (() => { try { return eval("x"); } catch (e) { return undefined; } })()
       });

   `eval("x")` with a literal string is a *direct* eval, so it resolves in the
   scope where the snapshot is defined. Because the snapshot is generated inside
   the same function as the user's variables, `x` is the real `x`.

   The detail that decides whether any of this works: the string must be a
   literal. `eval(someVariable)` is an *indirect* eval and runs in global scope,
   where the user's `x` does not exist - it throws ReferenceError for every name
   and silently reads nothing. That was tried first.

   Where the snapshot lives
   -----------------------
   Inside the scope it reads, not beside it. `let` bindings made in a function
   body are in that body's scope, so a snapshot defined one level up cannot see
   them. Every instrumented function therefore gets its own.

   What it refuses to run
   ----------------------
   Anything it cannot instrument correctly is REFUSED, naming the line and the
   construct. It does not attempt a best guess. A subtly wrong trace is the one
   failure mode a learning tool cannot have, so the supported language is a
   deliberate subset - ES2017 without classes, generators, async and modules -
   and everything outside it is rejected before a single step is taken.

   Limits, stated plainly
   ----------------------
   - A step cap stops an infinite loop. Because stepping is a generator resume,
     the loop is genuinely interruptible between statements, not abandoned
     while the tab hangs.
   - Calls to functions Quanta did not define - Math.max, array methods,
     console - are single steps. Their bodies were never parsed, and it does not
     pretend otherwise.
   - The snapshot lists every name in the program, so a name that is out of
     scope reads as undefined. That is the same answer as "not yet assigned",
     which is why the two look alike; the step's line number is what
     distinguishes them.
*/

/* ------------------------------ constants ------------------------------- */

const MAX_STEPS = 5000;
const MAX_SOURCE = 20000;
const MAX_SNAPSHOT_ITEMS = 60;
const MAX_SNAPSHOT_DEPTH = 2;
const MAX_STRING = 160;

/* Node types the instrumenter knows how to print. Anything else is refused,
   because a construct that is not rewritten is a construct whose execution
   cannot be described. */
const SUPPORTED = new Set([
  "Program", "BlockStatement", "ExpressionStatement", "EmptyStatement",
  "VariableDeclaration", "VariableDeclarator",
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression",
  "ReturnStatement", "IfStatement", "ForStatement", "ForOfStatement",
  "ForInStatement", "WhileStatement", "DoWhileStatement",
  "BreakStatement", "ContinueStatement", "SwitchStatement", "SwitchCase",
  "ThrowStatement", "TryStatement", "CatchClause", "FinallyClause",
  "BinaryExpression", "LogicalExpression", "UnaryExpression",
  "UpdateExpression", "ConditionalExpression", "AssignmentExpression",
  "MemberExpression", "CallExpression", "NewExpression",
  "ArrayExpression", "ObjectExpression", "TemplateLiteral", "TemplateElement",
  "Literal", "Identifier", "SequenceExpression", "SpreadElement",
  "ThisExpression", "Property",
  /* Binding patterns. These are not statements and never produce a step of
     their own, but they are ordinary JavaScript and the instrumenter prints
     them, so they belong in the supported set. Refusing them would have made
     every destructuring snippet unrunnable - which is a large part of the code
     people actually want to step through. */
  "ObjectPattern", "ArrayPattern", "AssignmentPattern", "RestElement",
  /* acorn wraps `a?.b.c()` in a ChainExpression around the whole chain. It has
     no runtime meaning of its own; printing its inner expression preserves the
     optional chaining exactly. */
  "ChainExpression"
]);

/* Refused explicitly, each with a name the reader can recognise. */
const REFUSED = {
  ClassDeclaration: "a class declaration",
  ClassExpression: "a class expression",
  YieldExpression: "yield (generators inside your own code)",
  AwaitExpression: "await (async code)",
  ImportDeclaration: "an import statement",
  ExportNamedDeclaration: "an export statement",
  ExportDefaultDeclaration: "an export statement",
  ExportAllDeclaration: "an export statement",
  WithStatement: "a with statement",
  MetaProperty: "import.meta or new.target",
  TaggedTemplateExpression: "a tagged template literal",
  PrivateIdentifier: "a private class field",
  LabeledStatement: "a labelled statement",
  DebuggerStatement: "a debugger statement",
  DoExpression: "a do expression"
};

/* Statements worth pausing on. Expressions inside a statement are not: stopping
   eleven times on `a + b + c` teaches people to press "step over" without
   reading, which is the opposite of the point. */
const STATEMENT_TYPES = new Set([
  "ExpressionStatement", "VariableDeclaration", "ReturnStatement",
  "IfStatement", "ForStatement", "ForOfStatement", "ForInStatement",
  "WhileStatement", "DoWhileStatement", "BreakStatement",
  "ContinueStatement", "SwitchStatement", "ThrowStatement", "TryStatement",
  "FunctionDeclaration"
]);

class DebuggerError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "DebuggerError";
    this.line = detail.line ?? null;
    this.column = detail.column ?? null;
    this.construct = detail.construct ?? null;
  }
}

/* ---------------------------- value rendering --------------------------- */

/* Turns a value into something printable, without ever throwing.

   A debugger that dies while rendering a value loses the trace at exactly the
   moment the reader wanted it most, so cycles, oversized structures, throwing
   getters and exotic types all degrade to a description instead of an
   exception. */
const renderValue = (value, depth = 0, seen = new WeakSet()) => {
  const type = typeof value;

  if (value === null) return { type: "null", text: "null" };
  if (value === undefined) return { type: "undefined", text: "undefined" };
  if (type === "number") {
    if (Number.isNaN(value)) return { type: "number", text: "NaN" };
    if (!Number.isFinite(value)) return { type: "number", text: value > 0 ? "Infinity" : "-Infinity" };
    /* -0 prints as -0. The difference from 0 is a real thing that catches
       people out, and a debugger that hides it teaches the wrong lesson. */
    return { type: "number", text: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (type === "string") {
    const shown = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
    return { type: "string", text: JSON.stringify(shown) };
  }
  if (type === "boolean") return { type: "boolean", text: String(value) };
  if (type === "bigint") return { type: "bigint", text: `${value}n` };
  if (type === "symbol") return { type: "symbol", text: String(value) };
  if (type === "function") return { type: "function", text: value.name ? `ƒ ${value.name}()` : "ƒ anonymous()" };

  /* A cycle is common - a linked list, a parent pointer - and must not spin. */
  if (seen.has(value)) return { type: "circular", text: "[circular]" };
  if (depth >= MAX_SNAPSHOT_DEPTH) return { type: "truncated", text: Array.isArray(value) ? "[…]" : "{…}" };

  if (value instanceof Error) return { type: "error", text: `${value.name}: ${value.message}` };
  if (value instanceof Date) return { type: "date", text: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() };
  if (value instanceof RegExp) return { type: "regexp", text: String(value) };
  if (typeof Element !== "undefined" && value instanceof Element) {
    return { type: "dom", text: `<${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ""}>` };
  }
  if (typeof Node !== "undefined" && value instanceof Node) return { type: "dom", text: value.nodeName };

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_SNAPSHOT_ITEMS).map((item) => renderValue(item, depth + 1, seen));
      const hidden = Math.max(0, value.length - MAX_SNAPSHOT_ITEMS);
      const parts = items.map((item) => item.text);
      if (hidden) parts.push(`… ${hidden} more`);
      return { type: "array", length: value.length, text: `[${parts.join(", ")}]`, items, hidden };
    }
    if (value instanceof Map) {
      const entries = [...value.entries()].slice(0, MAX_SNAPSHOT_ITEMS)
        .map(([k, v]) => `${renderValue(k, depth + 1, seen).text} => ${renderValue(v, depth + 1, seen).text}`);
      return { type: "map", length: value.size, text: `Map(${value.size}) {${entries.join(", ")}}` };
    }
    if (value instanceof Set) {
      const entries = [...value.values()].slice(0, MAX_SNAPSHOT_ITEMS)
        .map((v) => renderValue(v, depth + 1, seen).text);
      return { type: "set", length: value.size, text: `Set(${value.size}) {${entries.join(", ")}}` };
    }

    /* Own keys only. Walking an inherited tree is how a value dump ends up
       invoking a getter that throws. */
    const keys = Object.keys(value);
    const entries = keys.slice(0, MAX_SNAPSHOT_ITEMS).map((key) => {
      let item;
      try {
        item = renderValue(value[key], depth + 1, seen);
      } catch {
        item = { type: "unreadable", text: "<could not read>" };
      }
      return { key, ...item };
    });
    const hidden = Math.max(0, keys.length - MAX_SNAPSHOT_ITEMS);
    const name = value.constructor && value.constructor.name && value.constructor.name !== "Object"
      ? `${value.constructor.name} `
      : "";
    return {
      type: "object",
      length: keys.length,
      text: `${name}{${entries.map((e) => `${e.key}: ${e.text}`).join(", ")}${hidden ? `, … ${hidden} more` : ""}}`,
      entries,
      hidden
    };
  } finally {
    seen.delete(value);
  }
};

/* ------------------------------- parsing -------------------------------- */

const getAcorn = () => {
  if (typeof window !== "undefined" && window && window.acorn) return window.acorn;
  return require("acorn");
};

/* Names a binding pattern introduces. Destructuring is supported, so this has
   to handle ObjectPattern, ArrayPattern, AssignmentPattern, RestElement and
   any nesting of them. */
const patternNames = (pattern, into) => {
  if (!pattern) return into;
  switch (pattern.type) {
    case "Identifier": into.push(pattern.name); break;
    case "ObjectPattern":
      for (const prop of pattern.properties) patternNames(prop.type === "RestElement" ? prop.argument : prop.value, into);
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) patternNames(element, into);
      break;
    case "AssignmentPattern": patternNames(pattern.left, into); break;
    case "RestElement": patternNames(pattern.argument, into); break;
    default: break;
  }
  return into;
};

/* Parses, checks the whole tree against the supported subset, and collects the
   names the snapshot will need. Refusal happens here - before anything is
   compiled or run - so a snippet that cannot be debugged never starts. */
const analyse = (source) => {
  const text = String(source ?? "");
  if (!text.trim()) throw new DebuggerError("There is no code to run.");

  let acorn;
  try {
    acorn = getAcorn();
  } catch {
    throw new DebuggerError("The JavaScript parser did not load, so the code cannot be checked. Reload the page.");
  }

  let ast;
  try {
    /* `locations` is off by default in acorn. Without it every node's `loc` is
       undefined and every step reports line null - which is not a degraded
       trace, it is a trace that cannot point at the reader's own code. */
    ast = acorn.parse(text, { ecmaVersion: 2022, sourceType: "script", locations: true });
  } catch (error) {
    /* acorn's own message is good - "Unexpected token (3:12)" - so it is passed
       through rather than replaced with something vaguer. */
    throw new DebuggerError(`That is not valid JavaScript: ${error.message}`, {
      line: error.loc?.line ?? null,
      column: error.loc?.column ?? null
    });
  }

  const names = [];
  const functions = new Set();
  const constructors = new Set();
  const warnings = [];
  let loopCount = 0;
  let statementCount = 0;

  const seenName = new Set();

  const walk = (node) => {
    if (!node || typeof node.type !== "string") return;

    if (REFUSED[node.type]) {
      throw new DebuggerError(
        `This debugger cannot run ${REFUSED[node.type]} yet. Everything around it will work fine.`,
        { line: node.loc?.start?.line ?? null, column: node.loc?.start?.column ?? null, construct: node.type }
      );
    }
    if (!SUPPORTED.has(node.type)) {
      throw new DebuggerError(`This debugger does not know how to step through "${node.type}".`, {
        line: node.loc?.start?.line ?? null,
        column: node.loc?.start?.column ?? null,
        construct: node.type
      });
    }

    const add = (name) => {
      if (!seenName.has(name)) {
        seenName.add(name);
        names.push(name);
      }
    };

    /* `patternNames` collects names into a plain array; `add` deduplicates.
       Passing `[add]` as the collector and expecting it to be called is wrong -
       the helper pushes the name, not the result of calling anything - which is
       why every variable silently went missing from the state panel. */
    const addPattern = (patternNode) => {
      for (const name of patternNames(patternNode, [])) add(name);
    };

    if (node.type === "VariableDeclarator") {
      addPattern(node.id);
      /* A function bound to a name is steppable, exactly like a declaration:
         `const f = n => n * 2` should be entered with a keypress, not skipped.
         Without this the call site is left as a plain call while the function
         has been rewritten into a generator, and the call returns a generator
         object instead of the answer. */
      if (node.id.type === "Identifier" && node.init &&
          ["FunctionExpression", "ArrowFunctionExpression"].includes(node.init.type)) {
        functions.add(node.id.name);
        /* A named function expression can call itself by its own name. That
           name has to be steppable too, or the recursive call is left as a
           plain call to a generator - which returns a generator object rather
           than a number, and quietly turns `n * fact(n - 1)` into NaN. */
        if (node.init.id && node.init.id.name) functions.add(node.init.id.name);
      }
    }
    if (node.type === "CatchClause" && node.param) addPattern(node.param);

    if (node.type === "FunctionDeclaration" && node.id) {
      functions.add(node.id.name);
      add(node.id.name);
    }
    if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionDeclaration") {
      for (const param of node.params) addPattern(param);
    }

    /* Used with `new`, so it must stay an ordinary function: a generator is not
       a constructor and `new` on one throws. A function in both roles is left
       alone and runs as a single step, which is the conservative choice - it
       cannot produce a wrong answer, only a coarser trace. */
    if (node.type === "NewExpression" && node.callee.type === "Identifier") {
      constructors.add(node.callee.name);
    }

    if (["ForStatement", "ForOfStatement", "ForInStatement", "WhileStatement", "DoWhileStatement"].includes(node.type)) {
      loopCount += 1;
    }
    if (STATEMENT_TYPES.has(node.type)) statementCount += 1;

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object" && child.type) walk(child);
      } else if (value && typeof value === "object" && typeof value.type === "string") {
        walk(value);
      }
    }
  };

  for (const node of ast.body) walk(node);

  for (const name of constructors) functions.delete(name);

  if (statementCount === 0) {
    warnings.push("There are no statements here, so there is nothing to step through.");
  }
  if (names.length === 0) {
    warnings.push("This snippet declares no variables, so the state panel will stay empty.");
  }
  if (constructors.size) {
    warnings.push(
      `${[...constructors].join(", ")} ${constructors.size === 1 ? "is" : "are"} used with new, so ${
        constructors.size === 1 ? "it runs" : "they run"
      } as a single step rather than one you can step into.`
    );
  }

  return {
    ast,
    source: text,
    names,
    functions,
    constructors,
    loopCount,
    statementCount,
    warnings
  };
};

/* ---------------------------- the instrumenter -------------------------- */

/* Prints the tree back out as JavaScript, with a pause before each statement.

   Printing rather than text-patching is what makes this trustworthy: the output
   is generated from the parse tree, so a pause can only land on a real
   statement boundary and a stray brace inside a string cannot confuse it. The
   cost is that comments are gone - they are not in the tree - and the printed
   form does not look like what was typed. The step list therefore reports the
   ORIGINAL line numbers, taken from the tree, not from the generated source. */
const instrument = (analysed) => {
  const { names, functions } = analysed;
  const steps = [];
  const loops = [];
  let counter = 0;

  /* Inside a function Quanta did not rewrite as a generator, `yield` is a
     syntax error rather than a pause. So pauses are suppressed in exactly those
     bodies - object methods, callbacks, constructors - and their contents run as
     a single step, which is the truth: they were not instrumented. A counter
     rather than a flag, so a steppable function nested inside a non-steppable
     one is still instrumented correctly. */
  let suppressPause = 0;

  /* The snapshot lists every name in the program.

     A name is present in the result only if a binding for it was actually
     reachable from where this snapshot sits. That distinction matters: direct
     eval of an identifier with no binding throws ReferenceError, while a binding
     that exists and holds `undefined` does not. So each name is probed in its
     own try block, and a key that is absent from the result means "not visible
     here" rather than "visible and empty".

     Without that, every name would appear on every line with `undefined`
     against it, and a variable about to be assigned its first value would look
     identical to one that does not exist in this scope at all. A binding still
     in its temporal dead zone - `n` inside a call on the line
     `let n = add(2, 3)` - also throws, and is reported as not yet available,
     which is the honest description of where it is. */
  const snapshot = () =>
    `const __snap = () => {
  const __o = {};
${names
  .map((name) => `  try { __o[${JSON.stringify(name)}] = eval(${JSON.stringify(name)}); } catch (e) { /* no binding here */ }`)
  .join("\n")}
  return __o;
};`;

  const pauseFor = (node) => {
    /* Nothing to pause on inside code that is not running as a generator. */
    if (suppressPause) return "";
    const line = node.loc?.start?.line ?? null;
    counter += 1;
    const loopId = loops.length ? loops[loops.length - 1].id : null;
    steps.push({ id: counter, line, loopId });
    /* `yield` is what actually pauses the generator. The value handed to it is
       discarded - `step` records the frame as a side effect and its return
       value exists only so the runtime can signal that the step cap was hit by
       throwing. Emitting the call without `yield` would run the whole snippet
       in one go and produce a single frame at the end. */
    return `\n  yield __q.step(${counter}, __snap, ${line === null ? "null" : line}, ${loopId === null ? "null" : JSON.stringify(loopId)});`;
  };

  /* ---- expressions ---------------------------------------------------- */

  /* `opts.generator` marks a function as one the call sites will `yield*`
     into. It has to be threaded explicitly rather than guessed from the node,
     because the same node type is steppable or not depending on what it was
     bound to. */
  const expr = (node, opts = {}) => {
    if (!node) return "undefined";
    switch (node.type) {
      case "Identifier": return node.name;
      case "Literal": return node.raw !== undefined ? node.raw : JSON.stringify(node.value);
      case "ThisExpression": return "this";
      case "SequenceExpression": return `(${node.expressions.map(expr).join(", ")})`;
      case "AssignmentExpression":
        /* Written longhand so every assignment looks the same in the generated
           source. The value of the expression is identical either way. */
        return `(${expr(node.left)} = ${expr(node.left)} ${node.operator} ${expr(node.right)})`;
      case "BinaryExpression":
      case "LogicalExpression":
        return `(${expr(node.left)} ${node.operator} ${expr(node.right)})`;
      case "UnaryExpression": return `(${node.operator}${expr(node.argument)})`;
      case "UpdateExpression":
        /* `prefix` is not decoration. `i++` yields the old value and `++i`
           yields the new one, so printing both as postfix silently changes what
           any expression using the result evaluates to. */
        return node.prefix
          ? `(${node.operator}${expr(node.argument)})`
          : `(${expr(node.argument)}${node.operator})`;
      case "ConditionalExpression":
        return `(${expr(node.test)} ? ${expr(node.consequent)} : ${expr(node.alternate)})`;
      case "MemberExpression": {
        const object = expr(node.object);
        if (node.optional) return `(${object}?.${node.computed ? `[${expr(node.property)}]` : node.property.name})`;
        return node.computed ? `(${object}[${expr(node.property)}])` : `(${object}.${node.property.name})`;
      }
      case "CallExpression": {
        const args = node.arguments.map(expr).join(", ");
        /* A call to a function defined in this snippet becomes `yield*`, and
           that is what lets the debugger step INTO it. Everything else -
           Math.max, array.map, console.log - stays one indivisible step,
           because its body was never parsed. */
        if (node.callee.type === "Identifier" && functions.has(node.callee.name)) {
          return `(yield* ${node.callee.name}(${args}))`;
        }
        return `${expr(node.callee)}(${args})`;
      }
      case "NewExpression": return `new ${expr(node.callee)}(${node.arguments.map(expr).join(", ")})`;
      case "ArrayExpression": return `[${node.elements.map((e) => (e ? expr(e) : "")).join(", ")}]`;
      case "ObjectExpression": {
        const parts = node.properties.map((prop) => {
          if (prop.type === "SpreadElement") return `...${expr(prop.argument)}`;
          const key = prop.computed
            ? `[${expr(prop.key)}]`
            : prop.key.type === "Identifier"
              ? prop.key.name
              : JSON.stringify(prop.key.value);
          return `${key}: ${expr(prop.value)}`;
        });
        return `{ ${parts.join(", ")} }`;
      }
      case "TemplateLiteral": {
        const quasis = node.quasis.map((q) => JSON.stringify(q.value.cooked ?? q.value.raw));
        let out = quasis[0];
        node.expressions.forEach((e, i) => {
          out += ` + (${expr(e)}) + ${quasis[i + 1]}`;
        });
        return out;
      }
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const params = node.params.map(pattern).join(", ");
        /* A generator only when the call sites will `yield*` into it. Rewriting
           a function into a generator it is never resumed from changes what
           calling it returns - a generator object instead of its result - so
           object methods, callbacks and anything else not bound to a steppable
           name are left as ordinary functions. */
        if (!opts.generator) {
          /* Pauses inside it are suppressed: `yield` would not compile there,
             and pretending otherwise would produce a trace of a body that was
             never stepped through. */
          suppressPause += 1;
          try {
            if (node.body.type === "BlockStatement") {
              return `(function${node.id ? ` ${node.id.name}` : ""} (${params}) {\n${statements(node.body.body)}\n})`;
            }
            return `(((${params}) => (${expr(node.body)})))`;
          } finally {
            suppressPause -= 1;
          }
        }
        /* A concise arrow body has no block to pause in. Wrapping it in a
           generator with an explicit return keeps the calling convention and
           the value identical. */
        const body = node.body.type === "BlockStatement"
          ? `\n${statements(node.body.body)}\n  `
          : `{ return (${expr(node.body)}); }`;
        /* The name is kept on a generator too. A named function expression can
           call itself by that name, and dropping it makes that call a
           ReferenceError. */
        const generatedName = node.id ? node.id.name : opts.name;
        const frame = generatedName
          ? `\n  __q.enter(${JSON.stringify(generatedName)});\n  try {`
          : "";
        const unframe = generatedName ? `\n  } finally { __q.exit(${JSON.stringify(generatedName)}); }` : "";
        return `(function* ${node.id ? node.id.name : ""}(${params}) {\n  ${snapshot()}${frame}${body}${unframe}\n})`;
      }
      case "ChainExpression":
        /* A wrapper acorn puts around `a?.b.c()`. Its `expression` is the whole
           chain, and printing that verbatim keeps the optional chaining in
           place - flattening it to `a.b.c()` would change what happens when `a`
           is null. */
        return expr(node.expression, opts);
      case "SpreadElement": return `...${expr(node.argument)}`;
      default:
        /* Unreachable while the checker and the printer agree; the checker runs
           first and refuses anything they disagree about. */
        throw new DebuggerError(`Cannot print "${node.type}".`, {
          line: node.loc?.start?.line ?? null,
          construct: node.type
        });
    }
  };

  /* ---- binding patterns ------------------------------------------------ */

  const pattern = (node) => {
    if (!node) return "";
    switch (node.type) {
      case "Identifier": return node.name;
      case "ObjectPattern": {
        const parts = node.properties.map((prop) =>
          prop.type === "RestElement"
            ? `...${pattern(prop.argument)}`
            : `${prop.computed ? `[${expr(prop.key)}]` : prop.key.type === "Identifier" ? prop.key.name : JSON.stringify(prop.key.value)}: ${pattern(prop.value)}`
        );
        return `{ ${parts.join(", ")} }`;
      }
      case "ArrayPattern": return `[${node.elements.map((e) => pattern(e)).join(", ")}]`;
      case "AssignmentPattern": return `${pattern(node.left)} = ${expr(node.right)}`;
      case "RestElement": return `...${pattern(node.argument)}`;
      default:
        throw new DebuggerError(`Cannot print binding pattern "${node.type}".`, { construct: node.type });
    }
  };

  /* A `for` head holds a declaration as well as expressions - `for (let i = 0;
     ...)` is the common case - and a declaration has no expression form. It is
     printed without a pause, because the loop's own header is not a statement a
     reader thinks of as a step. */
  const head = (node, opts) => {
    if (!node) return "";
    if (node.type === "VariableDeclaration") {
      /* `for (const x of xs)` declares `x`; a plain `for` initialiser also
         gives it a value. Both are declarations, and neither is an expression,
         so neither can go through `expr`. */
      const parts = node.declarations.map((d) =>
        d.init ? `${pattern(d.id)} = ${expr(d.init)}` : pattern(d.id)
      );
      return `${node.kind} ${parts.join(", ")}`;
    }
    return expr(node, opts);
  };

  /* ---- statements ------------------------------------------------------ */

  const statements = (list) =>
    list.filter((n) => n.type !== "EmptyStatement").map(statement).join("\n");

  /* Accepts a block or a single bare statement. `if (x) break;` and
     `for (...) console.log(i)` are both legal and both common in teaching
     snippets, and acorn hands back a bare statement rather than a block for
     them. The bare statement is wrapped in a block so the printed form stays
     uniform - and wrapping is safe precisely because a lexical declaration
     cannot be a bare body (`if (x) let y = 1` is a syntax error), so nothing
     wrapped here had a scope of its own to lose. */
  const block = (node) => {
    if (!node) return "{}";
    if (node.type !== "BlockStatement") return `{\n${statement(node)}\n}`;
    /* A snapshot inside every block that contains a pause.

       This is not tidiness, it is correctness. `for (let i = 0; ...)` puts `i`
       in the for-statement's own scope, nested inside the function - so a
       snapshot defined at the top of the function resolves `i` lexically
       outwards, does not find it, and reports undefined. That is exactly the
       variable the reader is watching, so the loop body gets its own snapshot,
       which shadows the outer one and can see everything the outer one can. */
    const inner = statements(node.body);
    const needsSnapshot = node.body.some((child) => STATEMENT_TYPES.has(child?.type));
    if (!needsSnapshot) return `{\n${inner}\n}`;
    return `{\n  ${snapshot()}\n${inner}\n}`;
  };

  /* Loops get an id so the runtime can count their passes, which is what makes
     "third time round the loop" visible rather than guessed at. */
  const withLoop = (node, fn) => {
    loops.push({ id: `${node.type.toLowerCase().replace("statement", "")}@${node.loc?.start?.line ?? "?"}` });
    try {
      return fn();
    } finally {
      loops.pop();
    }
  };

  const statement = (node) => {
    const line = node.loc?.start?.line ?? null;
    const pause = () => pauseFor(node);

    switch (node.type) {
      case "ExpressionStatement":
        return `${pause()}\n  ${expr(node.expression)};`;
      case "VariableDeclaration": {
        const parts = node.declarations.map((d) => {
          /* A function bound to a name is rewritten as a generator so it can be
             stepped into; anything else stays as written. */
          const steppable = d.id.type === "Identifier" &&
            functions.has(d.id.name) &&
            d.init &&
            ["FunctionExpression", "ArrowFunctionExpression"].includes(d.init.type);
          return `${pattern(d.id)} = ${expr(d.init, { generator: steppable, name: d.id.name })}`;
        });
        return `${pause()}\n  ${node.kind} ${parts.join(", ")};`;
      }
      case "FunctionDeclaration": {
        const params = node.params.map(pattern).join(", ");
        /* A function used with `new` is not a generator: generators cannot be
           constructed, and turning one into a generator would make `new P(3)`
           throw. Those were excluded from the steppable set during analysis. */
        const asGenerator = functions.has(node.id.name);
        /* `try/finally` around the body so the call stack unwinds on every exit
           path: a normal return, an early return, or a thrown error. Without it
           a throw would leave the frame on the stack forever. */
        if (!asGenerator) {
          /* Pauses suppressed for the same reason as a plain function
             expression: `yield` does not compile outside a generator. */
          suppressPause += 1;
          try {
            return `function ${node.id.name}(${params}) {\n${statements(node.body.body)}\n}`;
          } finally {
            suppressPause -= 1;
          }
        }
        return `function* ${node.id.name}(${params}) {\n  ${snapshot()}\n  __q.enter(${JSON.stringify(node.id.name)});\n  try {\n${statements(node.body.body)}\n  } finally { __q.exit(${JSON.stringify(node.id.name)}); }\n}`;
      }
      case "ReturnStatement":
        return `${pause()}\n  return ${expr(node.argument)};`;
      case "IfStatement": {
        /* The alternate is wrapped in braces even when it already is a block.
           This is not cosmetic. The pause is injected as a bare statement, and
           `else <pause>; hi = mid - 1;` binds the else to the pause alone - so
           the assignment would run on every pass, not only the else branch.
           That silently rewrites the program, and it is how binary search came
           to return -1 for a value that is in the array. */
        const alternate = node.alternate ? `\n  else ${block(node.alternate)}` : "";
        return `${pause()}\n  if (${expr(node.test)}) ${block(node.consequent)}${alternate}`;
      }
      case "ForStatement":
        return withLoop(node, () => {
          const id = JSON.stringify(loops[loops.length - 1].id);
          /* `__q.loop(...)` runs before the test on every pass, including the
             first, so the count shown always means "times around", not
             "times that passed the test". */
          return `${pause()}\n  for (${head(node.init)}; __q.loop(${id}), ${expr(node.test)}; ${expr(node.update)}) ${block(node.body)}`;
        });
      case "ForOfStatement":
        return withLoop(node, () => {
          const id = JSON.stringify(loops[loops.length - 1].id);
          return `${pause()}\n  for (${head(node.left)} of __q.each(${id}, ${expr(node.right)})) ${block(node.body)}`;
        });
      case "ForInStatement":
        return withLoop(node, () => {
          const id = JSON.stringify(loops[loops.length - 1].id);
          return `${pause()}\n  for (${head(node.left)} in __q.keys(${id}, ${expr(node.right)})) ${block(node.body)}`;
        });
      case "WhileStatement":
        return withLoop(node, () => {
          const id = JSON.stringify(loops[loops.length - 1].id);
          return `${pause()}\n  while (__q.loop(${id}), ${expr(node.test)}) ${block(node.body)}`;
        });
      case "DoWhileStatement":
        return withLoop(node, () => {
          const id = JSON.stringify(loops[loops.length - 1].id);
          return `do ${block(node.body)} while (__q.loop(${id}), ${expr(node.test)});`;
        });
      case "BreakStatement":
        return `${pause()}\n  break;`;
      case "ContinueStatement":
        return `${pause()}\n  continue;`;
      case "ThrowStatement":
        return `${pause()}\n  throw ${expr(node.argument)};`;
      case "TryStatement": {
        let out = `${pause()}\n  try ${block(node.block)}`;
        if (node.handler) out += ` catch (${pattern(node.handler.param)}) ${block(node.handler.body)}`;
        if (node.finalizer) out += ` finally ${block(node.finalizer)}`;
        return out;
      }
      case "SwitchStatement": {
        const cases = node.cases.map((c) =>
          `    case ${expr(c.test)}:\n${statements(c.consequent)}\n      break;`
        );
        return `${pause()}\n  switch (${expr(node.discriminant)}) {\n${cases.join("\n")}\n  }`;
      }
      case "BlockStatement":
        /* Reached for a braced `else`, and for a bare `else if`, which acorn
           gives as an IfStatement rather than a block. */
        return block(node);
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return expr(node);
      default:
        throw new DebuggerError(`Cannot print statement "${node.type}".`, { line, construct: node.type });
    }
  };

  const body = statements(analysed.ast.body);

  /* One last pause, after everything has run.

     Without it the final state of the program is never visible. Every pause
     sits BEFORE its statement, so the effect of the last statement - the one
     that computes the answer - happens after the last frame the debugger
     takes, and `o.b = 2` on the final line would leave the panel still showing
     `o` without the `b`. This frame is what makes "what did this leave
     behind?" answerable, which is the most common question about a snippet. */
  const lastLine = analysed.ast.body.length
    ? analysed.ast.body[analysed.ast.body.length - 1].loc?.end?.line ?? null
    : null;
  const tail = suppressPause ? "" : `\n  yield __q.done(__snap, ${lastLine === null ? "null" : lastLine});`;

  const source =
    `return (function* () {\n  ${snapshot()}\n${body}${tail}\n})();`;

  return { source, steps, names, loopCount: loops.length };
};

/* ------------------------------- the runtime ---------------------------- */

/* Thrown by `step` when the cap is reached. A distinct type so the runner can
   tell "the snippet hit the step limit" from "the snippet threw", which are very
   different things to show the reader. */
class StepCapReached extends Error {
  constructor(limit) {
    super(`Stopped after ${limit} steps.`);
    this.name = "StepCapReached";
    this.limit = limit;
  }
}

/* The recorder the instrumented code talks to.

   `step` is the pause point. It is called before each statement, so the
   variables it captures are the values as they were BEFORE that statement ran -
   which is the moment a reader wants, because it is the moment they can still
   see why the statement is about to do what it does. */
class Session {
  constructor(analysed, printed, { maxSteps = MAX_STEPS } = {}) {
    this.analysed = analysed;
    this.printed = printed;
    this.maxSteps = maxSteps;
    this.index = -1;
    this.steps = [];
    this.output = [];
    this.stack = ["top level"];
    this.loopCounts = new Map();
    this.finished = false;
    this.error = null;
    this.capped = false;
    this.generator = null;
    this.current = null;
  }

  /* Pauses here, by being yielded. Throws when the step cap is reached, which
     is the only way to actually stop a generator from the inside - returning
     a value would resume straight into the next statement. */
  step(id, snapshot, line, loopId) {
    if (this.steps.length >= this.maxSteps) {
      this.capped = true;
      throw new StepCapReached(this.maxSteps);
    }
    const iteration = loopId ? (this.loopCounts.get(loopId) || 0) : null;
    let variables = {};
    try {
      variables = snapshot ? snapshot() : {};
    } catch (error) {
      /* A snapshot that throws must not take the run down with it. The step is
         still recorded; its values are simply unknown. */
      variables = { __error: error.message };
    }

    const frame = {
      index: this.steps.length,
      stepId: id,
      line,
      loopId,
      iteration,
      /* The line is reported as typed, from the tree. The generated source has
         different numbering, so quoting a line number from it would point the
         reader at the wrong line of their own code. */
      stack: [...this.stack],
      variables: renderVariables(variables, this.analysed.names)
    };
    this.steps.push(frame);
    this.current = frame;
    return frame;
  }

  enter(name) {
    this.stack.push(name);
  }

  /* The frame taken after the last statement, so the program's final state is
     visible. Labelled as the end rather than as a line, because it is not a
     line of anyone's code. */
  done(snapshot, line) {
    if (this.steps.length >= this.maxSteps) {
      this.capped = true;
      throw new StepCapReached(this.maxSteps);
    }
    let variables = {};
    try {
      variables = snapshot ? snapshot() : {};
    } catch {
      variables = {};
    }
    const frame = {
      index: this.steps.length,
      stepId: null,
      line,
      /* The reason the panel can say "finished" rather than leaving the reader
         to infer it from a line number that does not exist. */
      finished: true,
      loopId: null,
      iteration: null,
      stack: [...this.stack],
      variables: renderVariables(variables, this.analysed.names)
    };
    this.steps.push(frame);
    this.current = frame;
    return frame;
  }

  exit() {
    if (this.stack.length > 1) this.stack.pop();
  }

  loop(id) {
    this.loopCounts.set(id, (this.loopCounts.get(id) || 0) + 1);
    return true;
  }

  each(id, iterable) {
    /* Materialised rather than lazily consumed, because a generator-backed
       for-of would only run as far as the debugger stepped, which would make
       the loop's own behaviour depend on how fast the reader clicked. */
    this.loopCounts.set(id, (this.loopCounts.get(id) || 0) + 1);
    return [...(iterable ?? [])];
  }

  keys(id, object) {
    this.loopCounts.set(id, (this.loopCounts.get(id) || 0) + 1);
    return object == null ? [] : Object.keys(Object(object));
  }

  log(level, args) {
    if (this.output.length >= 500) return;
    this.output.push({
      level,
      text: args.map((a) => (typeof a === "string" ? a : safeText(a))).join(" ")
    });
  }

  /* Compiled once and run as a generator. `new Function` is the only way to run
     code that is not already a module, and the snippet is the user's own text
     on their own machine - there is nothing here to protect it from. */
  compile() {
    const consoleShim = {};
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      consoleShim[level] = (...args) => this.log(level, args);
    }

    /* eslint-disable-next-line no-new-func */
    const factory = new Function("__q", "console", this.printed.source);
    this.generator = factory(this, consoleShim);
  }

  /* One press of step. Returns the frame now current. */
  advance() {
    if (this.finished || this.error) return this.current;
    if (!this.generator) this.compile();

    try {
      const result = this.generator.next();
      /* `done` means the snippet ran out. The frame taken by `done` stays
         current, because it is the program's final state and clearing it would
         leave the panel showing the state from before the answer was computed. */
      this.finished = Boolean(result.done);
      if (result.done) this.current = this.steps[this.steps.length - 1] || null;
    } catch (error) {
      if (error instanceof StepCapReached) {
        /* Not a failure of the snippet - it simply ran longer than the cap.
           The last recorded frame is where it got to, and the page says so
           rather than reporting an error the reader did not cause. */
        this.finished = true;
        this.current = this.steps[this.steps.length - 1] || null;
      } else {
        this.error = {
          name: error?.name || "Error",
          message: error?.message || String(error),
          line: this.current?.line ?? null,
          stack: String(error?.stack || "").split("\n").slice(0, 6)
        };
        this.finished = true;
        /* The last frame is kept rather than cleared. "Where was it when it
           threw?" is the first question anyone asks after an error, and the
           answer is on screen precisely because the throw happened after the
           final pause, between one statement and the next. */
        this.current = this.steps[this.steps.length - 1] || null;
      }
    }
    return this.current;
  }

  /* Runs forward to the next pause whose line is in `lines`.

     The current pause is always left first. Without that, "continue" while
     already sitting on a breakpoint would appear to do nothing, which is the
     single most confusing thing a step-through debugger can do. */
  runTo(lines) {
    const wanted = lines instanceof Set ? lines : new Set(lines || []);
    if (!wanted.size) return this.runToEnd();
    if (this.finished || this.error) return this.current;

    /* Leave where we are. */
    this.advance();
    while (!this.finished && !this.error && this.current && !wanted.has(this.current.line)) {
      this.advance();
    }
    return this.current;
  }

  runToEnd() {
    while (!this.finished && !this.error) this.advance();
    return this.current;
  }

  reset() {
    this.index = -1;
    this.steps = [];
    this.output = [];
    this.stack = ["top level"];
    this.loopCounts = new Map();
    this.finished = false;
    this.error = null;
    this.capped = false;
    this.generator = null;
    this.current = null;
  }

  get state() {
    return {
      current: this.current,
      steps: this.steps,
      output: this.output,
      finished: this.finished,
      error: this.error,
      capped: this.capped,
      stepCount: this.steps.length,
      maxSteps: this.maxSteps,
      stack: [...this.stack]
    };
  }
}

const safeText = (value) => {
  try {
    return renderValue(value).text;
  } catch {
    return "<could not read>";
  }
};

/* Turns the raw snapshot object into the ordered list the panel draws, keeping
   declared order so the variables do not jump around between steps.

   A name missing from the snapshot has no binding reachable here - it is out of
   scope, or not yet initialised. That is a different fact from "here and holds
   undefined", and both are shown, because a reader deciding why a variable is
   not what they expected needs to know which of the two it is. */
const renderVariables = (values, names) => {
  const rows = [];
  const add = (name, undeclared) => {
    const present = Object.prototype.hasOwnProperty.call(values, name);
    if (!present && !undeclared) {
      rows.push({ name, value: undefined, display: "not in scope here", kind: "out-of-scope", present: false });
      return;
    }
    const rendered = present ? renderValue(values[name]) : { type: "undefined", text: "undefined" };
    rows.push({ name, value: rendered.value, display: rendered.text, kind: rendered.type, present });
  };

  for (const name of names) add(name, false);
  /* Anything the snapshot caught that was never declared - a global assignment,
     for instance - is still shown, at the end, rather than dropped. */
  for (const name of Object.keys(values)) {
    if (names.includes(name)) continue;
    add(name, true);
  }
  for (const row of rows) if (row.undeclared) row.undeclared = true;
  return rows;
};

/* ------------------------------ public API ------------------------------ */

/* Compiles source into a runnable session, or throws a DebuggerError explaining
   why it cannot. Every entry point the page uses goes through here, so there is
   one place where "can this run?" is decided. */
const prepare = (source, options = {}) => {
  const analysed = analyse(source);
  const printed = instrument(analysed);
  const session = new Session(analysed, printed, options);
  return { analysed, printed, session };
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DebuggerError,
    StepCapReached,
    Session,
    MAX_STEPS,
    MAX_SOURCE,
    SUPPORTED,
    REFUSED,
    STATEMENT_TYPES,
    patternNames,
    analyse,
    instrument,
    renderValue,
    renderVariables,
    prepare
  };
}

if (typeof window !== "undefined" && window) {
  window.debuggerEngine = {
    DebuggerError,
    MAX_STEPS,
    SUPPORTED,
    REFUSED,
    analyse,
    instrument,
    renderValue,
    prepare
  };
}
