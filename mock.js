/* ======================== mock interview simulator ======================
   A timed interview you can actually fail.

   What this measures, and what it does not
   -----------------------------------------
   It can measure: how long you took, whether you ran code, whether you
   submitted something, and how you rated yourself afterwards. Those are all
   facts this app can observe without pretending to know more.

   It cannot measure whether your solution was correct, because Quanta's runner
   has no access to a problem's hidden tests - the study schema says exactly
   this, and nothing here contradicts it. So the simulator never says "correct".
   It records a self-assessment and the time, and it feeds a real outcome into
   the revision system: a problem you rated "again" is scheduled for tomorrow,
   and one you rated "easy" is pushed further out.

   That last point is what makes it more than a timer. It is the only place in
   the app where an interview result changes what comes next. */

const MOCK_KEY = "quantaMockInterviewsV1";

/* How long each stage gets.

   The three stages are guidance about how to spend the time, not three separate
   allowances - together they make up one ten-minute clock for the program. They
   used to be 180 + 900 + 300 = 23 minutes, which is not how long an interview
   problem is normally given and made the countdown on screen disagree with the
   "10 minutes" people expect when a problem is set.

   The three lengths still add up to exactly MOCK_TOTAL_SECONDS. That is checked
   by a test rather than left to arithmetic in a comment. */
const MOCK_STAGES = [
  { key: "read", label: "Read and plan", seconds: 120, note: "Read the statement twice and say what you are going to do. Interviewers watch this." },
  { key: "code", label: "Write the solution", seconds: 330, note: "Write it. Narrate as you go - a silent five minutes reads badly." },
  { key: "check", label: "Test and edge cases", seconds: 150, note: "Run it. Feed it the empty case, one element, and all-equal values." }
];

/* The whole interview, and the answer to "how long have I got". Ten minutes. */
const MOCK_TOTAL_SECONDS = MOCK_STAGES.reduce((sum, stage) => sum + stage.seconds, 0);

const MOCK_DIFFICULTIES = ["Easy", "Medium", "Hard"];

/* Picks a problem to be interviewed on.
   The selection is deliberately explainable:
     - difficulty is what the interviewer asked for;
     - prefer something not yet solved, because re-interviewing a solved problem
       teaches nothing;
     - prefer something not already on the schedule, so the interview and the
       revision list do not collide;
     - fall back to anything matching the difficulty if the preferred pool is
       empty, rather than refusing to run.

   `reason` is shown on screen, so the choice can be argued with. */
const mockPickProblem = (problems, options = {}) => {
  const difficulty = MOCK_DIFFICULTIES.includes(options.difficulty) ? options.difficulty : "Easy";
  const solvedSlugs = options.solvedSlugs instanceof Set ? options.solvedSlugs : new Set();
  const scheduledSlugs = options.scheduledSlugs instanceof Set ? options.scheduledSlugs : new Set();

  const matching = problems.filter((p) => p.difficulty === difficulty);
  if (!matching.length) {
    /* No problem at that difficulty at all. Say so rather than silently
       handing over an Easy when Medium was asked for. */
    const available = [...new Set(problems.map((p) => p.difficulty))].sort();
    return {
      error: `Your catalog has no ${difficulty} problems. It has: ${available.join(", ") || "none"}.`,
      available
    };
  }

  const fresh = matching.filter((p) => !solvedSlugs.has(p.slug) && !scheduledSlugs.has(p.slug));
  const pool = fresh.length ? fresh : matching;
  const usedFallback = pool !== fresh;

  /* Stable pick from the pool, so the same settings do not reshuffle on every
     render, but a different seed gives a different problem. */
  const seed = Number(options.seed) || 0;
  const sorted = pool.slice().sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  const index = Math.abs(seed) % sorted.length;
  const chosen = sorted[index];

  const reasons = [];
  reasons.push(`${chosen.difficulty}, from ${chosen.platform === "codeforces" ? "Codeforces" : chosen.platform === "leetcode" ? "LeetCode" : chosen.platform}`);
  if (usedFallback) {
    reasons.push(
      solvedSlugs.has(chosen.slug)
        ? "you have already solved this one"
        : "it is already on your revision schedule"
    );
    reasons.push("nothing untouched matched, so this was the closest available");
  } else {
    reasons.push("you have neither solved nor scheduled it");
  }

  return { problem: chosen, reason: reasons.join("; ") + ".", fallback: usedFallback };
};

/* Builds the post-interview self-assessment. It asks the two questions an
   interviewer would actually ask, plus one about the approach, and each answer
   maps onto the revision system's confidence levels so the result is real.

   Options are written best-first because that is the order they read best in,
   and the ladder position is NOT stored next to them. An earlier version kept
   an `intervalStage` on each option and it drifted out of step with the
   confidence label - "easy" carried stage 2 while being listed first, next to
   "again" carrying stage 0, so the two fields disagreed about which answer was
   better. The stage is now derived from the confidence alone, in one place, so
   it cannot disagree with the label a user just read. */
const mockSelfAssessment = () => [
  {
    key: "approach",
    question: "Did you find the approach before writing code?",
    note: "The method matters more than the typing on most interviews.",
    options: [
      { label: "Yes, straight away", confidence: "easy" },
      { label: "After a few attempts", confidence: "good" },
      { label: "I was stuck", confidence: "difficult" },
      { label: "I never found it", confidence: "again" }
    ]
  },
  {
    key: "edges",
    question: "Did you check the edge cases?",
    note: "Empty input, one element, duplicates, and the largest case.",
    options: [
      { label: "Yes, all of them", confidence: "easy" },
      { label: "Some of them", confidence: "good" },
      { label: "I ran out of time", confidence: "difficult" },
      { label: "I forgot to", confidence: "again" }
    ]
  },
  {
    key: "explain",
    question: "Could you explain your solution out loud?",
    note: "If you cannot say why it is correct, you probably are not sure.",
    options: [
      { label: "Yes, clearly", confidence: "easy" },
      { label: "Roughly", confidence: "good" },
      { label: "Not really", confidence: "difficult" },
      { label: "Not at all", confidence: "again" }
    ]
  }
];

/* Confidence levels, weakest first. Index order is the ranking used below. */
const MOCK_CONFIDENCE_ORDER = ["again", "difficult", "good", "easy"];

/* Turns the three answers into one confidence level for the revision system,
   taking the WEAKEST answer.

   That is deliberate: one part of an interview going badly is what an
   interviewer actually notices, and averaging it away would let one lucky
   answer hide a real gap.

   An earlier version tried to express this by splicing the chosen levels out of
   a list of candidates and taking whatever was left, which removed them instead
   of narrowing them - three "easy" answers came back as "again", the exact
   opposite of the truth. This compares directly. */
const mockOverallConfidence = (answers) => {
  let worstIndex = MOCK_CONFIDENCE_ORDER.length - 1; // "easy" until proven otherwise
  let seen = false;

  for (const question of mockSelfAssessment()) {
    const picked = answers?.[question.key];
    /* An unanswered question is skipped rather than treated as a failure,
       because "I did not get to this one" is not the same as "I got it wrong". */
    if (!Number.isInteger(picked) || picked < 0 || picked >= question.options.length) continue;
    const confidence = question.options[picked].confidence;
    const index = MOCK_CONFIDENCE_ORDER.indexOf(confidence);
    if (index < 0) continue;
    seen = true;
    if (index < worstIndex) worstIndex = index;
  }

  return seen ? MOCK_CONFIDENCE_ORDER[worstIndex] : "good";
};

/* What the review says, per outcome. Plain and specific. */
const mockOutcomeText = (confidence) => {
  switch (confidence) {
    case "easy":
      return "You were comfortable here. This is scheduled further out, so it will not come back for a while.";
    case "good":
      return "A solid interview. It is scheduled to come back after a short break.";
    case "difficult":
      return "This one got away from you. It comes back tomorrow.";
    case "again":
      return "This one beat you. It comes back tomorrow, and the pattern page may help.";
    default:
      return "Saved to your revision list.";
  }
};

/* Formats a duration in seconds as m:ss, which is how a clock should read. */
const mockClock = (seconds) => {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
};

/* Exposed for both environments: scripts/test-mock.js requires this in Node,
   and the page reads it from `window`. */
const MOCK_API = {
  MOCK_STAGES,
  MOCK_TOTAL_SECONDS,
  MOCK_DIFFICULTIES,
  MOCK_KEY,
  mockPickProblem,
  mockSelfAssessment,
  mockOverallConfidence,
  mockOutcomeText,
  mockClock
};

if (typeof window !== "undefined" && window) {
  window.MOCK_STAGES = MOCK_STAGES;
  window.MOCK_TOTAL_SECONDS = MOCK_TOTAL_SECONDS;
  window.MOCK_DIFFICULTIES = MOCK_DIFFICULTIES;
  window.MOCK_KEY = MOCK_KEY;
  window.mockPickProblem = mockPickProblem;
  window.mockSelfAssessment = mockSelfAssessment;
  window.mockOverallConfidence = mockOverallConfidence;
  window.mockOutcomeText = mockOutcomeText;
  window.mockClock = mockClock;
  window.mockEngine = MOCK_API;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = MOCK_API;
}
