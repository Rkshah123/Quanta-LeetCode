/* ================================ mock test ================================
 *
 * A mock test is three questions, drawn independently, of two kinds:
 *
 *   coding    - a problem from the catalog, answered with code, ten minutes each
 *   objective - a multiple-choice question, answered by choosing, no clock
 *
 * What this file is, and is not
 * -----------------------------
 * It is the logic: picking the questions, timing them, marking them, and
 * building the summary. All of that is pure and is tested in
 * scripts/test-mock-test.js.
 *
 * It is NOT a source of answers. Every question and every explanation here is
 * assembled from data the app already ships - the Academy quiz, the pattern
 * trainer, and the real problem catalog. Nothing is written by hand to pad the
 * bank, and where no real explanation exists the UI says so rather than
 * inventing one.
 *
 * Marking a coding answer
 * -----------------------
 * Quanta holds no hidden tests for a problem, so the only honest evidence
 * available is the problem's own worked examples. What that buys:
 *
 *   - run the submitted code on the app's existing runner, and report whether it
 *     compiled and whether it ran;
 *   - where the statement gives unambiguous worked examples, generate a harness
 *     in the same language that calls the submitted function with those exact
 *     arguments and compares each result with the stated expected output.
 *
 * The rules around the second step are strict on purpose. An example is used
 * only when the statement parses cleanly into named arguments and one literal
 * expected value. A harness that fails to build, or that produces no readable
 * result, yields no test row at all - and no row is never treated as a pass. So
 * a solution that passes every example it can be given is reported correct, one
 * that fails any is reported incorrect, and a problem with nothing checkable is
 * reported as unevaluated rather than guessed either way.
 */

/* The kinds of question a test can contain. */
const KIND = { CODING: "coding", OBJECTIVE: "objective" };

/* Ten minutes per coding question. Objective questions get no clock at all,
   which is why this is per kind and not a property of the test. */
const CODING_SECONDS = 600;

/* How many questions a test holds. */
const TEST_LENGTH = 3;

/* --------------------------------- timing -------------------------------- */

/* Seconds left for a question of this kind, or null when it is untimed.
   Returning null rather than a large number is what stops the clock being drawn
   for an objective question at all. */
const secondsFor = (kind) => (kind === KIND.CODING ? CODING_SECONDS : null);

/* "9:41" - the same shape as every other clock in the app. */
const clockText = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/* One tick. Returns the seconds now left, which is what makes the clock testable
   without a browser: expiry is a value, not a side effect. */
const tick = (seconds) => Math.max(0, (Number(seconds) || 0) - 1);

/* ------------------------------ question bank ----------------------------- */

/* Objective questions assembled from the Academy quiz.
 *
 * These are the app's own interview questions with their own written
 * explanations - nothing here is new. */
const fromAcademyQuiz = (quiz) =>
  (Array.isArray(quiz) ? quiz : [])
    .filter((q) => q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length >= 2)
    .map((q) => ({
      id: `quiz-${q.topic}-${q.question.slice(0, 24).replace(/\s+/g, "-").toLowerCase()}`,
      kind: KIND.OBJECTIVE,
      topic: q.topic,
      prompt: q.question,
      code: typeof q.code === "string" ? q.code : "",
      options: q.options.map(String),
      correctIndex: q.answer,
      /* The Academy's own wording works whether the reader is right or wrong,
         which is exactly what a result screen needs. */
      explanation: q.why || ""
    }));

/* Objective questions assembled from the pattern trainer.
 *
 * Each pattern describes the situation it applies to in its own words, and the
 * other patterns supply real alternatives. So the question, the options and the
 * answer are all things the app already teaches - the question is only the
 * arrangement of them. This exists because the Academy quiz alone holds seven
 * questions, which is not enough to keep three-question tests from repeating
 * themselves. */
const fromPatterns = (patterns) => {
  const list = Array.isArray(patterns) ? patterns.filter((p) => p && p.title && p.when) : [];
  return list.flatMap((pattern, index) => {
    /* Four options: the right one and three other real patterns. Which three is
       fixed per pattern so the same question does not shuffle between renders -
       a question whose options move is harder to answer deliberately. */
    const others = list.filter((p) => p.key !== pattern.key);
    const picked = [0, 1, 2].map((n) => others[(index * 3 + n * 5) % others.length]).filter(Boolean);
    const options = [pattern.title, ...picked.map((p) => p.title)];
    return [
      {
        id: `pattern-${pattern.key}`,
        kind: KIND.OBJECTIVE,
        topic: (pattern.topics && pattern.topics[0]) || "Patterns",
        prompt: `Which technique is this describing?\n\n${pattern.when}`,
        code: "",
        options,
        correctIndex: 0,
        explanation: [pattern.shape, ...(pattern.checklist || [])].filter(Boolean).join("\n\n"),
        source: "pattern"
      }
    ];
  });
};

/* Every objective question available, from both sources, de-duplicated by id. */
const buildObjectiveBank = ({ quiz = [], patterns = [] } = {}) => {
  const all = [...fromAcademyQuiz(quiz), ...fromPatterns(patterns)];
  const seen = new Set();
  return all.filter((q) => {
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.options.length) return false;
    if (seen.has(q.id)) return false;
    seen.add(q.id);
    return true;
  });
};

/* ------------------------------ explanation ------------------------------ */

/* The pattern that matches a coding problem, if any.
   Matched on the problem's own topics, so a Binary Search problem is explained
   with the binary-search pattern and not with whichever one happens to be first
   in the list. */
const patternFor = (problem, patterns) => {
  const list = Array.isArray(patterns) ? patterns : [];
  const topics = Array.isArray(problem?.topics) ? problem.topics.map((t) => String(t).toLowerCase()) : [];
  if (!topics.length || !list.length) return null;
  const score = (pattern) => {
    const keys = [pattern.key, pattern.title, ...(pattern.topics || [])].map((t) => String(t).toLowerCase());
    return keys.reduce((sum, key) => sum + (key && topics.some((topic) => topic.includes(key) || key.includes(topic)) ? 1 : 0), 0);
  };
  const ranked = list.map((p) => ({ p, n: score(p) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  return ranked.length ? ranked[0].p : null;
};

/* The teaching content for a coding problem's answer.

   IMPORTANT, and said here as plainly as it can be: this is the PATTERN's
   skeleton - how this class of problem is solved - not a verified optimal
   solution to this specific problem. Quanta stores no reference solutions, so
   presenting a pattern skeleton as "the optimal solution" would be a claim the
   app cannot back up. The UI labels it for what it is. */
const explanationFor = (problem, patterns) => {
  const pattern = patternFor(problem, patterns);
  if (!pattern) {
    return {
      pattern: null,
      approach: "",
      /* An honest gap beats an invented answer. */
      note: "Quanta has no worked explanation stored for this problem yet, so it is not going to invent one. The code you submitted was still run - see above."
    };
  }
  return {
    pattern,
    approach: pattern.skeleton || "",
    when: pattern.when || "",
    shape: pattern.shape || "",
    checklist: pattern.checklist || [],
    note: `This is the ${pattern.title} approach - how this class of problem is solved - not a verified reference solution for this problem. Quanta stores no hidden tests and no stored solutions, so it will not claim one.`
  };
};

/* ------------------------------- selection ------------------------------- */

/* A small deterministic generator, so a seed always yields the same test.
   Date.now() as the seed would reshuffle on every render, which is how a
   reader ends up re-reading the same question thirty seconds later. */
const seededRandom = (seed) => {
  let state = Math.abs(Math.trunc(Number(seed) || 0)) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};

const pickFrom = (list, random) => list[Math.floor(random() * list.length) % list.length];

/* Builds one three-question test.
 *
 * Each question is chosen independently and no question appears twice in the
 * same test. The mix is deliberate rather than pure chance: a test that is three
 * coding problems never exercises anything else, and one that is three multiple
 * choice questions is not an interview. So the first is drawn from one side and
 * the second from the other, and the third is free.
 *
 * Shortfalls are handled by using what exists rather than by repeating: if only
 * two coding problems are available, the test is smaller, because a longer test
 * with the same question twice is worse than a shorter honest one. */
const buildTest = ({ coding = [], objective = [], seed = 0 } = {}) => {
  const random = seededRandom(seed);
  const usedIds = new Set();
  const questions = [];

  const take = (kind, pool) => {
    const available = pool.filter((q) => q && q.id && !usedIds.has(q.id));
    if (!available.length) return null;
    const chosen = pickFrom(available, random);
    usedIds.add(chosen.id);
    /* Stamped rather than assumed. The pools are built elsewhere - the catalog
       and the objective bank - and neither carries a `kind` field, so a test
       came back with questions that had no type on them at all. Everything
       downstream branches on this, so it is set here where the test is built. */
    questions.push({ ...chosen, kind, source: chosen.source || (kind === KIND.CODING ? "catalog" : "bank") });
    return chosen;
  };

  /* Coding first, then objective, then whichever is left. The order alternates
     with the seed so two consecutive tests do not always read the same way. */
  const codingFirst = random() < 0.5;
  const first = codingFirst ? KIND.CODING : KIND.OBJECTIVE;
  const second = codingFirst ? KIND.OBJECTIVE : KIND.CODING;

  take(first, first === KIND.CODING ? coding : objective);
  take(second, second === KIND.CODING ? coding : objective);
  take(codingFirst ? KIND.CODING : KIND.OBJECTIVE, codingFirst ? coding : objective);

  return questions.slice(0, TEST_LENGTH);
};

/* --------------------------------- marking -------------------------------
 *
 * What a coding answer may be called, and what evidence each verdict needs.
 *
 * The rule that shapes all of this: an answer is never called correct without
 * a test it actually passed. Running cleanly is not passing. Compiling is not
 * passing. So the verdicts are separated by what was observed, and the one
 * that says "could not check" is a first-class answer rather than a fallback
 * hidden behind a green tick.
 *
 *   compile-error  did not build                          -> evidence: the compiler
 *   runtime-error  built, then threw or timed out          -> evidence: the run
 *   wrong          built, ran, and disagreed with a test  -> evidence: the diff
 *   correct        built, ran, and passed every test      -> evidence: every test
 *   unverified     built and ran, but there was no test   -> evidence: none, said so
 *   unanswered     nothing was submitted
 */
const VERDICT = {
  CORRECT: "correct",
  WRONG: "wrong",
  COMPILE_ERROR: "compile-error",
  RUNTIME_ERROR: "runtime-error",
  UNVERIFIED: "unverified",
  UNANSWERED: "unanswered"
};

/* The words shown to the reader. Kept here rather than in the UI so that the
   test screen, the results screen and the review panel cannot drift apart and
   start calling the same thing three different things. */
const VERDICT_LABEL = {
  [VERDICT.CORRECT]: "Correct Answer",
  [VERDICT.WRONG]: "Incorrect Answer",
  [VERDICT.COMPILE_ERROR]: "Did not compile",
  [VERDICT.RUNTIME_ERROR]: "Runtime error",
  [VERDICT.UNVERIFIED]: "Unable to evaluate automatically",
  [VERDICT.UNANSWERED]: "Not answered"
};

/* One status colour per verdict, so a card can be styled from the verdict alone
   and the same mapping serves the question screen and the results screen. */
const VERDICT_TONE = {
  [VERDICT.CORRECT]: "correct",
  [VERDICT.WRONG]: "wrong",
  [VERDICT.COMPILE_ERROR]: "error",
  [VERDICT.RUNTIME_ERROR]: "error",
  [VERDICT.UNVERIFIED]: "unknown",
  [VERDICT.UNANSWERED]: "unanswered"
};

/* Is this worth submitting?

   The rule the reader asked for, stated once so the button, the timer and the
   expiry path cannot disagree about it: a coding answer needs at least one
   character that is not whitespace. Spaces, tabs and blank lines are not an
   attempt, and letting them through produces a pointless "did not compile" on
   an editor nobody typed in. */
const hasCode = (code) => typeof code === "string" && /\S/.test(code);

/* Marks a coding answer from what the runner actually reported.
 *
 * `tests` is the list the panel really ran: each entry already carries what was
 * expected and what came back. An empty list is not a pass, it is the absence of
 * evidence, and it is reported as such. */
const markCoding = ({ compiled = true, ran = true, stdout = "", stderr = "", timedOut = false, tests = [], code = "" } = {}) => {
  const ranTests = Array.isArray(tests) ? tests : [];
  const passed = ranTests.filter((t) => t && t.passed === true);
  const failed = ranTests.filter((t) => t && t.passed === false);

  let verdict;
  let detail;

  if (!compiled) {
    verdict = VERDICT.COMPILE_ERROR;
    detail = "The code did not compile, so it cannot be a solution.";
  } else if (timedOut) {
    verdict = VERDICT.RUNTIME_ERROR;
    detail = "The code compiled but did not finish in time.";
  } else if (!ran) {
    verdict = VERDICT.RUNTIME_ERROR;
    detail = "The code compiled but failed while running.";
  } else if (failed.length) {
    /* Only reachable when at least one test really ran and really disagreed. */
    verdict = VERDICT.WRONG;
    detail = failed.length === 1
      ? "It ran, but did not match the problem's own worked example. The test that failed is shown below."
      : `It ran, but did not match the problem's own worked examples. ${failed.length} of ${ranTests.length} failed.`;
  } else if (ranTests.length) {
    verdict = VERDICT.CORRECT;
    detail = ranTests.length === 1
      ? "It produced the stated result for the problem's own worked example."
      : `It produced the stated result for all ${ranTests.length} of the problem's own worked examples.`;
  } else {
    verdict = VERDICT.UNVERIFIED;
    detail =
      "The code compiled and ran. Quanta holds no hidden tests for this problem, and this statement does not give a worked example that can be run automatically, so the answer cannot be marked right or wrong.";
  }

  return {
    kind: KIND.CODING,
    correct: verdict === VERDICT.CORRECT,
    /* "Answered" means an attempt was made. A wrong attempt is answered; an
       empty editor or a missed clock is not. The results screen counts these
       separately, so the distinction has to survive this far. */
    answered: hasCode(code),
    verdict,
    tone: VERDICT_TONE[verdict],
    label: VERDICT_LABEL[verdict],
    detail,
    /* The submitted code, carried through with the mark. Review reads it from
       here, so if the mark does not hold it the reader cannot see what they
       actually sent - which is the one thing a results screen has to be able to
       show. */
    code,
    stdout,
    stderr,
    tests: ranTests,
    tested: ranTests.length,
    passed: passed.length
  };
};

/* Marks a multiple-choice answer by comparing the chosen index with the stored
   correct index. There is no room for generosity here: the comparison is the
   whole of the evaluation, and it is done before anything is said about it. */
const markObjective = (question, chosenIndex) => {
  const raw = Number.isInteger(chosenIndex) ? chosenIndex : -1;
  const options = Array.isArray(question?.options) ? question.options : [];
  /* A choice outside the list of options is not an answer. It cannot arise from
     the buttons, but a stale index after the question bank changed would
     otherwise be scored as a deliberate wrong answer. */
  const chosen = raw >= 0 && raw < options.length ? raw : -1;
  const answered = chosen >= 0;
  const correct = answered && chosen === question.correctIndex;
  const verdict = !answered ? VERDICT.UNANSWERED : correct ? VERDICT.CORRECT : VERDICT.WRONG;

  return {
    kind: KIND.OBJECTIVE,
    correct,
    answered,
    verdict,
    tone: VERDICT_TONE[verdict],
    label: VERDICT_LABEL[verdict],
    chosenIndex: chosen,
    correctIndex: question.correctIndex,
    chosenText: answered ? options[chosen] : null,
    correctText: options[question.correctIndex],
    detail: !answered
      ? "No option was chosen."
      : correct
        ? `That matches the stored correct answer: ${options[question.correctIndex]}.`
        : `That does not match the stored correct answer, which is ${options[question.correctIndex]}.`,
    explanation: question.explanation || "",
    tests: [],
    tested: 0,
    passed: 0
  };
};

/* Whether an answer was judged wrong, as opposed to right or unjudged.

   Being unjudged is not being wrong. "Unable to evaluate automatically" means
   Quanta had nothing to check the answer against, and inviting the reader to
   rewrite a solution that may well be correct would be telling them their work
   is broken when the app's evidence is what's missing. */
const INCORRECT_VERDICTS = [VERDICT.WRONG, VERDICT.COMPILE_ERROR, VERDICT.RUNTIME_ERROR];
const isIncorrect = (mark) => Boolean(mark) && INCORRECT_VERDICTS.includes(mark.verdict);

/* Whether the question can be marked done on the strength of this answer. */
const isAccepted = (mark) => Boolean(mark) && mark.verdict === VERDICT.CORRECT;

/* ---------------------------- worked examples ---------------------------- */

/* Reads the problem's own worked examples out of its statement.
 *
 * The examples in a statement are real data about the problem, and running a
 * submission against them is a real test - several of them make it a much
 * better one, because a solution can pass the first case and fail the second.
 * But statements vary a lot - some write `Input: nums = [2,7], target = 9`,
 * some write it across lines, some use `k =` with no spaces - so anything
 * ambiguous is refused rather than guessed at. A wrong parse would produce a
 * wrong verdict, which is worse than no verdict. */
const parseAllExamples = (html, cap = 5) => {
  if (!html || typeof html !== "string") return [];
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|pre|li|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  /* One input line is a list of `name = value` or `name: value` pairs. */
  const parseInput = (line) => {
    const body = line.replace(/^\s*Input:\s*/i, "").trim();
    if (!body) return null;
    /* Split on commas that are NOT inside brackets, quotes or braces, so
       `nums = [1,2,3], k = 2` becomes two arguments and not five. */
    const parts = [];
    let depth = 0, quote = null, current = "";
    for (const ch of body) {
      if (quote) { current += ch; if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
      if ("[[{(".includes(ch)) depth += 1;
      if ("]})".includes(ch)) depth -= 1;
      if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
      current += ch;
    }
    if (current.trim()) parts.push(current);
    if (!parts.length) return null;

    const args = {};
    for (const part of parts) {
      const m = part.trim().match(/^([A-Za-z_$][\w$]*)\s*[:=]\s*([\s\S]+)$/);
      if (!m) return null;
      const raw = m[2].trim();
      if (!raw) return null;
      /* A value has to be a literal we can paste into the harness as-is:
         numbers, quoted strings, arrays, objects, booleans. Anything with an
         ellipsis, a call, or a range is a paraphrase of an input, not an input. */
      if (/(\.\.\.|\bless\b|\bgreater\b|\bor\b\s+more\b|≤|≥|<=|>=)/i.test(raw)) return null;
      if (!/^(-?\d+(\.\d+)?|".*"?|'.*'?|true|false|null|\[.*\]|\{.*\}|[A-Za-z_$][\w$]*)$/.test(raw)) return null;
      args[m[1]] = raw;
    }
    return Object.keys(args).length ? args : null;
  };

  const results = [];
  const lines = text.split("\n").map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^input\s*:/i.test(lines[i])) continue;
    const expectedLine = lines.slice(i + 1).find((l) => /^output\s*:/i.test(l));
    if (!expectedLine) continue;
    const args = parseInput(lines[i]);
    const value = expectedLine.replace(/^\s*Output:\s*/i, "").trim();
    if (!args || !value) continue;
    if (/(\.\.\.|explanation|note:)/i.test(value)) continue;
    /* The expected answer has to be a literal too. "Output: see below" is prose
       describing an answer, not an answer, and comparing a program's real output
       against it would always mismatch - a wrong verdict from valid code. */
    if (!/^(-?\d+(\.\d+)?|".*"?|'.*'?|true|false|null|\[.*\]|\{.*\})$/.test(value)) continue;
    results.push({ label: `Example ${results.length + 1}`, args, expected: value });
  }
  /* A cap, because a statement with twenty cases would mean twenty runs before
     the reader gets an answer. Five is enough for "all of them passed" to mean
     something. */
  return results.slice(0, Math.max(1, cap));
};

/* Kept as a name because callers that only want to know whether an example
   exists should not have to care that there is now more than one. */
const parseExamples = (html) => parseAllExamples(html, 5);

/* Wraps a submitted JavaScript function in something that can actually be
   called with an example's arguments and have its answer printed.
   Returns null when the shape is not recognised, which the caller treats as
   "no check available" rather than as a failure. */
const buildJsHarness = (code, example) => {
  const fnNames = new Set();
  const classMethods = [];
  const fnRe = /(?:function\s+([A-Za-z_$][\w$]*)|(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function\b|\([^)]*\)\s*=>)|([A-Za-z_$][\w$]*)\s*:\s*function\b)/g;
  let m;
  while ((m = fnRe.exec(code))) fnNames.add(m[1] || m[2] || m[3]);
  const classRe = /class\s+([A-Za-z_$][\w$]*)\s*\{([\s\S]*?)\n\}/g;
  while ((m = classRe.exec(code))) {
    for (const mm of m[2].matchAll(/([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
      classMethods.push({ cls: m[1], fn: mm[1] });
    }
  }
  const argNames = Object.keys(example.args);
  const callArgs = argNames.map((n) => example.args[n]);

  if (classMethods.length) {
    const entry = classMethods[0];
    return `${code}\n\n;(() => { const s = new ${entry.cls}(); const r = s.${entry.fn}(${callArgs.join(", ")}); console.log("__Q__" + JSON.stringify(r === undefined ? null : r)); })();`;
  }
  if (fnNames.size) {
    const name = [...fnNames][0];
    return `${code}\n\n;(() => { const r = ${name}(${callArgs.join(", ")}); console.log("__Q__" + JSON.stringify(r === undefined ? null : r)); })();`;
  }
  return null;
};

/* Turns one of the statement's literals into Python source.
   Statement values are written JSON-ish (`true`, `null`), which Python will not
   read, so the spellings are mapped rather than pasted. */
const toPythonLiteral = (raw) => {
  try {
    const value = JSON.parse(raw);
    const emit = (v) => {
      if (v === null) return "None";
      if (v === true) return "True";
      if (v === false) return "False";
      if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
      if (typeof v === "string") return JSON.stringify(v);
      if (Array.isArray(v)) return `[${v.map(emit).join(", ")}]`;
      if (typeof v === "object") return `{${Object.entries(v).map(([k, val]) => `${JSON.stringify(k)}: ${emit(val)}`).join(", ")}}`;
      return "None";
    };
    return emit(value);
  } catch {
    /* A bare identifier that is not JSON - a named constant the statement
       mentions. Python has no value for it, so there is nothing to build. */
    return null;
  }
};

/* The Python equivalent of buildJsHarness.

   Only the shape LeetCode actually serves is handled: a `class Solution` with a
   `def method(self, ...)`. Anything else returns null, and the caller reports
   the answer as unevaluated rather than guessing. */
const buildPythonHarness = (code, example) => {
  if (!code || typeof code !== "string") return null;
  const classMatch = code.match(/class\s+([A-Za-z_][\w]*)\s*:/);
  if (!classMatch) return null;
  const defMatch = code.match(/^[ \t]*def\s+([A-Za-z_][\w]*)\s*\(\s*self\s*(?:,([^)]*))?\)/m);
  if (!defMatch) return null;

  const cls = classMatch[1];
  const fn = defMatch[1];
  const argNames = Object.keys(example.args);
  const callArgs = [];
  for (const name of argNames) {
    const literal = toPythonLiteral(example.args[name]);
    if (literal === null) return null;
    callArgs.push(literal);
  }

  /* The result is printed as JSON so that the comparison on the way back is the
     same comparison JavaScript gets. Python's own repr would differ on strings
     and on dicts, and two spellings of the same answer is a wrong verdict
     waiting to happen. */
  const head = [
    "import json",
    "from typing import List, Optional, Dict, Tuple, Set",
    "",
    "class TreeNode:",
    "    def __init__(self, val=0, left=None, right=None):",
    "        self.val, self.left, self.right = val, left, right",
    "",
    code,
    "",
    "__inst = Solution()",
    `__res = __inst.${fn}(${callArgs.join(", ")})`,
    "print('__Q__' + json.dumps(__res, default=str))"
  ];
  return head.join("\n");
};

/* ------------------------------ Java harness ------------------------------
 *
 * Java is the app's default language, so leaving it unevaluated would leave the
 * most-used path unable to tell a right answer from a wrong one.
 *
 * The shape handled is the one LeetCode serves: a Solution class with a public
 * method. Anything else - a bare main, a class named something else, a
 * parameter the statement never mentions - returns null, and the answer is
 * reported as unevaluated. A harness that guessed at a type it did not
 * recognise would compile into something that answers the wrong question, and
 * that is worse than not checking.
 */

/* Statement literals are JSON-ish. Java needs them typed to the parameter:
   int[] becomes new int[]{...}, List<Integer> becomes a real list, and a bare
   9 stays 9. An unrecognised type returns null rather than a guess. */
const javaLiteralFor = (raw, type) => {
  const wanted = String(type || "").replace(/\s+/g, "");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  const arrayTypes = {
    "int[]": "int", "long[]": "long", "double[]": "double", "char[]": "char",
    "boolean[]": "boolean", "short[]": "short", "float[]": "float",
    "Integer[]": "Integer", "Long[]": "Long", "Double[]": "Double",
    "Character[]": "Character", "Boolean[]": "Boolean", "String[]": "String",
    "Object[]": "Object"
  };
  if (arrayTypes[wanted]) {
    if (!Array.isArray(value)) return null;
    const inner = arrayTypes[wanted];
    const items = value.map((v) => javaScalar(v, inner)).filter((v) => v !== null);
    if (items.length !== value.length) return null;
    return `new ${wanted}{${items.join(", ")}}`;
  }

  const listMatch = /^(?:List|ArrayList|LinkedList)<(.+)>$/.exec(wanted);
  if (listMatch) {
    if (!Array.isArray(value)) return null;
    const inner = listMatch[1];
    if (Array.isArray(inner)) {
      /* List<List<Integer>> - the inner lists need building too. */
      if (!value.every(Array.isArray)) return null;
      const rows = value.map((row) => {
        const cells = row.map((v) => javaScalar(v, inner[0])).filter((v) => v !== null);
        return cells.length === row.length ? `new ArrayList<>(Arrays.asList(${cells.join(", ")}))` : null;
      }).filter(Boolean);
      return rows.length === value.length ? `new ArrayList<>(Arrays.asList(${rows.join(", ")}))` : null;
    }
    const items = value.map((v) => javaScalar(v, inner)).filter((v) => v !== null);
    if (items.length !== value.length) return null;
    return `new ArrayList<>(Arrays.asList(${items.join(", ")}))`;
  }

  if (wanted === "TreeNode" || wanted === "ListNode") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const parts = ["val"];
    if (value.next !== undefined) parts.push(`next=${javaLiteralFor(JSON.stringify(value.next), wanted)}`);
    if (value.left !== undefined) parts.push(`left=${javaLiteralFor(JSON.stringify(value.left), wanted)}`);
    if (value.right !== undefined) parts.push(`right=${javaLiteralFor(JSON.stringify(value.right), wanted)}`);
    /* A null-valued next/left/right must not be written as the string "null". */
    if (parts.some((x) => x.includes("=null"))) {
      return `new ${wanted}(${value.val === undefined ? 0 : value.val}${parts.filter((x) => !x.endsWith("=null")).map((x) => ", " + x).join("")})`;
    }
    return `new ${wanted}(${value.val === undefined ? 0 : value.val}${parts.length > 1 ? ", " + parts.slice(1).join(", ") : ""})`;
  }

  return javaScalar(value, wanted);
};

/* One scalar, typed. Numbers and booleans and strings cover almost every
   signature LeetCode uses for a primitive parameter. */
const javaScalar = (value, type) => {
  const wanted = String(type || "");
  if (wanted === "int") return Number.isInteger(value) ? String(value) : null;
  if (wanted === "long") return Number.isInteger(value) ? value + "L" : null;
  if (wanted === "double") return typeof value === "number" ? String(value) : null;
  if (wanted === "float") return typeof value === "number" ? value + "f" : null;
  if (wanted === "short") return Number.isInteger(value) ? "(short)" + value : null;
  if (wanted === "boolean") return typeof value === "boolean" ? String(value) : null;
  if (wanted === "char") return typeof value === "string" && value.length === 1 ? `'${value}'` : null;
  if (wanted === "String" || wanted === "CharSequence" || wanted === "Object") {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(String(value));
    return null;
  }
  if (wanted === "Integer" || wanted === "Long" || wanted === "Double") {
    return typeof value === "number" ? String(value) : null;
  }
  return null;
};

const buildJavaHarness = (code, example) => {
  if (!code || typeof code !== "string") return null;
  const classMatch = code.match(/class\s+([A-Za-z_][\w]*)\s*(?:extends\s+[\w.]+)?\s*\{/);
  if (!classMatch) return null;
  const cls = classMatch[1];
  /* A public method with a body, which is what LeetCode asks for. */
  const methodMatch = code.match(/(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?([A-Za-z_][\w.]*(?:\s*<[^>]*>)?(?:\[\])?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:throws [\w., ]+)?\{/);
  if (!methodMatch) return null;
  const method = methodMatch[2];
  const paramText = (methodMatch[3] || "").trim();

  /* Parameters, in order, as {name, type}. */
  const params = [];
  if (paramText) {
    for (const part of paramText.split(",")) {
      const m = part.trim().match(/([A-Za-z_][\w.]*(?:\s*<[^>]*>)?(?:\[\])?)\s+([A-Za-z_]\w*)/);
      if (!m) return null;
      params.push({ type: m[1], name: m[2] });
    }
  }

  /* Arguments come from the statement, by name. A name the method does not take
     means the statement and the signature disagree - about a problem variant
     rather than this one - so nothing is built. */
  const callArgs = [];
  for (const name of Object.keys(example.args)) {
    const param = params.find((x) => x.name === name);
    if (!param) return null;
    const literal = javaLiteralFor(example.args[name], param.type);
    if (literal === null) return null;
    callArgs.push(literal);
  }
  if (callArgs.length !== params.length) return null;

  /* The result is printed as a plain string so it reads back the way a statement
     writes it: Arrays.toString gives "[0, 1]", a list gives "[0, 1]", a String
     gives the string itself. One spelling on both sides means one comparison. */
  const head = [
    "import java.util.*;",
    "",
    "class TreeNode { int val; TreeNode left; TreeNode right; TreeNode next; TreeNode() {} TreeNode(int v) { val = v; } TreeNode(int v, TreeNode l, TreeNode r) { val = v; left = l; right = r; } TreeNode(int v, TreeNode n) { val = v; next = n; } }",
    "class ListNode { int val; ListNode next; ListNode() {} ListNode(int v) { val = v; } ListNode(int v, ListNode n) { val = v; next = n; } }",
    "",
    code,
    "",
    "public class MockHarness {",
    "    static String show(Object o) {",
    "        if (o == null) return \"null\";",
    "        if (o instanceof int[]) return Arrays.toString((int[]) o);",
    "        if (o instanceof long[]) return Arrays.toString((long[]) o);",
    "        if (o instanceof double[]) return Arrays.toString((double[]) o);",
    "        if (o instanceof char[]) return Arrays.toString((char[]) o);",
    "        if (o instanceof boolean[]) return Arrays.toString((boolean[]) o);",
    "        if (o instanceof float[]) return Arrays.toString((float[]) o);",
    "        if (o instanceof short[]) return Arrays.toString((short[]) o);",
    "        if (o instanceof byte[]) return Arrays.toString((byte[]) o);",
    "        /* Every remaining array - String[], Integer[], List[][], int[][] - is an",
    "           Object[], and deepToString prints a flat one exactly as toString would. */",
    "        if (o instanceof Object[]) return Arrays.deepToString((Object[]) o);",
    "        if (o instanceof TreeNode) { TreeNode n = (TreeNode) o; StringBuilder b = new StringBuilder(); while (n != null) { if (b.length() > 0) b.append(\",\"); b.append(n.val); n = n.next; } return b.toString(); }",
    "        if (o instanceof ListNode) { ListNode n = (ListNode) o; StringBuilder b = new StringBuilder(); while (n != null) { if (b.length() > 0) b.append(\",\"); b.append(n.val); n = n.next; } return b.toString(); }",
    "        return String.valueOf(o);",
    "    }",
    "    public static void main(String[] args) {",
    `        Solution s = new ${cls}();`,
    `        System.out.println("__Q__" + show(s.${method}(${callArgs.join(", ")})));`,
    "    }",
    "}"
  ];
  return head.join("\n");
};

/* Chooses the harness for a language, or null when the language cannot be
   checked automatically. Kept here so the panel asks one question instead of
   carrying a language list of its own that could drift from this one. */
const harnessFor = (language, code, example) => {
  switch (language) {
    case "javascript": return buildJsHarness(code, example);
    case "python": return buildPythonHarness(code, example);
    case "java": return buildJavaHarness(code, example);
    default: return null;
  }
};

/* Whether an answer in this language can be checked at all, whatever the code
   turns out to say. Used to tell the reader why before they submit, rather than
   only afterwards. */
const CAN_EVALUATE = ["javascript", "python", "java"];

/* Turns the statement's literal into Python source, exported for the tests. */
const pythonLiteral = toPythonLiteral;

/* Compares what the code printed with what the statement says it should be.
 *
 * Loose on purpose: string and number shapes differ between a JavaScript or
 * Python result and the way a statement writes them, so they are normalised
 * before comparing. Anything that cannot be compared comes back as "not
   checked" rather than as a mismatch - a check that cannot read its own result
   has no opinion about it. */
const compareOutput = (stdout, expected) => {
  const marker = typeof stdout === "string" ? stdout.indexOf("__Q__") : -1;
  if (marker === -1) return { checked: false };
  const raw = stdout.slice(marker + 5).split("\n")[0].trim();
  if (!raw) return { checked: false };

  /* Both sides reduced to one canonical shape. A statement writes a string
     answer bare ("abc") while a result arrives quoted; those are the same
     answer. Arrays keep their structure so [0, 1] and [0,1] match, while
     numbers and booleans stay apart from the strings that look like them. */
  const normalise = (v) => {
    const text = String(v).trim();
    const bare = text.replace(/^"([\s\S]*)"$/, "$1").replace(/^'([\s\S]*)'$/, "$1");
    try {
      const parsed = JSON.parse(bare);
      if (parsed !== null && typeof parsed === "object") return JSON.stringify(parsed);
      if (typeof parsed === "number" || typeof parsed === "boolean") return JSON.stringify(parsed);
      return JSON.stringify(String(parsed));
    } catch {
      return JSON.stringify(bare);
    }
  };

  const got = normalise(raw);
  const want = normalise(expected);
  if (!got) return { checked: false };
  return { checked: true, matched: got === want, got: raw, expected: String(expected) };
};

/* Runs one worked example and turns the comparison into a row for the results
   screen: which example, what was expected, what came back, and whether it
   passed. A harness that could not be built, or that failed to produce a
   result, yields no row at all - the absence of a row is what the caller sees,
   and it must not be mistaken for a pass. */
const runExampleTest = async ({ harness, expected, expectedLabel, run }) => {
  if (!harness) return null;
  let outcome = null;
  try {
    /* Awaited deliberately. The runner is asynchronous for every language except
       JavaScript, and reading .stdout off the Promise instead of off the result
       leaves the comparison with an empty string and reports nothing at all. */
    outcome = await run(harness);
  } catch {
    outcome = null;
  }
  if (!outcome) return null;
  if (outcome.ok === false && !outcome.stdout) return null;
  const compared = compareOutput(outcome.stdout || "", expected);
  if (!compared.checked) return null;
  return {
    label: expectedLabel || "Example",
    passed: compared.matched === true,
    expected: compared.expected,
    got: compared.got
  };
};

/* ------------------------------ the results ------------------------------ */

/* Counts the finished test. Pure, so the numbers on the results screen can be
   checked without a browser - and so that the score line and the per-question
   cards cannot end up disagreeing about the same test. */
const summarise = (marks) => {
  const list = (Array.isArray(marks) ? marks : []).filter(Boolean);
  const total = list.length;
  const correct = list.filter((m) => m && m.verdict === VERDICT.CORRECT).length;
  const incorrect = list.filter((m) => m && (m.verdict === VERDICT.WRONG || m.verdict === VERDICT.COMPILE_ERROR || m.verdict === VERDICT.RUNTIME_ERROR)).length;
  const unanswered = list.filter((m) => m && (m.verdict === VERDICT.UNANSWERED || m.answered === false)).length;
  const unevaluated = list.filter((m) => m && m.verdict === VERDICT.UNVERIFIED).length;
  /* "Unable to evaluate" is neither right nor wrong: the reader may well have
     solved it. Counting it as incorrect would be claiming something the app
     does not know, so it is reported on its own line and excluded from the
     incorrect tally. */
  return {
    total,
    correct,
    incorrect,
    unanswered,
    unevaluated,
    /* Outright wrong or skipped. The headline number. */
    wrongTotal: incorrect + unanswered,
    percent: total ? Math.round((correct / total) * 100) : 0
  };
};

const API = {
  KIND,
  CODING_SECONDS,
  TEST_LENGTH,
  VERDICT,
  VERDICT_LABEL,
  VERDICT_TONE,
  hasCode,
  secondsFor,
  clockText,
  tick,
  fromAcademyQuiz,
  fromPatterns,
  buildObjectiveBank,
  patternFor,
  explanationFor,
  seededRandom,
  buildTest,
  markObjective,
  markCoding,
  parseExamples,
  parseAllExamples,
  buildJsHarness,
  buildPythonHarness,
  buildJavaHarness,
  harnessFor,
  CAN_EVALUATE,
  pythonLiteral,
  compareOutput,
  runExampleTest,
  summarise,
  isIncorrect,
  isAccepted,
  INCORRECT_VERDICTS
};

/* Assigned to window FIRST, and each export guarded on its own.

   The order matters, and getting it wrong is silent. Written as
   `module.exports = {...}` and then `window.x = module.exports`, the page
   throws "module is not defined" on the first line, never reaches the window
   assignment, and the panel then reports that its own module did not load -
   while the file is perfectly valid in Node, so every unit test passes. Two
   hours of green tests would not have caught it; opening the panel would. */
if (typeof window !== "undefined" && window) window.mockTestEngine = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
