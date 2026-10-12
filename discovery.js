/* ======================== smart problem discovery ========================
   Recommends what to solve next.

   What this is not
   -----------------
   It is not a "trending" list and it does not pretend to know what is
   popular. Popularity is not something any permitted source publishes, and the
   brief forbids inventing it. Instead every recommendation is derived from
   facts the app itself holds:

     - what you have solved, attempted, starred and scheduled for revision;
     - the curriculum topic each problem belongs to (from the source's own
       tags, stored by scripts/curate-catalog.js);
     - the difficulty and the platform;
     - which problems you have already met.

   Four real strategies, each answering a different question:

     "Weak spot"    - a topic you have started but not finished
     "Next step"    - the natural difficulty step up from what you can do
     "Due to revise"- already on your schedule (delegates to the revision system)
     "Breadth"      - a topic you have never touched at all

   Every recommendation carries the reason it was chosen, in words, so a
   suggestion can always be argued with. A recommendation the user cannot
   interrogate is just an oracle.
*/

const DISCOVERY_STRATEGIES = {
  weakSpot: {
    label: "Weak spots",
    note: "Topics you have started but barely moved in. Finishing one beats starting five.",
    /* A topic counts as a weak spot once you have solved at least one problem in
       it (so you have seen what it looks like) but not got far. The exact bar
       lives in discoveryRecommend and is explained there. */
    minSolved: 1
  },
  nextStep: {
    label: "Level up",
    note: "The difficulty step above what you have already solved in a topic.",
    minSolved: 1
  },
  breadth: {
    label: "Something new",
    note: "A topic you have never opened. Good for a gap in an interview."
  },
  due: {
    label: "Due to revise",
    note: "Problems already on your revision schedule."
  }
};

/* Difficulty order, used to decide what "one step up" means. */
const DIFFICULTY_ORDER = ["Easy", "Medium", "Hard"];

/* The topics the catalog is organised around. Kept as labels, matching the
   values stored in problems.topics. A topic with no problems is simply never
   recommended, because nothing can link to it. */
const DISCOVERY_TOPICS = [
  "Arrays", "Strings", "Hashing", "Two Pointers", "Sliding Window", "Prefix Sum",
  "Binary Search", "Linked List", "Stack", "Queue", "Trees", "BST", "Heaps",
  "Graphs", "Backtracking", "Greedy", "Dynamic Programming", "Tries",
  "Bit Manipulation", "Sorting", "Math", "Number Theory", "Advanced Graphs",
  "Probability", "SQL"
];

/* The topics the brief calls essential. A weak spot in a core topic outranks a
   weak spot in a supporting one, because an interview is far more likely to
   reach for the core material. Declared here, after the list, so it cannot be
   read before it is initialised. */
const CORE_TOPICS = new Set(DISCOVERY_TOPICS.slice(0, 18));
const coreScore = (topic) => (CORE_TOPICS.has(topic) ? 40 : 0);

const discoveryBuildTopics = (problems) => {
  /* topic -> { total, solved, attempted, byDifficulty: {Easy, Medium, Hard} } */
  const topics = {};
  for (const problem of problems) {
    const list = Array.isArray(problem.topics) ? problem.topics : [];
    for (const topic of list) {
      if (typeof topic !== "string" || !topic) continue;
      if (!topics[topic]) {
        topics[topic] = {
          topic,
          total: 0,
          solved: 0,
          attempted: 0,
          byDifficulty: { Easy: 0, Medium: 0, Hard: 0 },
          solvedByDifficulty: { Easy: 0, Medium: 0, Hard: 0 },
          platforms: {}
        };
      }
      const entry = topics[topic];
      entry.total += 1;
      if (problem.difficulty && entry.byDifficulty[problem.difficulty] !== undefined) {
        entry.byDifficulty[problem.difficulty] += 1;
      }
      const platform = problem.platform || "leetcode";
      entry.platforms[platform] = (entry.platforms[platform] || 0) + 1;
      /* "Attempted" means a run was recorded. A solved problem counts as
         attempted too, since solving it implies running it. */
      if (problem.lastRunAt) entry.attempted += 1;
      if (problem.solved) {
        entry.solved += 1;
        entry.attempted += 1;
        if (problem.difficulty && entry.solvedByDifficulty[problem.difficulty] !== undefined) {
          entry.solvedByDifficulty[problem.difficulty] += 1;
        }
      }
    }
  }
  return topics;
};

/* A score used only for ordering recommendations inside one strategy. It never
   decides WHETHER something is recommended - that is the strategy's job - so a
   wrong weight here changes the order of a list, never its membership. */
const discoveryScore = (problem, topicStat, difficultyHeadroom) => {
  let score = 0;

  /* Prefer the easier end of what is being offered, because a recommendation
     you cannot finish teaches nothing. Capped so a Hard never outranks a
     Medium purely on other factors. */
  const difficultyIndex = DIFFICULTY_ORDER.indexOf(problem.difficulty);
  if (difficultyIndex >= 0) score += (2 - difficultyIndex) * 30;

  /* Prefer a problem from a platform you actually use. */
  if (problem.platform === "leetcode") score += 12;

  /* A small nudge toward problems that carry a rating, since those come with a
     verifiable difficulty signal from the source. */
  if (Number.isFinite(problem.rating)) score += 6;

  /* In "level up", prefer the difficulty you are short of rather than any. */
  if (difficultyHeadroom && difficultyHeadroom[problem.difficulty]) score += 25;

  void topicStat;
  return score;
};

/* Builds the full recommendation list from the problem list.
   Pure: the same problems in give the same recommendations out, which is what
   makes the result explainable and testable. */
const discoveryRecommend = (problems, options = {}) => {
  const limit = Number(options.limit) || 12;
  const solved = options.solvedSlugs instanceof Set ? options.solvedSlugs : new Set();
  const dueSlugs = options.dueSlugs instanceof Set ? options.dueSlugs : new Set();
  const attempted = options.attemptedSlugs instanceof Set ? options.attemptedSlugs : new Set();

  const decorated = problems.map((problem) => ({
    ...problem,
    isSolved: Boolean(problem.solved) || solved.has(problem.slug),
    isAttempted: Boolean(problem.lastRunAt) || attempted.has(problem.slug),
    isDue: dueSlugs.has(problem.slug)
  }));

  const topics = discoveryBuildTopics(decorated);
  const out = [];
  const seen = new Set();

  const push = (entry) => {
    if (!entry || seen.has(entry.problem.slug)) return;
    seen.add(entry.problem.slug);
    out.push(entry);
  };

  /* --- due to revise ------------------------------------------------- */
  for (const problem of decorated) {
    if (!problem.isDue) continue;
    push({
      problem,
      strategy: "due",
      strategyLabel: DISCOVERY_STRATEGIES.due.label,
      reason: "Already on your revision schedule.",
      score: 1000
    });
  }

  /* --- weak spot ----------------------------------------------------- */
  /* A weak spot has to be a topic you have genuinely stalled on, not one you
     are simply part-way through. The rule is deliberately conservative:

       - at least MIN_SOLVED solved, so one lucky solve cannot invent a gap;
       - at least 3 problems in the topic, so "1 of 2" is a small sample and
         not evidence of anything;
       - solved share under 40%, AND at least 2 unsolved problems still open.

     An earlier threshold of 60% labelled a topic you were exactly half-way
     through as a "weak spot" and then recommended the very problem the
     level-up strategy would have suggested - the same problem, dressed up with
     a worse reason. At 40% the two strategies genuinely describe different
     situations and stop fighting over the same entry. */
  const weak = DISCOVERY_STRATEGIES.weakSpot;
  const weakTopics = Object.values(topics)
    .filter((stat) => stat.solved >= weak.minSolved)
    .filter((stat) => stat.total >= 3)
    .filter((stat) => stat.solved / stat.total < 0.4)
    .filter((stat) => stat.total - stat.solved >= 2)
    .sort((a, b) => a.solved / a.total - b.solved / b.total || b.total - a.total);

  for (const stat of weakTopics) {
    /* The difficulty you have solved least of, within the topic. */
    const target = DIFFICULTY_ORDER.find((d) => stat.byDifficulty[d] > stat.solvedByDifficulty[d]) || "Easy";
    const candidates = decorated
      .filter((p) => !p.isSolved && p.difficulty === target)
      .filter((p) => (Array.isArray(p.topics) ? p.topics : []).includes(stat.topic))
      .sort((a, b) => discoveryScore(b, stat) - discoveryScore(a, stat) || String(a.title).localeCompare(String(b.title)));

    const chosen = candidates[0];
    if (!chosen) continue;
    const share = Math.round((stat.solved / stat.total) * 100);
    push({
      problem: chosen,
      strategy: "weakSpot",
      strategyLabel: DISCOVERY_STRATEGIES.weakSpot.label,
      reason: `You have solved ${stat.solved} of ${stat.total} ${stat.topic} problems (${share}%). This is a ${chosen.difficulty} one.`,
      topic: stat.topic,
      score: 500 + coreScore(stat.topic)
    });
  }

  /* --- level up ------------------------------------------------------ */
  const step = DISCOVERY_STRATEGIES.nextStep;
  for (const stat of Object.values(topics)) {
    if (stat.solved < step.minSolved) continue;
    const topSolved = [...DIFFICULTY_ORDER].reverse().find((d) => stat.solvedByDifficulty[d] > 0);
    if (!topSolved) continue;
    const topIndex = DIFFICULTY_ORDER.indexOf(topSolved);
    const nextDifficulty = DIFFICULTY_ORDER[topIndex + 1];
    /* Already at the hardest level in this topic: nothing to level up to. */
    if (!nextDifficulty) continue;

    const candidates = decorated
      .filter((p) => !p.isSolved && p.difficulty === nextDifficulty)
      .filter((p) => (Array.isArray(p.topics) ? p.topics : []).includes(stat.topic))
      .sort((a, b) => discoveryScore(b, stat) - discoveryScore(a, stat) || String(a.title).localeCompare(String(b.title)));

    const chosen = candidates[0];
    if (!chosen) continue;
    push({
      problem: chosen,
      strategy: "nextStep",
      strategyLabel: DISCOVERY_STRATEGIES.nextStep.label,
      reason: `You have solved ${stat.solvedByDifficulty[topSolved]} ${topSolved} ${stat.topic} problem${stat.solvedByDifficulty[topSolved] === 1 ? "" : "s"}. This is ${nextDifficulty}.`,
      topic: stat.topic,
      score: 400
    });
  }

  /* --- breadth ------------------------------------------------------- */
  const untouched = Object.values(topics)
    .filter((stat) => stat.solved === 0 && stat.attempted === 0 && stat.total > 0)
    .sort((a, b) => b.total - a.total);

  for (const stat of untouched.slice(0, 3)) {
    const candidates = decorated
      .filter((p) => !p.isSolved && !p.isAttempted && p.difficulty === "Easy")
      .filter((p) => (Array.isArray(p.topics) ? p.topics : []).includes(stat.topic))
      .sort((a, b) => discoveryScore(b, stat) - discoveryScore(a, stat) || String(a.title).localeCompare(String(b.title)));
    const chosen = candidates[0];
    if (!chosen) continue;
    push({
      problem: chosen,
      strategy: "breadth",
      strategyLabel: DISCOVERY_STRATEGIES.breadth.label,
      reason: `You have not opened ${stat.topic} yet. This one starts Easy.`,
      topic: stat.topic,
      score: 300 + Math.min(50, stat.total / 20)
    });
  }

  /* --- fill, so the panel is never empty on a fresh catalog ----------- */
  if (out.length < limit) {
    const fresh = decorated
      .filter((p) => !p.isSolved && !p.isAttempted && !p.isDue)
      .sort((a, b) => discoveryScore(b) - discoveryScore(a) || String(a.title).localeCompare(String(b.title)));
    for (const problem of fresh) {
      if (out.length >= limit) break;
      push({
        problem,
        strategy: "explore",
        strategyLabel: "Explore",
        reason: "Not attempted yet, and within reach.",
        score: 100
      });
    }
  }

  out.sort((a, b) => b.score - a.score || String(a.problem.title).localeCompare(String(b.problem.title)));
  return out.slice(0, limit);
};

/* Progress per topic, for the coverage panel. Reports real counts from the
   problems given, never an estimate. */
const discoveryCoverage = (problems) => {
  const topics = discoveryBuildTopics(problems);
  return DISCOVERY_TOPICS.map((topic) => {
    const stat = topics[topic];
    if (!stat) return { topic, total: 0, solved: 0, attempted: 0, share: 0, status: "empty" };
    const share = stat.total ? stat.solved / stat.total : 0;
    return {
      topic,
      total: stat.total,
      solved: stat.solved,
      attempted: stat.attempted,
      share,
      /* status is a plain description of the numbers, not a judgement. */
      status: stat.total === 0 ? "empty" : share === 0 && stat.attempted === 0 ? "untouched" : share < 0.5 ? "partial" : "covered"
    };
  }).filter((entry) => entry.total > 0);
};

/* Exposed for both environments: scripts/test-discovery.js requires this in
   Node, and the page reads it from `window`. */
const DISCOVERY_API = {
  DISCOVERY_STRATEGIES,
  DISCOVERY_TOPICS,
  DIFFICULTY_ORDER,
  discoveryBuildTopics,
  discoveryRecommend,
  discoveryCoverage,
  discoveryScore
};

if (typeof window !== "undefined" && window) {
  window.DISCOVERY_STRATEGIES = DISCOVERY_STRATEGIES;
  window.DISCOVERY_TOPICS = DISCOVERY_TOPICS;
  window.discoveryRecommend = discoveryRecommend;
  window.discoveryCoverage = discoveryCoverage;
  window.discoveryEngine = DISCOVERY_API;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = DISCOVERY_API;
}
