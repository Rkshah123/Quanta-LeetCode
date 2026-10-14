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
 * Quanta has no hidden tests for a problem, so it cannot claim a solution is
 * correct. What it can do is real:
 *
 *   - run the submitted code on the app's existing runner, and report whether it
 *     compiled and whether it ran;
 *   - for JavaScript, and only where the problem's own statement gives an
 *     unambiguous worked example, call the submitted function with those exact
 *     arguments and compare its result with the stated expected output.
 *
 * That second step is the only real correctness signal available, so the rules
 * around it are deliberately strict. An example is used only when the statement
 * parses cleanly into named arguments and one expected value. If the harness
 * itself errors, the answer is reported as UNVERIFIED rather than wrong - a
 * broken check must never mark good code incorrect. Only a clean run whose
 * output genuinely differs from the stated expected output counts as incorrect.
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

/* --------------------------------- marking ------------------------------- */

/* Marks a multiple-choice answer. */
const markObjective = (question, chosenIndex) => {
  const raw = Number.isInteger(chosenIndex) ? chosenIndex : -1;
  const options = Array.isArray(question?.options) ? question.options : [];
  /* A choice outside the list of options is not an answer. It cannot arise from
     the buttons, but a stale index after the question bank changed would
     otherwise be scored as a deliberate wrong answer. */
  const chosen = raw >= 0 && raw < options.length ? raw : -1;
  const correct = chosen >= 0 && chosen === question.correctIndex;
  return {
    kind: KIND.OBJECTIVE,
    /* "unanswered" is kept distinct from "wrong": skipping a question is not
       the same as getting it wrong, and the summary says so. */
    correct,
    answered: chosen >= 0,
    chosenIndex: chosen,
    correctIndex: question.correctIndex,
    chosenText: chosen >= 0 ? options[chosen] : null,
    correctText: options[question.correctIndex],
    explanation: question.explanation || ""
  };
};

/* Marks a coding answer from what the runner actually reported.
   `example` is the result of the optional statement-example check, or null when
   no usable example could be read. */
const markCoding = ({ compiled = true, ran = true, stdout = "", stderr = "", timedOut = false, example = null } = {}) => {
  const failedToCompile = !compiled;
  const crashed = compiled && !ran;
  let verdict = "unverified";
  let detail = "";

  if (failedToCompile) {
    verdict = "wrong";
    detail = "The code did not compile, so it cannot be a solution.";
  } else if (timedOut) {
    verdict = "wrong";
    detail = "The code ran but did not finish in time.";
  } else if (crashed) {
    verdict = "wrong";
    detail = "The code compiled but failed while running.";
  } else if (example && example.checked) {
    if (example.matched) {
      verdict = "correct";
      detail = `It returned the expected result for the problem's own worked example (${example.label}).`;
    } else {
      verdict = "wrong";
      detail = `It ran, but returned the wrong result for the problem's own worked example (${example.label}).`;
    }
  } else {
    verdict = "unverified";
    detail =
      "The code compiled and ran. Quanta has no hidden tests for this problem, and this problem's statement does not give a worked example that could be run automatically, so whether the answer is correct could not be established.";
  }

  return { kind: KIND.CODING, correct: verdict === "correct", answered: true, verdict, detail, stdout, stderr, example };
};

/* ---------------------------- worked examples ---------------------------- */

/* Reads the problem's own worked examples out of its statement.
 *
 * The examples in a statement are real data about the problem, and running a
 * submission against them is a real test. But statements vary a lot - some write
 * `Input: nums = [2,7], target = 9`, some write it across lines, some use `k =`
 * with no spaces - so anything ambiguous is rejected rather than guessed at.
 * A wrong parse would produce a wrong verdict, which is worse than no verdict. */
const parseExamples = (html) => {
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
      if ("]]})".includes(ch)) depth -= 1;
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
      /* A value has to be a literal we can paste into JavaScript as-is:
         numbers, quoted strings, arrays, objects, booleans. Anything with an
         ellipsis, a call, or a range is a paraphrase of an input, not an input. */
      if (/(\.\.\.|\bless\b|\bgreater\b|\bor\b\s+more\b|≤|≥|<=|>=)/i.test(raw)) return null;
      if (!/^(-?\d+(\.\d+)?|".*"?'.*'|true|false|null|\[.*\]|\{.*\}|[A-Za-z_$][\w$]*)$/.test(raw)) return null;
      args[m[1]] = raw;
    }
    return Object.keys(args).length ? args : null;
  };

  const results = [];
  const lines = text.split("\n").map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^input\s*:/i.test(lines[i])) continue;
    const expected = lines.slice(i + 1).find((l) => /^output\s*:/i.test(l));
    if (!expected) continue;
    const args = parseInput(lines[i]);
    const value = expected.replace(/^\s*Output:\s*/i, "").trim();
    if (!args || !value) continue;
    if (/(\.\.\.|explanation|note:)/i.test(value)) continue;
    /* The expected answer has to be a literal too. "Output: see below" is prose
       describing an answer, not an answer, and comparing a program's real
       output against it would always mismatch - a wrong verdict from a valid
       program. */
    if (!/^(-?\d+(\.\d+)?|".*"?'.*'|true|false|null|\[.*\]|\{.*\})$/.test(value)) continue;
    results.push({ label: `Input ${results.length + 1}`, args, expected: value });
  }
  /* One example is enough to be a real check. */
  return results.slice(0, 1);
};

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

/* Compares what the code printed with what the statement says it should be.
   Loose on purpose: string and number shapes differ between a JavaScript result
   and the way a statement writes them, so they are normalised before comparing.
   Anything that cannot be compared comes back as "not checked". */
const compareOutput = (stdout, expected) => {
  const marker = stdout.indexOf("__Q__");
  if (marker === -1) return { checked: false };
  const raw = stdout.slice(marker + 5).split("\n")[0].trim();
  /* Both sides are reduced to one canonical shape before comparing.

     A statement writes a string answer bare ("Output: abc") while a JavaScript
     result arrives quoted, and those are the same answer. Comparing them as text
     would call a correct solution wrong, so quotes are stripped first and then
     everything is re-encoded the same way. Arrays and objects keep their
     structure - `[0, 1]` and `[0,1]` are the same answer - while numbers and
     booleans are kept apart from the strings that look like them. */
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
  const a = normalise(raw);
  const b = normalise(expected);
  if (!a) return { checked: false };
  return { checked: true, matched: a === b, got: raw };
};

const API = {
  KIND,
  CODING_SECONDS,
  TEST_LENGTH,
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
  buildJsHarness,
  compareOutput
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
