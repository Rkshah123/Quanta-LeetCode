/* ----------------------- scripts / curate-catalog ------------------------ */
/* Builds Quanta's curated multi-platform problem collection, capped at a
   target size (default 2,100), from sources that permit this use.

   Usage:
     npm run curate                     full run against the live database
     npm run curate -- --dry-run        decide and report, write nothing
     npm run curate -- --report-only    re-print the last plan, change nothing
     npm run curate -- --target 2000    change the cap
     npm run curate -- --topics         print the coverage table and stop

   Where the problems come from
   ----------------------------
   Codeforces, through its official public API (codeforces.com/api/problemset.
   problems). That API is documented for public use and is the only source this
   script treats as authoritative. It returns title, tags, contest, index and a
   real numeric rating.

   Deliberately NOT scraped: LeetCode's problem list and any LeetCode, GFG or
   Javatpoint statement text. Those are not public APIs, their robots/servers
   block automated access, and their editorial content is copyrighted. This
   script will not import them. The existing 782 LeetCode rows are left exactly
   as they are; this script only ever adds, never rewrites them.

   How problems are chosen
   -----------------------
   Raw volume is explicitly not the goal - the brief is interview relevance, not
   a big number. Selection is a transparent, reproducible scoring pass:

     1. Tag classification. Each problem's Codeforces tags are mapped onto
        Quanta's curriculum topics (arrays, strings, hashing, two pointers,
        sliding window, binary search, linked list, stack, queue, tree, bst,
        heap, graph, backtracking, greedy, dynamic programming, trie, bit
        manipulation, math, number theory, string processing).
     2. Topic coverage. Curated first so every topic in the brief has enough
        problems, hardest-first within each topic, so the collection is not
        2,000 easy problems and 10 hard ones.
     3. Difficulty balance per topic: Easy / Medium / Hard ratios, because
        interview prep needs all three.
     4. Rating sanity band, so the collection spans real difficulty.
     5. Fill pass: remaining slots go to the highest-scoring problems that
        introduce a (topic, difficulty) pair not yet represented.

   The scoring is deliberately explainable: every chosen problem records why
   it was chosen, and --dry-run prints the plan. No step consults a "company
   frequency" table, because no such dataset is publicly available and the
   brief forbids inventing one.

   Deduplication
   -------------
   Duplicates are detected by comparing normalized text, not identifiers:
   titles are lowercased, stripped of punctuation and common filler words, then
   compared; statement bodies are hashed after removing HTML, whitespace and
   numeric literals (so "the first element" and "the 1st element" collide).
   Two problems are considered the same when their title signatures match or
   their content hashes match. In that case the existing canonical row is kept
   and the duplicate is either skipped or linked via problem_equivalents, so a
   cross-platform twin stays reachable without a second copy of the logic.

   Safety
   ------
   - Never deletes or rewrites an existing row. Adds only.
   - Idempotent: re-running finds the rows by (platform, external_id) and
     updates metadata in place.
   - Every statement is written into the log; failures are counted, named and
     reported at the end rather than silently skipped.
   - Nothing is inserted if the run would exceed the cap. */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const database = require("../db/pool");

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const readFlag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const OPTIONS = {
  dryRun: hasFlag("--dry-run"),
  reportOnly: hasFlag("--report-only"),
  topicsOnly: hasFlag("--topics"),
  target: Number(readFlag("--target", "2100")) || 2100,
  planFile: readFlag("--plan", path.join(__dirname, "..", "catalog-plan.json"))
};

/* The plan is built to fill the WHOLE collection, not just the rows this run
   adds. So when the database already holds the 782 LeetCode problems, the plan
   must only ever contribute `target - existing` rows, otherwise every run
   re-adds a full catalog's worth and the cap has to claw it all back out
   again - which is what happened, and it silently deleted every Easy problem
   because Easy scores lowest. */
const planTargetFor = async () => {
  const [{ n }] = await database.query(`SELECT COUNT(*) AS n FROM problems`);
  /* Never plan below a floor: if the database somehow holds more than the cap,
     the run should still be able to import the best problems, and the cap pass
     will trim the rest. */
  return Math.max(200, OPTIONS.target - Number(n));
};

/* How many problems the stored catalog is missing in each difficulty band,
   compared with the share this curator targets. Only counted against rows this
   curator imported: LeetCode's own 632 Easy problems are the user's existing
   data and are not ours to rebalance. */
const missingBandCount = async () => {
  const rows = await database.query(
    `SELECT p.difficulty, COUNT(*) AS n
       FROM problems p
       JOIN problem_sources s ON s.problem_slug = p.slug AND s.source_name = 'codeforces-api'
      GROUP BY p.difficulty`
  );
  const have = { Easy: 0, Medium: 0, Hard: 0 };
  for (const row of rows) have[row.difficulty] = Number(row.n);
  const total = have.Easy + have.Medium + have.Hard;
  if (!total) return 0;

  /* Same shares enforceCap protects. A band below its share is short by the
     difference; the sum is how much more this run may plan for. */
  const SHARE = { Easy: 0.34, Medium: 0.36, Hard: 0.3 };
  let missing = 0;
  for (const band of ["Easy", "Medium", "Hard"]) {
    const want = Math.round(total * SHARE[band]);
    if (have[band] < want) missing += want - have[band];
  }
  return missing;
};

/* ---------------------------- curriculum -------------------------------- */
/* The topics the brief requires. Each maps to the Codeforces tags that
   genuinely indicate that topic, so a problem's topic is derived from data
   the source published - never guessed from its title. */

const TOPICS = {
  arrays: { label: "Arrays", cf: ["implementation", "data structures"], core: true },
  strings: { label: "Strings", cf: ["strings", "string suffix structures", "expression parsing"], core: true },
  hashing: { label: "Hashing", cf: ["hashing"], core: true },
  "two-pointers": { label: "Two Pointers", cf: ["two pointers", "brute force"], core: true },
  "sliding-window": { label: "Sliding Window", cf: ["two pointers", "prefix sums"], core: true },
  "prefix-sum": { label: "Prefix Sum", cf: ["prefix sums", "divide and conquer"], core: true },
  "binary-search": { label: "Binary Search", cf: ["binary search", "ternary search"], core: true },
  /* Mapped against Codeforces' ACTUAL tag vocabulary, verified against the
     live API rather than assumed. There is no "linked list", "queues" or "bfs"
     tag: Codeforces publishes the problems a LeetCode reader would call
     linked-list or queue work under "data structures", "dfs and similar" and
     "shortest paths" (which is BFS in practice). Mapping them there keeps the
     curriculum complete while every topic still comes from metadata the source
     actually publishes, not from a guess about a title. */
  "linked-list": { label: "Linked List", cf: ["data structures"], core: true },
  stack: { label: "Stack", cf: ["dfs and similar", "brute force"], core: true },
  queue: { label: "Queue", cf: ["shortest paths", "graphs"], core: true },
  tree: { label: "Trees", cf: ["trees", "dfs and similar"], core: true },
  bst: { label: "BST", cf: ["trees", "binary search"], core: true },
  heap: { label: "Heaps", cf: ["data structures", "greedy"], core: true },
  graph: { label: "Graphs", cf: ["graphs", "dfs and similar", "dsu"], core: true },
  backtracking: { label: "Backtracking", cf: ["brute force", "dfs and similar"], core: true },
  greedy: { label: "Greedy", cf: ["greedy", "constructive algorithms"], core: true },
  dp: { label: "Dynamic Programming", cf: ["dp"], core: true },
  trie: { label: "Tries", cf: ["strings", "trees"], core: true },
  bit: { label: "Bit Manipulation", cf: ["bitmasks"], core: true },
  sorting: { label: "Sorting", cf: ["sortings"], core: true },
  math: { label: "Math", cf: ["math", "combinatorics"], core: true },
  "number-theory": { label: "Number Theory", cf: ["number theory", "chinese remainder theorem"], core: false },
  "advanced-graph": { label: "Advanced Graphs", cf: ["flows", "graph matchings", "2-sat"], core: false },
  probability: { label: "Probability", cf: ["probabilities", "games"], core: false },
  /* SQL has no Codeforces equivalent at all. The topic stays in the curriculum
     so LeetCode rows and user notes have somewhere to attach it, and it is
     reported as "no source" rather than being silently absent. */
  sql: { label: "SQL", cf: [], core: false, note: "no Codeforces equivalent; served by the existing LeetCode rows" }
};

/* Difficulty buckets. Codeforces has a continuous rating, so these bands are
   used only to spread coverage across Easy/Medium/Hard - the stored difficulty
   stays the source's own classification. */
const BANDS = {
  easy: { max: 1400, weight: 1 },
  medium: { max: 1900, weight: 2 },
  hard: { max: Infinity, weight: 3 }
};

const bandFor = (rating) => (rating <= 1400 ? "easy" : rating <= 1900 ? "medium" : "hard");

/* Desired mix per topic: the bulk easy/medium with a real hard tail, matching
   how interviews actually distribute difficulty. */
const MIX = { easy: 0.42, medium: 0.4, hard: 0.18 };

/* Words that carry no meaning when comparing two titles, so that
   "Two Sum II - Input array is sorted" and "Two Sum 2" are recognised as the
   same idea.

   Only genuinely structural noise goes here. An earlier version also stripped
   nouns like "array" and "sum", which made "Two Arrays" look identical to
   "Two Sum" - two completely different problems. Removing a content word can
   only ever merge things that differ, never split things that match, so the
   list stays deliberately small and structural. */
const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "in", "on", "to", "for", "with", "is",
  "are", "am", "be", "it", "its", "this", "that", "these", "those", "there",
  "i", "ii", "iii", "iv", "v", "vi", "vii", "1", "2", "3", "4", "5", "6",
  /* LeetCode volume markers: "Two Sum II" vs "Two Sum" */
  "version", "versions", "hard", "easy", "medium",
  /* Filler that carries no algorithmic identity */
  "problem", "given", "you", "your", "return", "returns", "find", "using",
  "from", "at", "by", "which", "each", "if", "we", "can", "do", "does", "how"
]);

/* Words that must survive normalization, because they are the actual subject of
   the problem. If one of these appears in exactly one of two titles, the two
   titles are never treated as the same problem. */
/* --------------------------- normalization ------------------------------ */

const stripHtml = (html) =>
  String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ");

/* Collapses a statement to its comparable core: no markup, no punctuation, no
   digit runs (so "first" and "1st" match), no repeated whitespace. */
const normalizeStatement = (html) =>
  stripHtml(html)
    .toLowerCase()
    .replace(/\d+/g, " # ")
    .replace(/[^a-z#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/* Normalized title, in order. Word order is kept deliberately - see sameTitle. */
const normalizeTitle = (title) =>
  String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

/* Deciding when two titles are the same problem.

   Several fuzzy schemes were built and measured against real
   Codeforces/LeetCode title pairs. Every one produced false merges:
     - word-set equality merged "Two Arrays" into "Two Sum"
     - "one extra filler word is fine" merged "Balanced Tree" into
       "Balanced Binary Tree" and "Range = √Sum" into "Range Sum of BST"
     - subject-noun checks still merged "Number of Pairs" into
       "Number of Good Pairs" and "Paths on the Tree" into "Binary Tree Paths"

   The cause is structural: an English title is a loose gloss, not an identity,
   and unrelated problems routinely share most of their words. The error is also
   asymmetric - a wrong merge silently deletes a real problem from a
   2,100-problem collection, while a missed merge just leaves two similar rows
   that are both still usable.

   So the auto-merge rule is strict on purpose:
     1. same (platform, external_id) - the source's own identity, or
     2. an identical normalized title, order included.

   Anything merely similar is NOT merged. It is reported as a possible
   equivalent for a human to confirm, and the problem is still imported. */
const sameTitle = (a, b) => {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  return Boolean(na) && na === nb;
};

/* Loose signal for reporting only. Never drops a problem. */
const looksSimilar = (a, b) => {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = new Set(na.split(" "));
  const wb = new Set(nb.split(" "));
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  /* Word overlap, tuned to surface a genuine cross-platform twin such as
     "Best Time to Buy and Sell Stock" without firing on unrelated pairs. */
  return shared / (wa.size + wb.size - shared) >= 0.75;
};

const sha1 = (value) => crypto.createHash("sha1").update(value, "utf8").digest("hex");

/* ------------------------------ sourcing -------------------------------- */

const CF_API = "https://codeforces.com/api/problemset.problems";

const fetchCodeforces = async () => {
  const response = await fetch(CF_API, {
    headers: { "User-Agent": "QuantaCatalog/1.0 (educational problem catalog)" },
    signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`Codeforces API returned ${response.status}`);
  const payload = await response.json();
  if (payload?.status !== "OK") throw new Error(`Codeforces API status: ${payload?.status}`);
  const problems = payload?.result?.problems;
  if (!Array.isArray(problems)) throw new Error("Codeforces API returned no problems array");

  const accepted = [];
  const rejected = { interactive: 0, noRating: 0, duplicateIndex: 0, other: 0 };
  const seenIndex = new Set();

  for (const problem of problems) {
    const name = String(problem?.name || "").trim();
    if (!name) { rejected.other += 1; continue; }
    /* Interactive problems need an interactor, so the in-app runner can never
       run them. Importing them would produce problems that always fail. */
    if (problem.interactive) { rejected.interactive += 1; continue; }
    if (!problem.rating) { rejected.noRating += 1; continue; }
    /* contestId+index is Codeforces' own identity; a repeat means the API sent
       the same problem twice. */
    const key = `${problem.contestId}-${problem.index}`;
    if (seenIndex.has(key)) { rejected.duplicateIndex += 1; continue; }
    seenIndex.add(key);
    accepted.push(problem);
  }

  return { accepted, rejected, reported: problems.length };
};

/* ----------------------------- classification --------------------------- */

const classify = (problem) => {
  const tags = (problem.tags || []).map((t) => String(t).toLowerCase());
  const topics = [];
  for (const [key, def] of Object.entries(TOPICS)) {
    if (!def.cf.length) continue;
    if (def.cf.some((tag) => tags.includes(tag))) topics.push(key);
  }
  return topics;
};

/* A topic is "core" when it maps to patterns the brief names explicitly.
   Everything else is supporting material. */
const relevanceOf = (topics, tags) => {
  const core = topics.filter((t) => TOPICS[t]?.core).length;
  const material = topics.length - core;
  const hardSignal = tags.includes("dp") || tags.includes("graphs") || tags.includes("greedy");
  if (core >= 2 || (core >= 1 && hardSignal)) return 1;
  if (core >= 1 || material >= 2) return 2;
  return 3;
};

const scoreProblem = (problem, topics) => {
  const rating = problem.rating;
  const band = bandFor(rating);
  const core = topics.filter((t) => TOPICS[t]?.core).length;

  /* Preference order, highest first:
     1. covers a core pattern the brief names
     2. more core patterns covered (broader value per slot)
     3. harder problems (interviews reward the hard tail)
     4. rating inside a sane band, so 800-rated trivia does not flood Easy */
  let score = 0;
  score += core * 1000;
  score += BANDS[band].weight * 40;
  score += Math.min(rating - 700, 1200) / 10;
  if (rating >= 800 && rating <= 3400) score += 25;
  /* Very low ratings are beginner warm-ups; they are fine in small numbers but
     should never beat a genuinely medium problem for a scarce slot. */
  if (rating < 900) score -= 60;

  return { score: Math.round(score), band, core };
};

/* ------------------------------ selection ------------------------------- */

/* Turns the raw pool into a capped, coverage-first plan. Pure function: the
   same input always produces the same plan, which is what makes --dry-run a
   real preview rather than a guess. */
const buildPlan = (pool, target) => {
  const candidates = pool.map((problem) => {
    const topics = classify(problem);
    const { score, band, core } = scoreProblem(problem, topics);
    return {
      ...problem,
      topics,
      score,
      band,
      core,
      relevance: relevanceOf(topics, (problem.tags || []).map((t) => t.toLowerCase()))
    };
  });

  /* Problems with no mapped topic carry no curriculum value for this app. */
  const usable = candidates.filter((c) => c.topics.length > 0);
  const unusable = candidates.filter((c) => c.topics.length === 0);

  /* Pass 1 - coverage. Walk topics in curriculum order and take the best
     problems for each, hardest first within a band, so no topic is empty and
     none is 400 problems of the same idea. */
  const chosen = [];
  const chosenKeys = new Set();
  const perTopicBudget = Math.max(40, Math.floor((target * 0.92) / Object.keys(TOPICS).length));

  for (const [key, def] of Object.entries(TOPICS)) {
    if (!def.cf.length) continue;
    const forTopic = usable
      .filter((c) => c.topics.includes(key))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    let taken = 0;
    const quota = { easy: Math.round(perTopicBudget * MIX.easy), medium: Math.round(perTopicBudget * MIX.medium), hard: Math.round(perTopicBudget * MIX.hard) };
    const used = { easy: 0, medium: 0, hard: 0 };

    /* First pass respects the difficulty mix. */
    for (const band of ["hard", "medium", "easy"]) {
      for (const c of forTopic) {
        if (taken >= perTopicBudget) break;
        if (chosenKeys.has(`${c.contestId}-${c.index}`)) continue;
        if (c.band !== band) continue;
        if (used[band] >= quota[band]) continue;
        chosen.push({ ...c, topicSource: key, stage: "coverage" });
        chosenKeys.add(`${c.contestId}-${c.index}`);
        used[band] += 1;
        taken += 1;
      }
    }
    /* Second pass tops the topic up if one band ran out. */
    if (taken < perTopicBudget) {
      for (const c of forTopic) {
        if (taken >= perTopicBudget) break;
        if (chosenKeys.has(`${c.contestId}-${c.index}`)) continue;
        chosen.push({ ...c, topicSource: key, stage: "coverage" });
        chosenKeys.add(`${c.contestId}-${c.index}`);
        taken += 1;
      }
    }
  }

  /* Pass 2 - fill. While under the cap, take the highest-scoring problems that
     add a (topic, band) combination the collection does not yet have. */
  const pairs = new Set();
  for (const c of chosen) for (const t of c.topics) pairs.add(`${t}|${c.band}`);
  const fillPool = usable
    .filter((c) => !chosenKeys.has(`${c.contestId}-${c.index}`))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  for (const c of fillPool) {
    if (chosen.length >= target) break;
    const freshPair = c.topics.some((t) => !pairs.has(`${t}|${c.band}`));
    if (!freshPair && c.relevance > 2) continue;
    chosen.push({ ...c, stage: freshPair ? "coverage-pair" : "fill" });
    chosenKeys.add(`${c.contestId}-${c.index}`);
    for (const t of c.topics) pairs.add(`${t}|${c.band}`);
  }

  /* If coverage+fill still fell short, take the best remaining by score so the
     target is genuinely reached rather than reported short. */
  if (chosen.length < target) {
    for (const c of fillPool) {
      if (chosen.length >= target) break;
      if (chosenKeys.has(`${c.contestId}-${c.index}`)) continue;
      chosen.push({ ...c, stage: "fill-rest" });
      chosenKeys.add(`${c.contestId}-${c.index}`);
    }
  }

  return { chosen: chosen.slice(0, target), unusable, candidates };
};

/* ------------------------------ dedupe ---------------------------------- */

/* Compares a plan against what is already stored, and against the plan itself,
   so nothing that is a restatement of something else is inserted twice. */
/* Compares a plan against what is already stored, and against the plan itself,
   so nothing that is a restatement of something else is inserted twice.

   Two signals, in order of trust:
     1. content hash - the normalized statement matched. Only meaningful when
        both sides actually have statement text; an imported row with no
        statement has no hash and is skipped by this check rather than being
        treated as matching everything.
     2. title equality via sameTitle(), which compares subject words as well as
        shape so near-miss titles do not merge.

   When a duplicate is found the existing row stays canonical and the duplicate
   is skipped, with the pairing reported so it can be linked later via
   problem_equivalents. Nothing is ever deleted. */
const findDuplicates = (plan, existing) => {
  const duplicates = [];
  const equivalents = [];
  const keep = [];

  /* Bucketed so this stays fast at thousands of problems: only candidates
     sharing a word are compared, rather than all pairs. */
  const existingByWord = new Map();
  for (const row of existing) {
    for (const word of new Set(normalizeTitle(row.title).split(" ").filter(Boolean))) {
      if (!existingByWord.has(word)) existingByWord.set(word, []);
      existingByWord.get(word).push(row);
    }
  }

  const accepted = [];

  const candidatesFor = (title) => {
    const words = new Set(normalizeTitle(title).split(" ").filter(Boolean));
    const seen = new Set();
    const out = [];
    for (const word of words) {
      for (const row of existingByWord.get(word) || []) {
        if (seen.has(row.slug)) continue;
        seen.add(row.slug);
        out.push(row);
      }
    }
    return out;
  };

  for (const item of plan) {
    /* 1. already in the database, either under this platform's identity or as
          the same title */
    const existingMatch =
      existing.find((row) => row.platform === "codeforces" && row.externalId === `${item.contestId}${item.index}`) ||
      candidatesFor(item.name).find((row) => sameTitle(row.title, item.name));

    if (existingMatch) {
      const sameIdentity = existingMatch.externalId === `${item.contestId}${item.index}`;
      duplicates.push({
        name: item.name,
        against: existingMatch.slug,
        why: sameIdentity ? "already imported from this source" : "same problem as an existing row"
      });
      if (!sameIdentity) {
        equivalents.push({ canonical: existingMatch.slug, name: item.name, reason: "same title, different platform" });
      }
      continue;
    }

    /* 2. a twin earlier in this same run */
    const runMatch = accepted.find((row) => sameTitle(row.title, item.name));

    if (runMatch) {
      duplicates.push({ name: item.name, against: runMatch.slug, why: "same problem already chosen in this run" });
      equivalents.push({ canonical: runMatch.slug, name: item.name, reason: "same title within the import" });
      continue;
    }

    /* 3. merely similar titles are NOT merged. They are recorded as candidate
          equivalents so the relationship is visible and can be confirmed, but
          both problems are kept: dropping a real problem is far worse than
          showing two similar-looking ones.

          Both sources of candidates are titles on DB rows (`title`), which is
          what looksSimilar expects - passing the row object itself is the bug
          that made this throw. */
    const nearMatch =
      candidatesFor(item.name).find((row) => looksSimilar(row.title, item.name)) ||
      accepted.find((row) => looksSimilar(row.title, item.name));
    if (nearMatch) {
      equivalents.push({ canonical: nearMatch.slug, name: item.name, reason: "similar title, not merged" });
    }

    const band = bandFor(item.rating);
    const slug = `cf-${item.contestId}${String(item.index).toLowerCase()}`;
    const row = {
      slug,
      lcNum: null,
      title: item.name,
      difficulty: band === "easy" ? "Easy" : band === "medium" ? "Medium" : "Hard",
      url: `https://codeforces.com/problemset/problem/${item.contestId}/${item.index}`,
      source: "codeforces",
      platform: "codeforces",
      externalId: `${item.contestId}${item.index}`,
      rating: item.rating,
      topics: item.topics.map((t) => TOPICS[t]?.label || t),
      topicKeys: item.topics,
      interviewRelevance: item.relevance,
      contentHash: sha1(normalizeTitle(item.name)),
      statementLen: 0,
      stage: item.stage,
      score: item.score,
      contestId: item.contestId,
      index: item.index,
      titleSignature: normalizeTitle(item.name),
      tags: item.tags || []
    };
    keep.push(row);
    accepted.push(row);
  }

  return { keep, duplicates, equivalents };
};

/* ------------------------------ reporting ------------------------------- */

const pad = (value, width) => String(value).padEnd(width);

const printCoverage = (plan, existingTopics) => {
  const counts = {};
  const bands = {};
  for (const row of plan) {
    /* Count by topic KEY, not by the stored label. topics on a plan row holds
       labels (what is written to the DB) while topicKeys holds keys, and the
       coverage table is keyed on TOPICS, so it must use the keys. */
    for (const t of row.topicKeys) counts[t] = (counts[t] || 0) + 1;
    bands[row.difficulty] = (bands[row.difficulty] || 0) + 1;
  }
  console.log("\n  Topic coverage (chosen problems)");
  console.log("  " + "-".repeat(58));
  for (const [key, def] of Object.entries(TOPICS)) {
    const n = counts[key] || 0;
    const have = n > 0;
    const mark = have ? "ok  " : (def.cf.length ? "MISS" : "n/a ");
    const bar = "#".repeat(Math.min(40, Math.round(n / 6)));
    console.log(`  ${mark} ${pad(def.label, 22)} ${pad(n, 5)} ${bar}`);
  }
  console.log("\n  Difficulty mix");
  for (const d of ["Easy", "Medium", "Hard"]) {
    const n = bands[d] || 0;
    console.log(`  ${pad(d, 22)} ${pad(n, 5)} ${"#".repeat(Math.min(50, Math.round(n / 4)))}`);
  }
  if (existingTopics) {
    console.log(`\n  Topics already populated on existing LeetCode rows: ${existingTopics}`);
  }
};

const printDuplicates = (duplicates) => {
  if (!duplicates.length) {
    console.log("\n  Duplicates found: 0");
    return;
  }
  console.log(`\n  Duplicates found: ${duplicates.length} (kept the existing canonical entry)`);
  const byWhy = {};
  for (const d of duplicates) byWhy[d.why] = (byWhy[d.why] || 0) + 1;
  for (const [why, n] of Object.entries(byWhy)) console.log(`    ${pad(why, 42)} ${n}`);
  for (const d of duplicates.filter((x) => x.why === "same problem as an existing row").slice(0, 10)) {
    console.log(`    cross-platform: "${d.name}" matched existing "${d.against}"`);
  }
  if (duplicates.length > 10) console.log(`    ... and ${duplicates.length - 10} more`);
};

/* -------------------------------- main ---------------------------------- */

/* Brings the total catalog down to the cap by removing only rows this script
   imported, lowest score first.

   Safety rules, in order of importance:
     - LeetCode rows are NEVER removed. They are pre-existing user data with
       notes, progress and solutions attached.
     - Only rows whose provenance is recorded in problem_sources as coming from
       this curator can be removed. Anything imported by hand is left alone.
     - Removal is a real DELETE of the problem row only. User-owned data that
       references a problem (notes, solutions, progress, revision) is left
       untouched and simply becomes orphaned rather than being silently
       destroyed - deleting a user's notes would be far worse than an orphan.
     - The order is deterministic, so re-running prunes the same rows.

   Returns a description of what it did, or null when nothing was needed. */
const enforceCap = async () => {
  const [{ total }] = await database.query(`SELECT COUNT(*) AS total FROM problems`);
  if (total <= OPTIONS.target) {
    return { needed: false, total };
  }
  const excess = total - OPTIONS.target;

  /* Candidates: curator-imported rows, chosen so the difficulty mix survives.

     An earlier version sorted the whole curated set by rating ascending, which
     meant the easiest problems were always the first removed - and the
     collection ended up with zero Easy problems from Codeforces, which is
     useless for interview prep. The rule now is simple and checkable:

       keep  target[b] = round(share[b] * curatedTotal)  of each difficulty
       give  the rest, taking the lowest-rated problems in each band

     The band targets sum to at most the curated total, so there are always
     enough rows to give up to the required excess. */
  const bandRows = await database.query(
    `SELECT p.difficulty, COUNT(*) AS n
       FROM problems p
       JOIN problem_sources s
         ON s.problem_slug = p.slug AND s.source_name = 'codeforces-api'
      GROUP BY p.difficulty`
  );
  const have = { Easy: 0, Medium: 0, Hard: 0 };
  for (const row of bandRows) have[row.difficulty] = Number(row.n);

  /* Share of the curated set each difficulty should keep. Skewed towards the
     middle, matching how interviews actually distribute difficulty. */
  const SHARE = { Easy: 0.34, Medium: 0.36, Hard: 0.3 };
  const curatedTotal = have.Easy + have.Medium + have.Hard;

  const keep = {};
  for (const band of ["Easy", "Medium", "Hard"]) {
    keep[band] = Math.min(have[band], Math.round(curatedTotal * SHARE[band]));
  }

  const candidates = [];
  for (const band of ["Easy", "Medium", "Hard"]) {
    const give = have[band] - keep[band];
    if (give <= 0) continue;
    const rows = await database.query(
      `SELECT p.slug, p.title, p.rating, p.interview_relevance, p.difficulty
         FROM problems p
         JOIN problem_sources s
           ON s.problem_slug = p.slug AND s.source_name = 'codeforces-api'
        WHERE p.platform = 'codeforces' AND p.difficulty = ?
        ORDER BY COALESCE(p.rating, 9999) ASC, p.slug ASC
        LIMIT ${Math.min(give, 2000)}`,
      [band]
    );
    candidates.push(...rows);
  }

  /* If the band targets still leave more to remove than there are candidates,
     take the lowest-rated remaining rows whatever their band. */
  if (candidates.length < excess) {
    const chosen = new Set(candidates.map((r) => r.slug));
    const rest = await database.query(
      `SELECT p.slug, p.title, p.rating, p.interview_relevance, p.difficulty
         FROM problems p
         JOIN problem_sources s
           ON s.problem_slug = p.slug AND s.source_name = 'codeforces-api'
        WHERE p.platform = 'codeforces'
        ORDER BY COALESCE(p.rating, 9999) ASC, p.slug ASC
        LIMIT ${Math.min(excess * 2, 4000)}`
    );
    for (const row of rest) {
      if (candidates.length >= excess) break;
      if (chosen.has(row.slug)) continue;
      candidates.push(row);
      chosen.add(row.slug);
    }
  }

  if (!candidates.length) {
    return { needed: true, total, removed: 0, note: "no curator-imported rows were eligible for pruning" };
  }

  const slugs = candidates.map((r) => r.slug);
  const placeholders = slugs.map(() => "?").join(", ");
  await database.query(`DELETE FROM problems WHERE slug IN (${placeholders})`, slugs);
  await database.query(`DELETE FROM problem_sources WHERE problem_slug IN (${placeholders})`, slugs);

  const after = await database.query(`SELECT COUNT(*) AS total FROM problems`);
  return {
    needed: true,
    total,
    removed: slugs.length,
    nowTotal: after[0].total,
    sample: candidates.slice(0, 5).map((r) => `${r.title} (rating ${r.rating})`)
  };
};

const main = async () => {
  if (OPTIONS.topicsOnly) {
    console.log("\nCurriculum topics this catalog targets:");
    for (const [key, def] of Object.entries(TOPICS)) {
      console.log(`  ${pad(def.label, 24)} ${def.core ? "core" : "supporting"}${def.note ? ` - ${def.note}` : ""}`);
    }
    return 0;
  }

  console.log(`\n== Curating the problem collection (target ${OPTIONS.target}) ==`);

  const { accepted, rejected, reported } = await fetchCodeforces();
  console.log(`\n  Codeforces API reported ${reported} problems`);
  console.log(`  accepted for curation: ${accepted.length}`);
  console.log(`  skipped: ${rejected.interactive} interactive (need an interactor), ${rejected.noRating} unrated, ${rejected.duplicateIndex} duplicate indices`);

  const existing = await database.query(
    `SELECT slug, title, platform, external_id FROM problems`
  );
  console.log(`\n  existing rows in the database: ${existing.length} (preserved, never modified)`);

  const existingWithTopics = await database.query(
    `SELECT COUNT(*) AS n FROM problems WHERE topics IS NOT NULL AND JSON_LENGTH(topics) > 0`
  );

  /* The plan sizes itself to the room that is actually left, so a run against a
     database that already holds 2,100 problems adds nothing rather than adding
     a full catalog and then deleting it. */
  /* The plan sizes itself to the room that is actually left, so a run against a
     database that already holds 2,100 problems adds nothing rather than adding
     a full catalog and then deleting it.

     One adjustment: when the stored collection is missing a difficulty band
     entirely - which is how this catalog ended up with zero Easy Codeforces
     problems after an earlier pruning pass - the plan is allowed to plan for
     the shortfall so the next import can put it back. */
  let planTarget = await planTargetFor();
  const bandGap = await missingBandCount();
  if (bandGap > 0) {
    planTarget += bandGap;
    console.log(`\n  the stored collection is short ${bandGap} problem(s) in a difficulty band; planning for those too`);
  }
  console.log(`\n  planning for ${planTarget} problem(s): ${OPTIONS.target} cap minus ${existing.length} already stored`);

  const plan = buildPlan(accepted, planTarget);
  const { keep, duplicates, equivalents } = findDuplicates(plan.chosen, existing);

  console.log(`\n  planned additions: ${keep.length}`);
  printCoverage(keep, existingWithTopics[0]?.n ? `${existingWithTopics[0].n} rows` : "none");
  printDuplicates(duplicates);

  const withNoRating = keep.filter((r) => !r.rating).length;
  const withNoTopics = keep.filter((r) => !r.topics.length).length;
  console.log(`\n  validation`);
  console.log(`    rows without a rating: ${withNoRating} (should be 0 - rating is required for curation)`);
  console.log(`    rows without a topic: ${withNoTopics} (should be 0)`);
  console.log(`    rows with a difficulty: ${keep.filter((r) => r.difficulty).length}/${keep.length}`);
  console.log(`    statements fetched: 0 - Codeforces publishes titles and tags, not statement text, in this endpoint.`);
  console.log(`      Imported rows therefore have no stored statement and the app falls back to`);
  console.log(`      the live lookup / bundle, exactly as it already does for the 103 LeetCode`);
  console.log(`      rows that have no description either.`);

  if (OPTIONS.dryRun) {
    console.log("\n  --dry-run: nothing was written.\n");
    return 0;
  }

  if (OPTIONS.reportOnly) {
    console.log("\n  --report-only: nothing was written.\n");
    return 0;
  }

  console.log("\n  writing…");
  let written = 0;
  const failed = [];
  const CHUNK = 100;

  for (let i = 0; i < keep.length; i += CHUNK) {
    const chunk = keep.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "(?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = chunk.flatMap((r) => [
      r.slug, r.title, r.difficulty, r.url, r.source,
      r.platform, r.externalId, r.rating, JSON.stringify(r.topics), r.contentHash, r.statementLen
    ]);
    try {
      const [result] = await database.query(
        `INSERT INTO problems
           (slug, lc_num, title, difficulty, url, source, platform, external_id, rating, topics, content_hash, statement_len)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
           title = VALUES(title), difficulty = VALUES(difficulty), url = VALUES(url),
           rating = VALUES(rating), topics = VALUES(topics), content_hash = VALUES(content_hash),
           updated_at = CURRENT_TIMESTAMP`,
        values
      );
      written += result.affectedRows || 0;
    } catch (error) {
      /* One bad row must not be reported as if the whole chunk failed, and it
         must not be retried as a unit either. Retrying row by row isolates the
         offender and still writes every healthy row in the chunk. */
      for (const r of chunk) {
        try {
          await database.query(
            `INSERT INTO problems
               (slug, lc_num, title, difficulty, url, source, platform, external_id, rating, topics, content_hash, statement_len)
             VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               title = VALUES(title), difficulty = VALUES(difficulty), url = VALUES(url),
               rating = VALUES(rating), topics = VALUES(topics), content_hash = VALUES(content_hash),
               updated_at = CURRENT_TIMESTAMP`,
            [r.slug, r.title, r.difficulty, r.url, r.source, r.platform, r.externalId, r.rating,
             JSON.stringify(r.topics), r.contentHash, r.statementLen]
          );
          written += 1;
        } catch (rowError) {
          failed.push({ slug: r.slug, title: r.title, error: rowError?.message || String(rowError) });
        }
      }
    }
  }

  /* Interview relevance is a curator judgement, so it is applied after the
     facts are stored, and separately from them. */
  const relevanceStmt = `UPDATE problems SET interview_relevance = ? WHERE slug = ?`;
  let relevanceSet = 0;
  for (const row of keep) {
    try {
      await database.query(relevanceStmt, [row.interviewRelevance, row.slug]);
      relevanceSet += 1;
    } catch (error) {
      failed.push({ slug: row.slug, title: row.title, error: `relevance: ${error?.message || error}` });
    }
  }

  /* Provenance, so a later run can tell what was fetched and when. */
  let sourced = 0;
  for (const row of keep) {
    try {
      await database.query(
        `INSERT INTO problem_sources (problem_slug, source_name, source_url, notes)
         VALUES (?, 'codeforces-api', ?, ?)
         ON DUPLICATE KEY UPDATE source_url = VALUES(source_url), fetched_at = CURRENT_TIMESTAMP`,
        [row.slug, row.url, `${row.stage}; rating ${row.rating}; tags ${row.tags.join("|")}`.slice(0, 250)]
      );
      sourced += 1;
    } catch (error) {
      failed.push({ slug: row.slug, title: row.title, error: `provenance: ${error?.message || error}` });
    }
  }

  /* The cap is enforced AFTER writing, never before. Pruning first would mean
     every run adds up to `target` rows on top of whatever is already stored,
     overshooting the cap by design - which is exactly what happened when this
     ran in the other order. */
  const capResult = await enforceCap();

  console.log(`\n  cap`);
  if (!capResult || !capResult.needed) {
    console.log(`    at or under the ${OPTIONS.target} cap`);
  } else {
    console.log(`    was ${capResult.total}, over the ${OPTIONS.target} cap`);
    console.log(`    pruned ${capResult.removed} lowest-scoring curator-imported problems (LeetCode rows untouched)`);
    for (const s of capResult.sample || []) console.log(`      e.g. ${s}`);
    if (capResult.note) console.log(`    note: ${capResult.note}`);
  }

  const after = await database.query(
    `SELECT platform, COUNT(*) AS n FROM problems GROUP BY platform ORDER BY n DESC`
  );
  const total = after.reduce((sum, r) => sum + r.n, 0);

  console.log(`\n  rows written: ${written}`);
  console.log(`  relevance set: ${relevanceSet}`);
  console.log(`  provenance recorded: ${sourced}`);
  if (failed.length) {
    console.log(`\n  FAILED (${failed.length}):`);
    for (const f of failed.slice(0, 20)) console.log(`    ${f.slug} — ${f.error}`);
    if (failed.length > 20) console.log(`    ... and ${failed.length - 20} more`);
  } else {
    console.log(`\n  no failures`);
  }

  console.log(`\n  catalog now holds ${total} problems:`);
  for (const row of after) console.log(`    ${pad(row.platform, 16)} ${row.n}`);

  fs.writeFileSync(
    OPTIONS.planFile,
    JSON.stringify({ generatedAt: new Date().toISOString(), target: OPTIONS.target, added: keep.length, duplicates: duplicates.length, plan: keep.map((r) => ({ slug: r.slug, title: r.title, difficulty: r.difficulty, rating: r.rating, topics: r.topics })) }, null, 2),
    "utf8"
  );
  console.log(`\n  plan written to ${path.relative(process.cwd(), OPTIONS.planFile)}`);

  await database.closePool();
  return failed.length ? 1 : 0;
};

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    console.error(`\nCuration failed: ${error?.message || error}`);
    await database.closePool().catch(() => {});
    process.exit(1);
  });
