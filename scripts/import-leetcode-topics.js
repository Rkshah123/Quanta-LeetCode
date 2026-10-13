/* ---------------------------- import-leetcode-topics --------------------------
 *
 * Fills in the topic tags for LeetCode problems, which are currently empty.
 *
 * Why this exists
 * ---------------
 * The catalog is 2,020 problems: 1,238 Codeforces rows imported with topics,
 * and 782 LeetCode rows with `topics = NULL`. Because the app's search only ever
 * read the title and the URL, typing "Array", "String", "Binary Search",
 * "Linked List", "Stack", "Queue" or "Tree" - the words people actually use to
 * describe what they want to practise - matched nothing. Forty per cent of the
 * catalog could not be found by topic at all.
 *
 * The tags come from LeetCode's own public GraphQL endpoint, the same source the
 * statement importer already uses. Nothing here is guessed: a problem that
 * LeetCode returns no tags for is left empty, and is reported as such.
 *
 * Naming
 * ------
 * LeetCode and Codeforces do not use the same words. "Array" and "Arrays",
 * "Tree" and "Trees", "Heap" and "Heaps" are the same idea spelled two ways, and
 * a search for one has to find the other. So LeetCode's names are mapped onto
 * the vocabulary the app already uses wherever the two mean the same thing.
 *
 * A name with no equivalent in that vocabulary is KEPT as LeetCode spells it -
 * "Matrix", "Bitmask", "Design" - rather than dropped or forced into the nearest
 * bucket. Discarding a real tag loses information, and forcing it under a
 * slightly wrong heading is worse than leaving it exact.
 *
 * Usage
 * -----
 *   node scripts/import-leetcode-topics.js            # fill in what is missing
 *   node scripts/import-leetcode-topics.js --dry-run  # report, write nothing
 *   node scripts/import-leetcode-topics.js --all       # re-check every LeetCode row
 *   node scripts/import-leetcode-topics.js --limit 50  # stop after 50
 *
 * Re-running is safe: a row whose topics already match what LeetCode returns is
 * left alone, and a row it cannot fetch is skipped rather than blanked.
 */

require("dotenv").config();
const { query } = require("../db/pool");

const GRAPHQL_URL = "https://leetcode.com/graphql";
const REQUEST_GAP_MS = 350;
const REQUEST_TIMEOUT_MS = 15000;

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name, fallback) => {
  const at = args.indexOf(name);
  if (at === -1 || at === args.length - 1) return fallback;
  return args[at + 1];
};

const DRY_RUN = hasFlag("--dry-run");
const ALL = hasFlag("--all");
const LIMIT = Number.parseInt(flagValue("--limit", "0"), 10) || 0;

/* LeetCode's tag names mapped onto the vocabulary the app already uses.
   Keys are compared lower-cased. */
const TOPIC_ALIASES = new Map(
  Object.entries({
    array: "Arrays",
    string: "Strings",
    "hash table": "Hashing",
    "hash function": "Hashing",
    hashing: "Hashing",
    "two pointers": "Two Pointers",
    "sliding window": "Sliding Window",
    "prefix sum": "Prefix Sum",
    "binary search": "Binary Search",
    "linked list": "Linked List",
    stack: "Stack",
    queue: "Queue",
    "priority queue": "Heaps",
    heap: "Heaps",
    tree: "Trees",
    "binary tree": "Trees",
    "binary search tree": "BST",
    graph: "Graphs",
    unionfind: "Advanced Graphs",
    "union find": "Advanced Graphs",
    "segment tree": "Advanced Graphs",
    "fenwick tree": "Advanced Graphs",
    backtracking: "Backtracking",
    greedy: "Greedy",
    "dynamic programming": "Dynamic Programming",
    trie: "Tries",
    "bit manipulation": "Bit Manipulation",
    sorting: "Sorting",
    math: "Math",
    "number theory": "Number Theory",
    game: "Probability",
    combinatorics: "Probability"
  }).map(([k, v]) => [k, v])
);

/* Puts one fetched tag into the shared vocabulary. An unknown tag is kept
   exactly as LeetCode spelled it rather than discarded. */
const normaliseTopic = (raw) => {
  const name = String(raw || "").trim();
  if (!name) return "";
  return TOPIC_ALIASES.get(name.toLowerCase()) || name;
};

const normaliseTopics = (list) => {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const label = normaliseTopic(raw);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  /* Sorted so a re-import produces byte-identical JSON and the UPDATE below
     can tell "unchanged" from "changed" without a fuzzy comparison. */
  return out.sort();
};

/* One problem's official tags. Returns null when LeetCode does not answer,
   which is different from answering with an empty list. */
const fetchTags = async (slug) => {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: "https://leetcode.com",
      "User-Agent": "Quanta/1.0 (+local import script)"
    },
    body: JSON.stringify({
      query:
        "query questionTags($titleSlug: String!) { question(titleSlug: $titleSlug) { topicTags { name } } }",
      variables: { titleSlug: slug }
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  /* LeetCode answers 200 with data.question null for a slug it does not know. */
  const tags = payload?.data?.question?.topicTags;
  if (!Array.isArray(tags)) return null;
  return tags.map((tag) => tag?.name).filter(Boolean);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = async () => {
  const where = ALL ? "platform = 'leetcode'" : "platform = 'leetcode' AND (topics IS NULL OR topics = '' OR topics = '[]')";
  const rows = await query(
    `SELECT id, slug, title, topics FROM problems WHERE ${where} ORDER BY lc_num IS NULL, lc_num, slug`
  );

  console.log(`LeetCode rows to check: ${rows.length}${DRY_RUN ? "  (dry run - nothing will be written)" : ""}`);
  if (!rows.length) {
    console.log("Nothing to do.");
    return;
  }

  const summary = { updated: 0, unchanged: 0, empty: 0, failed: 0, skipped: 0 };
  const failures = [];
  const emptySlugs = [];
  const targets = LIMIT ? rows.slice(0, LIMIT) : rows;
  if (LIMIT) console.log(`Stopping after ${LIMIT} rows (--limit).`);

  for (const [index, row] of targets.entries()) {
    let tags = null;
    let failure = null;
    /* One retry: these are transient network failures far more often than real
       ones, and a single retry removes almost all of the noise. */
    for (let attempt = 0; attempt < 2 && failure === null; attempt += 1) {
      try {
        tags = await fetchTags(row.slug);
        failure = null;
      } catch (error) {
        failure = error;
        if (attempt === 0) await sleep(1200);
      }
    }

    if (failure) {
      summary.failed += 1;
      failures.push({ slug: row.slug, title: row.title, error: failure.message });
      process.stdout.write(`\n  ! ${row.slug}: ${failure.message}`);
      await sleep(REQUEST_GAP_MS);
      continue;
    }

    if (tags === null) {
      /* LeetCode has no record under this slug. Left exactly as it was - an
         unknown problem is not a reason to clear a row. */
      summary.skipped += 1;
      await sleep(REQUEST_GAP_MS);
      continue;
    }

    const normalised = normaliseTopics(tags);
    if (!normalised.length) {
      summary.empty += 1;
      emptySlugs.push(row.slug);
      await sleep(REQUEST_GAP_MS);
      continue;
    }

    const existing = (() => {
      try {
        const parsed = JSON.parse(row.topics);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();

    const same =
      existing.length === normalised.length && existing.every((t, i) => String(t) === normalised[i]);

    if (same) {
      summary.unchanged += 1;
      await sleep(REQUEST_GAP_MS);
      continue;
    }

    if (!DRY_RUN) {
      await query("UPDATE problems SET topics = ? WHERE id = ?", [JSON.stringify(normalised), row.id]);
    }
    summary.updated += 1;

    if (index % 25 === 0 || index === targets.length - 1) {
      process.stdout.write(`\n  ${index + 1}/${targets.length} checked, ${summary.updated} to write`);
    }
    await sleep(REQUEST_GAP_MS);
  }

  console.log("\n");
  console.log(`  would write / written : ${summary.updated}`);
  console.log(`  already correct       : ${summary.unchanged}`);
  console.log(`  LeetCode has no tags  : ${summary.empty}`);
  console.log(`  slug not on LeetCode  : ${summary.skipped}`);
  console.log(`  could not fetch       : ${summary.failed}`);

  if (summary.updated) {
    const sample = await query(
      `SELECT slug, title, topics FROM problems WHERE platform = 'leetcode' AND topics IS NOT NULL AND topics <> '' AND topics <> '[]' LIMIT 5`
    );
    console.log("\nSample of what the topics look like now:");
    for (const row of sample) console.log(`  ${row.slug}: ${row.topics}`);
  }

  if (emptySlugs.length) {
    console.log(`\nNo tags from LeetCode for ${emptySlugs.length} row(s): ${emptySlugs.slice(0, 10).join(", ")}${emptySlugs.length > 10 ? " ..." : ""}`);
  }
  if (failures.length) {
    console.log(`\n${failures.length} row(s) could not be fetched:`);
    for (const failure of failures.slice(0, 15)) console.log(`  ${failure.slug} - ${failure.error}`);
    if (failures.length > 15) console.log(`  ... and ${failures.length - 15} more`);
  }
  if (DRY_RUN && summary.updated) {
    console.log("\nDry run. Re-run without --dry-run to write these.");
  }
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\nImport failed: ${error?.message || error}`);
    process.exit(1);
  });
