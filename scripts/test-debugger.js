/* ------------------------ scripts / test-debugger ----------------------- */
/* The interactive debugger. Usage:
     npm run test:debugger

   The standard for this one is higher than the other suites, because a debugger
   that reports a trace which is subtly wrong teaches a wrong model of what code
   does - and a wrong trace looks exactly like a right one while you are reading
   it.

   So the tests here are mostly comparisons against JavaScript's own answers:
   the debugger's final output is compared with what `eval` produces for the same
   snippet, and its final variable values with what the snippet actually leaves
   behind. Where the debugger's output and the language's disagree, one of them
   is wrong, and these tests will say so.

   Refusal matters just as much. Anything the instrumenter cannot handle must be
   turned away before a single step is taken, rather than executed approximately. */

/* eslint-disable no-new-func */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const dbg = require("../debugger");

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

/* Runs a snippet to completion through the debugger, driving it in single steps
   exactly as the page's step button would. Returns the final state. */
const runToEnd = (source, options = {}) => {
  const { analysed, printed, session } = dbg.prepare(source, options);
  let guard = 0;
  const ceiling = (options.maxSteps || dbg.MAX_STEPS) + 10;
  while (!session.state.finished && guard++ < ceiling) session.advance();
  return { analysed, printed, session, state: session.state };
};

/* What the language itself says, with no debugger involved. This is the
   reference every trace is checked against. */
const nativeRun = (source) => {
  const output = [];
  const shim = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    shim[level] = (...args) => output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function("console", source)(shim);
    return { output, error: null };
  } catch (error) {
    return { output, error };
  }
};

const varAt = (state, name) => {
  const frame = state.current || state.steps[state.steps.length - 1];
  if (!frame) return undefined;
  const row = frame.variables.find((v) => v.name === name);
  return row ? row.display : undefined;
};

/* ============================== rendering =============================== */

console.log("\n== rendering values ==");
check("null", dbg.renderValue(null).text === "null");
check("undefined", dbg.renderValue(undefined).text === "undefined");
check("a number", dbg.renderValue(42).text === "42");
check("NaN is not 'NaN the number'", dbg.renderValue(NaN).text === "NaN");
check("Infinity", dbg.renderValue(Infinity).text === "Infinity");
check("-0 is shown as -0, because it is not 0", dbg.renderValue(-0).text === "-0", dbg.renderValue(-0).text);
check("a string is quoted", dbg.renderValue("hi").text === '"hi"');
check("a boolean", dbg.renderValue(true).text === "true");
check("a bigint keeps its suffix", dbg.renderValue(10n).text === "10n");
check("a named function", dbg.renderValue(function add() {}).text === "ƒ add()", dbg.renderValue(function add() {}).text);
check("an anonymous function", dbg.renderValue(() => {}).text === "ƒ anonymous()");
check("an array", dbg.renderValue([1, "a", true]).text === '[1, "a", true]', dbg.renderValue([1, "a", true]).text);
check("a nested array", dbg.renderValue([[1], [2]]).text === "[[1], [2]]");
check("an empty array", dbg.renderValue([]).text === "[]");
check("an object", dbg.renderValue({ a: 1, b: "x" }).text === '{a: 1, b: "x"}', dbg.renderValue({ a: 1, b: "x" }).text);
check("a class instance is named", dbg.renderValue(new Map()).text.startsWith("Map(0)"), dbg.renderValue(new Map()).text);
/* String keys are quoted here exactly as object keys are, so a Map entry and
   an object property read the same way in the panel. */
check("a Map", dbg.renderValue(new Map([["k", 1]])).text === 'Map(1) {"k" => 1}', dbg.renderValue(new Map([["k", 1]])).text);
check("a Set", dbg.renderValue(new Set([1, 2])).text === "Set(2) {1, 2}", dbg.renderValue(new Set([1, 2])).text);
check("a Date", dbg.renderValue(new Date(0)).text === "1970-01-01T00:00:00.000Z");
check("a RegExp", dbg.renderValue(/ab+/g).text === "/ab+/g");
check("an Error", dbg.renderValue(new TypeError("bad")).text === "TypeError: bad");

console.log("\n== rendering survives what it is asked to render ==");
const cyclic = { name: "loop" };
cyclic.self = cyclic;
check("a cycle is reported, not followed", dbg.renderValue(cyclic).text === '{name: "loop", self: [circular]}', dbg.renderValue(cyclic).text);
const arrayCycle = [1];
arrayCycle.push(arrayCycle);
check("an array cycle too", dbg.renderValue(arrayCycle).text === "[1, [circular]]", dbg.renderValue(arrayCycle).text);
const deep = { a: { b: { c: { d: { e: 1 } } } } };
check("depth is bounded rather than followed forever", dbg.renderValue(deep).text.includes("{…}"), dbg.renderValue(deep).text);
const wide = Array.from({ length: 500 }, (_, i) => i);
check("a long array is truncated with a count", dbg.renderValue(wide).text.includes("… 440 more"), dbg.renderValue(wide).text.slice(-20));
check("and the true length is still reported", dbg.renderValue(wide).length === 500);
const wideObject = {};
for (let i = 0; i < 300; i += 1) wideObject[`k${i}`] = i;
check("a wide object is truncated too", dbg.renderValue(wideObject).text.includes("more"));
const longString = "x".repeat(5000);
check("a long string is truncated and its real length stated", dbg.renderValue(longString).text.includes("(5000 chars)"));
const throwing = { get boom() { throw new Error("no"); } };
check("a throwing getter does not take the dump down", (() => { try { dbg.renderValue(throwing); return true; } catch { return false; } })());
check("a throwing getter is labelled", dbg.renderValue(throwing).text.includes("could not read"), dbg.renderValue(throwing).text);

/* ============================== refusal ================================= */

console.log("\n== what it refuses, and why ==");
const refuses = (source, pattern) => {
  try {
    dbg.prepare(source);
    return { refused: false };
  } catch (error) {
    return { refused: error instanceof dbg.DebuggerError, message: error.message, line: error.line, error };
  }
};

check("empty input is refused", refuses("").refused && /no code/i.test(refuses("").message));
check("a syntax error is refused", refuses("let = ;").refused && /not valid JavaScript/i.test(refuses("let = ;").message));
check("and the parser's own position is kept", refuses("let = ;").line === 1, String(refuses("let = ;").line));
check("an unclosed brace is refused", refuses("function f() {").refused);

const classRefusal = refuses("class A { constructor() { this.x = 1; } }");
check("a class is refused", classRefusal.refused);
check("and it names the construct", /class declaration/.test(classRefusal.message), classRefusal.message);
check("and gives the line", classRefusal.line === 1, String(classRefusal.line));

check("async is refused", refuses("async function f(){ await g(); }").refused && /await/.test(refuses("async function f(){ await g(); }").message));
check("a generator is refused", refuses("function* g(){ yield 1; }").refused && /yield/.test(refuses("function* g(){ yield 1; }").message));
check("an import is refused", refuses("import x from 'y';").refused && /import/.test(refuses("import x from 'y';").message));
check("an export is refused", refuses("export const a = 1;").refused);
check("with is refused", refuses("with (o) { a; }").refused);
check("a labelled statement is refused", refuses("outer: for(;;){ break outer; }").refused);
check("the refusal names the line it was refused at", refuses("let a = 1;\nlet b = 2;\nclass C {}").line === 3, String(refuses("let a = 1;\nlet b = 2;\nclass C {}").line));
check("a refusal happens before anything runs", (() => { let ran = false; try { dbg.prepare(`globalThis.__ran = 1; class C {}`); } catch { /* expected */ } ran = Boolean(globalThis.__ran); delete globalThis.__ran; return ran === false; })());

/* ============================== analysis ================================ */

console.log("\n== what it notices about the source ==");
const analysed = dbg.analyse("let a = 1;\nconst b = 2;\nfunction f(x, y) { return x + y; }");
check("variables are found", analysed.names.includes("a") && analysed.names.includes("b"), JSON.stringify(analysed.names));
check("parameters are found", analysed.names.includes("x") && analysed.names.includes("y"), JSON.stringify(analysed.names));
check("a function's own name is found", analysed.names.includes("f"));
check("functions are identified as steppable", analysed.functions.has("f"));
check("statements are counted", analysed.statementCount === 4, String(analysed.statementCount));
check("lines are real, not null", analysed.ast.body[1].loc.start.line === 2, String(analysed.ast.body[1].loc.start.line));
check("destructuring names are found", dbg.analyse("const { a, b: c } = o;").names.includes("a") && dbg.analyse("const { a, b: c } = o;").names.includes("c"), JSON.stringify(dbg.analyse("const { a, b: c } = o;").names));
check("array destructuring too", dbg.analyse("const [p, q] = pair;").names.includes("p") && dbg.analyse("const [p, q] = pair;").names.includes("q"));
check("default values too", dbg.analyse("const { z = 3 } = o;").names.includes("z"));
check("rest patterns too", dbg.analyse("const [first, ...others] = xs;").names.includes("others"), JSON.stringify(dbg.analyse("const [first, ...others] = xs;").names));
check("a catch parameter is found", dbg.analyse("try { x(); } catch (err) { }").names.includes("err"), JSON.stringify(dbg.analyse("try { x(); } catch (err) { }").names));
check("names are deduplicated", (() => { const n = dbg.analyse("let a = 1; let a2 = 2; function f(a){}").names; return new Set(n).size === n.length; })());

/* ============================ stepping ================================== */

console.log("\n== stepping through a loop ==");
const LOOP = "let total = 0;\nfor (let i = 1; i <= 3; i++) {\n  total += i;\n}\nconsole.log(total);";
const loopRun = runToEnd(LOOP);
check("it ran to the end", loopRun.state.finished && !loopRun.state.error, JSON.stringify(loopRun.state.error));
check("the lines visited are the lines written", [...new Set(loopRun.state.steps.map((f) => f.line))].join(",") === "1,2,3,5", [...new Set(loopRun.state.steps.map((f) => f.line))].join(","));
check("the loop body is visited once per pass", loopRun.state.steps.filter((f) => f.line === 3).length === 3, String(loopRun.state.steps.filter((f) => f.line === 3).length));
check("the iteration counter counts passes", loopRun.state.steps.filter((f) => f.line === 3).map((f) => f.iteration).join(",") === "1,2,3");
/* Before its declaration runs, a `let` binding is in its temporal dead zone.
   Direct eval of it throws ReferenceError, exactly as any other use would, so
   the debugger says "not in scope here" rather than inventing an undefined
   value. Reporting `undefined` would be a small lie: the variable is not
   undefined, it does not exist yet. */
check("a variable before its declaration is reported as not yet available, not as undefined", varAt({ current: loopRun.state.steps[0] }, "total") === "not in scope here", varAt({ current: loopRun.state.steps[0] }, "total"));
check("and holds its value on the next line", varAt({ current: loopRun.state.steps[1] }, "total") === "0");
check("a loop counter is visible inside the loop", varAt({ current: loopRun.state.steps[2] }, "i") === "1", varAt({ current: loopRun.state.steps[2] }, "i"));
check("and is gone again after it", varAt(loopRun.state, "i") === "not in scope here", varAt(loopRun.state, "i"));
check("the output matches what the language produces", loopRun.state.output.map((o) => o.text).join() === nativeRun(LOOP).output.join(), `${loopRun.state.output.map((o) => o.text).join()} vs ${nativeRun(LOOP).output.join()}`);

console.log("\n== stepping into a function ==");
const FN = "function add(a, b) {\n  const sum = a + b;\n  return sum;\n}\nlet n = add(2, 3);\nconsole.log(n);";
const fnRun = runToEnd(FN);
check("it ran to the end", fnRun.state.finished && !fnRun.state.error, JSON.stringify(fnRun.state.error));
check("the body of the function is actually visited", fnRun.state.steps.some((f) => f.line === 2), JSON.stringify(fnRun.state.steps.map((f) => f.line)));
check("the call stack names the function", fnRun.state.steps.some((f) => f.stack.includes("add")));
check("the caller's variables are visible from inside", fnRun.state.steps.find((f) => f.stack.includes("add")).variables.some((v) => v.name === "n" && v.kind === "out-of-scope"));
check("the parameters hold the arguments passed", fnRun.state.steps.find((f) => f.stack.includes("add")).variables.find((v) => v.name === "a").display === "2");
check("the stack unwinds after the call", fnRun.state.steps[fnRun.state.steps.length - 1].stack.length === 1, fnRun.state.steps[fnRun.state.steps.length - 1].stack.join(">"));
check("the output matches the language's", fnRun.state.output.map((o) => o.text).join() === nativeRun(FN).output.join());

console.log("\n== recursion ==");
const REC = "function fact(n) {\n  if (n <= 1) return 1;\n  return n * fact(n - 1);\n}\nconsole.log(fact(4));";
const recRun = runToEnd(REC);
check("the stack grows with the recursion", Math.max(...recRun.state.steps.map((f) => f.stack.length)) === 5, String(Math.max(...recRun.state.steps.map((f) => f.stack.length))));
/* Line 2 holds both the `if` and its `return`, so it pauses twice on the
   last frame. Both pauses are real and both are wanted; the values are what is
   being checked, so the duplicate is collapsed. */
check("each frame sees its own n", [...new Set(recRun.state.steps.filter((f) => f.stack.length > 1 && f.line === 2).map((f) => varAt({ current: f }, "n")))].join(",") === "4,3,2,1", recRun.state.steps.filter((f) => f.stack.length > 1 && f.line === 2).map((f) => varAt({ current: f }, "n")).join(","));
check("the result is right", recRun.state.output.map((o) => o.text).join() === "24" && nativeRun(REC).output.join() === "24");

console.log("\n== closures see the real binding ==");
const CLOSURE = "let c = 0;\nfunction bump(){ c += 1; }\nbump();\nbump();\nconsole.log(c);";
const closureRun = runToEnd(CLOSURE);
/* Both calls, not just the first: the point of the check is that the
   function reads the live binding, so the first call sees 0 and the second
   sees 1. Checking only the first would pass for a debugger that snapshotted
   the value at declaration time. */
{
  const inside = closureRun.state.steps.filter((f) => f.stack.length === 2);
  check("an outer variable read inside a function updates between calls",
    inside.length === 2 && varAt({ current: inside[0] }, "c") === "0" && varAt({ current: inside[1] }, "c") === "1",
    inside.map((f) => varAt({ current: f }, "c")).join(" then "));
}
check("and the final value is right", closureRun.state.output.map((o) => o.text).join() === nativeRun(CLOSURE).output.join());

console.log("\n== every loop form ==");
const forms = [
  ["for", "let s = 0;\nfor (let i = 0; i < 3; i++) { s += i; }\nconsole.log(s);"],
  ["for-of", "const xs = [1,2,3];\nlet s = 0;\nfor (const x of xs) { s += x; }\nconsole.log(s);"],
  ["for-in", "let s = 0;\nfor (const k in {a:1,b:2}) { s += 1; }\nconsole.log(s);"],
  ["while", "let i = 0;\nlet s = 0;\nwhile (i < 3) { s += i; i++; }\nconsole.log(s);"],
  ["do-while", "let i = 0;\nlet s = 0;\ndo { s += i; i++; } while (i < 3);\nconsole.log(s);"]
];
for (const [name, source] of forms) {
  const result = runToEnd(source);
  const expected = nativeRun(source).output.join();
  const got = result.state.output.map((o) => o.text).join();
  check(`a ${name} loop produces the same answer as plain JavaScript`, got === expected && result.state.finished && !result.state.error, `${got} vs ${expected}${result.state.error ? ` [${result.state.error.message}]` : ""}`);
}

console.log("\n== the shapes real snippets are written in ==");
const shapes = [
  ["an unbraced if body", "let n = 0;\nif (1 > 0) n = 5;\nconsole.log(n);"],
  ["an unbraced loop body", "let n = 0;\nfor (let i = 0; i < 3; i++) n += 1;\nconsole.log(n);"],
  ["an else branch", "let n = 5;\nif (n > 10) { n = 1; } else { n = 2; }\nconsole.log(n);"],
  ["else if", "let n = 5;\nif (n > 10) { n = 1; } else if (n > 3) { n = 2; } else { n = 3; }\nconsole.log(n);"],
  ["break out of a loop", "let i = 0;\nwhile (true) { i += 1; if (i > 3) break; }\nconsole.log(i);"],
  ["continue in a loop", "let s = 0;\nfor (let i = 0; i < 5; i++) { if (i % 2 === 0) continue; s += i; }\nconsole.log(s);"],
  ["a switch", "let n = 2;\nlet out = '';\nswitch (n) { case 1: out = 'one'; break; case 2: out = 'two'; break; default: out = 'many'; }\nconsole.log(out);"],
  ["try/catch/finally", "let out = '';\ntry { throw new Error('x'); } catch (e) { out = e.message; } finally { out += '!'; }\nconsole.log(out);"],
  ["destructuring", "const { a, b } = { a: 1, b: 2 };\nconst [p, q] = [3, 4];\nconsole.log(a + b + p + q);"],
  ["default parameters", "function f(x, y = 10) { return x + y; }\nconsole.log(f(1));"],
  ["a rest parameter", "function f(...xs) { return xs.length; }\nconsole.log(f(1, 2, 3));"],
  ["template literals", "const n = 4;\nconsole.log(`n is ${n} and ${n * 2} is double`);"],
  ["an arrow function", "const f = (a, b) => a + b;\nconsole.log(f(1, 2));"],
  ["a concise arrow body", "const double = (n) => n * 2;\nconsole.log(double(4));"],
  ["array methods", "const xs = [3, 1, 2];\nconsole.log(xs.sort().join('-'));"],
  ["object methods", "const o = { n: 2, double() { return this.n * 2; } };\nconsole.log(o.double());"],
  ["optional chaining", "const o = null;\nconsole.log(o?.n ?? 'none');"],
  ["nullish coalescing", "const n = 0;\nconsole.log(n ?? 7);"],
  ["nested ternary", "const n = 5;\nconsole.log(n > 3 ? 'big' : 'small');"],
  ["a composed expression", "let a = 2, b = 3, c = 4;\nconsole.log(a + b * c - a / b);"],
  ["string methods", "console.log('  hi  '.trim().toUpperCase());"],
  ["Math", "console.log(Math.max(1, 5, 3));"],
  ["a postfix in an expression keeps its value", "let a = 1;\nconsole.log(a++, a);"],
  ["a prefix in an expression keeps its value", "let a = 1;\nconsole.log(++a, a);"],
  ["compound assignment", "let n = 10;\nn /= 4;\nn **= 2;\nconsole.log(n);"],
  ["an assignment as an expression", "let a, b;\nconsole.log(a = 3, b = 4, a + b);"],
  ["comma in a for", "let s = 0;\nfor (let i = 0, j = 5; i < j; i++, j--) { s += i; }\nconsole.log(s);"],
  ["a named function expression", "const f = function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); };\nconsole.log(f(4));"],
  ["new", "function P(n) { this.n = n; }\nconsole.log(new P(3).n);"]
];
for (const [name, source] of shapes) {
  /* Each shape is isolated. Without this, one snippet the instrumenter refuses
     would abort the run and every shape after it would go unchecked - which is
     exactly how a gap in the supported syntax went unnoticed for several
     iterations while a later case was reported as the failure. */
  try {
    const result = runToEnd(source);
    const expected = nativeRun(source).output.join();
    const got = result.state.output.map((o) => o.text).join();
    check(name, got === expected && result.state.finished && !result.state.error,
      got === expected ? "" : `${got || "(nothing)"} vs ${expected || "(nothing)"}${result.state.error ? ` [${result.state.error.message}]` : ""}`);
  } catch (error) {
    check(name, false, `refused: ${error.message}${error.line ? ` (line ${error.line})` : ""}`);
  }
}

console.log("\n== postfix and prefix really do differ ==");
const incTest = runToEnd("let a = 1;\nlet b = a++;\nlet c = ++a;\nconsole.log(a, b, c);");
check("the debugger's values match the language's", incTest.state.output.map((o) => o.text).join() === "3 1 3", incTest.state.output.map((o) => o.text).join());
check("and so do the variables at the end", `${varAt(incTest.state, "a")} ${varAt(incTest.state, "b")} ${varAt(incTest.state, "c")}` === "3 1 3");

console.log("\n== the value panel shows what the code really did ==");
const mutation = runToEnd("const xs = [1];\nconst o = { a: 1 };\nxs.push(4);\no.b = 2;");
check("an array mutation is visible", varAt(mutation.state, "xs") === "[1, 4]", varAt(mutation.state, "xs"));
check("an object mutation is visible", varAt(mutation.state, "o") === "{a: 1, b: 2}", varAt(mutation.state, "o"));

/* =========================== running safely ============================= */

console.log("\n== an infinite loop is stopped, not hung ==");
const infinite = runToEnd("let x = 0;\nwhile (true) { x += 1; }", { maxSteps: 25 });
check("it stops at the cap", infinite.state.finished && infinite.state.capped);
check("and the step count is exactly the cap, not over", infinite.state.stepCount <= 25);
check("and it is not reported as an error in the code", infinite.state.error === null, JSON.stringify(infinite.state.error));
check("exactly the cap's worth of steps were taken", infinite.state.stepCount === 25, String(infinite.state.stepCount));
check("the last frame is still readable", Boolean(infinite.state.current));

console.log("\n== a runtime error is reported, not swallowed ==");
const boom = runToEnd("let a = null;\nconsole.log(a.x);");
check("the error is captured", Boolean(boom.state.error));
check("it is the real error", /Cannot read properties of null/.test(boom.state.error.message), boom.state.error.message);
check("its name is kept", boom.state.error.name === "TypeError", boom.state.error.name);
check("the position it happened at is kept", boom.state.error.line === 2, String(boom.state.error.line));
check("and the run is marked finished", boom.state.finished);

console.log("\n== a thrown error is the reader's, not a debugger failure ==");
const thrown = runToEnd("throw new Error('deliberate');");
check("a thrown error surfaces", /deliberate/.test(thrown.state.error?.message || ""), thrown.state.error?.message);
check("and is not confused with a parse failure", thrown.state.error.name === "Error");

console.log("\n== an infinite recursion is stopped too ==");
const deepRecursion = runToEnd("function f(n){ return f(n + 1); }\nf(0);", { maxSteps: 30 });
check("it stops rather than blowing the stack", deepRecursion.state.finished);
check("and says it was capped or errored, not silently wrong", deepRecursion.state.capped || Boolean(deepRecursion.state.error));

/* ============================ breakpoints =============================== */

console.log("\n== breakpoints ==");
const bpSource = "let n = 0;\nfor (let i = 0; i < 4; i++) {\n  n += i;\n}\nconsole.log(n);";
{
  const { session } = dbg.prepare(bpSource);
  session.advance();
  session.runTo(new Set([3]));
  check("continuing stops on the chosen line", session.current?.line === 3, String(session.current?.line));
  check("and it has actually made progress", session.state.stepCount > 1, String(session.state.stepCount));

  /* Stopping again on the same line is correct - the loop body runs four
     times and every pass is a real pause. What must not happen is reporting
     the identical frame twice, so the iteration counter is the thing to
     compare. */
  const before = session.current?.iteration;
  session.runTo(new Set([3]));
  check("continuing from a breakpoint advances the loop rather than repeating the frame",
    session.current?.line !== 3 || session.state.finished || session.current?.iteration !== before,
    `line ${session.current?.line} iteration ${before} -> ${session.current?.iteration}`);
}
{
  const { session } = dbg.prepare(bpSource);
  session.runToEnd();
  check("running with no breakpoints runs to the end", session.state.finished && session.state.stepCount >= 6, String(session.state.stepCount));
}
{
  const { session } = dbg.prepare(bpSource);
  session.advance();
  session.runTo(new Set([99]));
  check("a breakpoint on a line never reached runs to the end", session.state.finished);
}
{
  const { session } = dbg.prepare(bpSource);
  session.advance();
  session.runTo(new Set([1]));
  check("a breakpoint on an earlier line is not re-entered", session.current?.line !== 1 || session.state.finished, String(session.current?.line));
}

/* ============================== console ================================= */

console.log("\n== console output is captured, not printed ==");
const logged = runToEnd("console.log('a', 1);\nconsole.warn('b');\nconsole.error('c');");
check("every level is captured", logged.state.output.map((o) => o.level).join(",") === "log,warn,error", logged.state.output.map((o) => o.level).join(","));
check("arguments are joined the way the console joins them", logged.state.output[0].text === "a 1", logged.state.output[0].text);
check("a non-string argument is rendered, not [object Object]", runToEnd("console.log({a:1});").state.output[0].text === "{a: 1}");
check("output from inside a function is captured too", runToEnd("function f(){ console.log('in'); }\nf();").state.output.map((o) => o.text).join() === "in");

/* ============================== output ================================== */

console.log("\n== the generated source is honest ==");
{
  const { printed } = dbg.prepare(LOOP);
  check("every pause is a yield, or nothing would stop", (printed.source.match(/yield __q\.step\(/g) || []).length === printed.steps.length, `${(printed.source.match(/yield __q\.step\(/g) || []).length} yields for ${printed.steps.length} steps`);
  check("the snapshot uses literal eval, not a variable", /eval\("i"\)/.test(printed.source));
  check("no indirect eval slipped in", !/eval\([A-Za-z_$][\w$]*\)/.test(printed.source), (printed.source.match(/eval\([^"]*\)/g) || []).slice(0, 3).join(" "));
  check("user functions become generators", /function\* add\(/.test(printed.source) || /function\* f\(/.test(dbg.prepare("function f(){}").printed.source));
  check("calls to them become yield*", /yield\* add\(/.test(dbg.prepare("function add(a){return a;}\nadd(1);").printed.source));
  /* The snippet increments with `i++`, and the printed form must keep the
   postfix. Collapsing the two would change the value of any expression using
   the result - `console.log(i++, i)` prints 1 2, and `console.log(++i, i)`
   prints 2 2. */
check("a postfix increment stays postfix in the generated source", /; \(i\+\+\)\)/.test(printed.source), (printed.source.match(/for \([^)]*\)[^\n]*/) || [""])[0]);
check("a prefix increment stays prefix too", /; \(\+\+k\)\)/.test(dbg.prepare("for (let k = 0; k < 2; ++k) {}").printed.source), (dbg.prepare("for (let k = 0; k < 2; ++k) {}").printed.source.match(/for \([^)]*\)[^\n]*/) || [""])[0]);
  check("step lines come from the original source, not the generated one", printed.steps.every((s) => s.line !== null));
}

/* ======================= what runs as one step ========================== */

console.log("\n== the final state is visible ==");
{
  /* Every pause sits before its statement, so the effect of the LAST statement
     happens after the last ordinary frame. Without a closing frame the panel
     would still show the state from before the answer was computed - which is
     the state nobody wants to see. */
  const last = runToEnd("let n = 1;\nn = n * 21;");
  const tail = last.state.steps[last.state.steps.length - 1];
  check("a closing frame is taken", tail.finished === true, JSON.stringify({ line: tail.line, finished: tail.finished }));
  check("it shows the value the program actually ended with", varAt({ current: tail }, "n") === "21", varAt({ current: tail }, "n"));
  check("and it is the frame on screen when the run ends", last.state.current?.finished === true);
  check("the ordinary frames are not marked finished", last.state.steps.filter((f) => f.finished).length === 1);
}

console.log("\n== functions Quanta cannot step into still work ==");
{
  /* Object methods and constructors are not rewritten as generators, because a
     generator is neither a constructor nor something a call site resumes
     without `yield*`. Rewriting them anyway would make the snippet throw, or
     silently return a generator object instead of its result. */
  const objRun = runToEnd("const o = { n: 2, double() { return this.n * 2; } };\nconsole.log(o.double());");
  check("an object method returns its real value", objRun.state.output.map((o) => o.text).join() === "4", objRun.state.output.map((o) => o.text).join());
  check("no yield is emitted inside it", !/double\(\)\s*\{[^}]*yield/.test(dbg.prepare("const o = { double() { return 1; } };").printed.source));

  const ctorSrc = "function P(n) { this.n = n; }\nconsole.log(new P(3).n);";
  check("a constructor still works", runToEnd(ctorSrc).state.output.map((o) => o.text).join() === "3");
  const ctorPrinted = dbg.prepare("function P(n){ this.n = n; }\nnew P(1);").printed.source;
  check("a constructor is not turned into a generator", /function P\(/.test(ctorPrinted) && !/function\* P\(/.test(ctorPrinted));
  check("and the limitation is reported rather than hidden", dbg.analyse("function P(n){ this.n = n; }\nnew P(1);").warnings.some((w) => /new/.test(w)), JSON.stringify(dbg.analyse("function P(n){ this.n = n; }\nnew P(1);").warnings));

  check("a callback passed to a library method returns its real value",
    runToEnd("const xs = [1, 2];\nconsole.log(xs.map(n => n * 10).join(','));").state.output.map((o) => o.text).join() === "10,20");

  const arrowSrc = "const f = n => n * 2;\nconsole.log(f(3));";
  const steppable = dbg.prepare(arrowSrc);
  /* An arrow has no name of its own, so the generated function is anonymous.
     What matters is that it IS a generator and that the call site yields into
     it - and that the stack names it, which comes from the binding. */
  check("a function bound to a name IS a generator, so it can be entered", /function\* \(n\)/.test(steppable.printed.source), (steppable.printed.source.match(/function\*[^\n]*/) || [""])[0]);
  check("and its call site yields into it", /yield\* f\(/.test(steppable.printed.source));
  check("and stepping reaches its body", runToEnd(arrowSrc).state.steps.some((f) => f.line === 1));
  /* A concise arrow has no statement inside it to pause on, so the stack can
     never show it - there is genuinely nothing to step into. A block body does
     have one, and that is where the name has to appear. */
  const blockSrc = "const f = function (n) {\n  return n * 2;\n};\nconsole.log(f(3));";
  check("the stack names the binding a function expression was stored under",
    runToEnd(blockSrc).state.steps.some((f) => f.stack.includes("f")),
    JSON.stringify(runToEnd(blockSrc).state.steps.map((f) => f.stack.join(">"))));
  check("and it unwinds again after the call",
    runToEnd(blockSrc).state.steps[runToEnd(blockSrc).state.steps.length - 1].stack.length === 1);

  check("a self-recursive named function expression computes the right answer",
    runToEnd("const f = function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); };\nconsole.log(f(4));").state.output.map((o) => o.text).join() === "24");
}

console.log("\n== optional chaining survives the rewrite ==");
{
  const printed = dbg.prepare("const o = null;\nconsole.log(o?.n ?? 'none');").printed.source;
  check("the ?. survives into the generated source", /\?\./.test(printed), (printed.split("\n").find((l) => l.includes("?.")) || "").trim());
  check("and behaves the same as plain JavaScript",
    runToEnd("const o = null;\nconsole.log(o?.n ?? 'none');").state.output.map((o) => o.text).join() === "none");
  check("a chained optional access is not flattened into an unguarded one",
    runToEnd("const o = { a: { b: 2 } };\nconsole.log(o?.a?.b);").state.output.map((o) => o.text).join() === "2");
}

/* ==================== regressions, kept deliberately ================== */

console.log("\n== a bare else must not swallow the statement after it ==");
{
  /* The pause is injected as its own statement. Emitted as
     `else <pause>; hi = mid - 1;`, the else binds to the pause alone, so the
     assignment runs on every pass instead of only on the else branch.

     Nothing about that failure is visible from the outside: the snippet still
     parses, still runs, and still prints something. It just prints the wrong
     answer. Binary search returned -1 for 13, which is in the array, because
     the branch that was supposed to be skipped ran every time.

     These are here so the rewrite can never quietly start doing that again. */
  const binarySearch = `function search(xs, target) {
  let lo = 0;
  let hi = xs.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (xs[mid] === target) return mid;
    if (xs[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
console.log(search([1, 3, 5, 8, 13, 21], 13));
console.log(search([1, 3, 5, 8, 13, 21], 4));`;
  /* Each console.log is its own entry, so the two answers come back as a
     list rather than as one string. */
  const got = runToEnd(binarySearch).state.output.map((o) => o.text);
  check("binary search finds a value that is present", got[0] === "4", got.join(" | "));
  check("and reports -1 for one that is not", got[1] === "-1", got.join(" | "));
  /* Compared entry by entry. The rendered form of both sides looks
     identical in the failure message above, so a joined string was hiding the
     difference - the arrays are what actually have to match. */
  const expected = nativeRun(binarySearch).output;
  check(
    "it agrees with plain JavaScript, entry for entry",
    got.length === expected.length && got.every((value, i) => value === expected[i]),
    JSON.stringify({ got, expected })
  );

  const printed = dbg.prepare("let n = 5;\nif (n > 10) n = 1;\nelse n = 2;").printed.source;
  check("every else in the generated source is followed by a brace",
    !/else\s*(?!\{)(yield|const|let|[a-z])/.test(printed.replace(/else \{/g, "else {")), (printed.match(/else[^\n]{0,30}/g) || []).join(" | "));
}

console.log("\n== an error leaves the state it happened in on screen ==");
{
  const boom = runToEnd("let a = null;\nconsole.log(a.x);");
  check("the last frame survives the throw", Boolean(boom.state.current), JSON.stringify(boom.state.current));
  check("and still shows the value that caused it",
    boom.state.current.variables.some((v) => v.name === "a" && v.kind === "null"),
    JSON.stringify(boom.state.current?.variables?.filter((v) => v.present).map((v) => `${v.name}=${v.display}`)));
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
