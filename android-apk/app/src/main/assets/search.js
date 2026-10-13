/* ================================ program search =============================
 *
 * How a typed phrase is matched against the problem catalog.
 *
 * Why this is its own file
 * ------------------------
 * It used to live inline in lab-notes.js, where it was one expression inside the
 * filter. That made it impossible to test without a browser, and untested search
 * is how "Array" and "Binary Search" came to return nothing.
 *
 * What changed, and why
 * ---------------------
 * The old matcher looked at the title and the URL. Nothing else. So the words
 * people actually use to describe what they want to practise - Array, String,
 * Linked List, Stack, Queue, Tree, Sorting - matched nothing at all, because
 * those are topic names and topics were never consulted.
 *
 * The rules here:
 *   - case does not matter;
 *   - a half-typed word still matches ("binar" finds "Binary Search");
 *   - "Searching" finds "Binary Search", "Trees" finds "Tree" - endings are
 *     dropped, never added, so nothing broadens a word into a different one;
 *   - every word typed must match something, but not all in the same place, so
 *     "two sum array" finds a problem titled "Two Sum" and tagged Arrays;
 *   - a bare number is still an exact problem number, never a substring.
 *
 * Matches are scored rather than boolean so a title hit can rank above a topic
 * hit. That is the difference between the reader's own words leading the results
 * and an incidental URL match leading them.
 */

const SEARCH_PLATFORM_HINT_MIN = 3;

/* Small, explicit variants of one word, tried in order, used only when the word
   as typed finds nothing.

   Only endings that do not change the meaning are removed, and only from the
   end. Nothing is ever added to a word: "sort" must not quietly become
   "sorting" and start matching things the reader did not ask for. That is the
   whole difference between helpful and wrong here. */
const wordVariants = (word) => {
  const lower = String(word || "").toLowerCase();
  const variants = [lower];
  /* "searching" -> "search", which is contained in "binary search". */
  if (lower.endsWith("ing") && lower.length > 5) variants.push(lower.slice(0, -3));
  /* "arrays" -> "array", "trees" -> "tree". */
  if (lower.endsWith("s") && lower.length > 3) variants.push(lower.slice(0, -1));
  if (lower.endsWith("ed") && lower.length > 4) variants.push(lower.slice(0, -2));
  return [...new Set(variants)];
};

/* Does any of these fields contain any form of this word? */
const anyFieldContains = (fields, word) =>
  wordVariants(word).some((variant) =>
    fields.some((field) => String(field == null ? "" : field).toLowerCase().includes(variant))
  );

/* Topic names, read defensively: a problem from a hand-edited or older stored
   record may have no topics, or topics that are not an array. */
const topicsOf = (problem) => (Array.isArray(problem?.topics) ? problem.topics : []);

/* Note section headings. A problem the reader added themselves has no topics,
   so the words they wrote are the only description of it that exists. */
const sectionTitlesOf = (problem) => {
  const notes = Array.isArray(problem?.notes) ? problem.notes : [];
  return notes.map((note) => note?.title);
};

/* How well one word matches one problem. Higher is better; 0 is no match.
   Returned as a number so callers can both test it and rank by it. */
const scoreWord = (problem, word) => {
  if (anyFieldContains([problem?.name], word)) return 2;
  if (anyFieldContains(topicsOf(problem), word)) return 1;
  /* The slug is part of the external link, so words from the URL find the
     problem too - but only from three characters, because below that a short
     query matches nearly everything and stops being a search. */
  if (String(word || "").length >= SEARCH_PLATFORM_HINT_MIN && anyFieldContains([problem?.url], word)) return 1;
  if (anyFieldContains(sectionTitlesOf(problem), word)) return 1;
  if (anyFieldContains([problem?.platform, problem?.difficulty], word)) return 1;
  return 0;
};

/* Splits what was typed into the words that all have to match. */
const searchTerms = (query) =>
  String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/* A bare number is an exact problem number, never a substring: "51" must not
   match 151, 251 or 2051. The leading "#" people type is decoration and is
   dropped before the comparison. */
const isBareNumber = (query) => {
  const terms = searchTerms(query);
  return terms.length === 1 && /^\d+$/.test(terms[0].replace(/^#/, ""));
};

const exactNumberOf = (query) => searchTerms(query)[0].replace(/^#/, "");

/* Does this problem match the whole query? Every word must match somewhere. */
const matchesQuery = (problem, query) => {
  if (isBareNumber(query)) return String(problem?.num) === exactNumberOf(query);
  const terms = searchTerms(query);
  if (!terms.length) return true;
  return terms.every((term) => scoreWord(problem, term) > 0);
};

/* Total relevance across all the words, for ordering results. */
const scoreQuery = (problem, query) => {
  const terms = searchTerms(query);
  return terms.reduce((sum, term) => sum + scoreWord(problem, term), 0);
};

/* Filters and orders a list in one step.

   Returns the array rather than mutating the input, so the caller's catalog is
   never reordered underneath it. */
const searchProblems = (problems, query) => {
  const list = Array.isArray(problems) ? problems : [];
  const matched = list.filter((problem) => matchesQuery(problem, query));
  if (!searchTerms(query).length) return matched;
  /* A stable sort: problems that score the same keep the order they arrived in,
     which is catalog order, so the reader's chosen sort still applies within a
     score band. */
  return matched
    .map((problem, index) => ({ problem, index, score: scoreQuery(problem, query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.problem);
};

/* ------------------------------ external links ----------------------------- */

/* The label on a problem's external link.

   The catalog holds LeetCode rows and Codeforces rows, so a button reading "Open
   on LeetCode" is simply wrong on the Codeforces ones. The name of a site is the
   one thing about a link that cannot be true for all of them, so the label is
   the same everywhere and only the URL varies. */
const EXTERNAL_LINK_LABEL = "Open in Website";

/* A problem's external URL, or "" when there is not a usable one.

   Used instead of reading problem.url directly because a link with no
   destination is worse than no link: an <a href=""> or href="#" re-opens the
   current page, which reads as a broken button. Relative values and anything
   that is not http(s) are refused rather than resolved, so a malformed stored
   value cannot turn into a link somewhere unexpected - and so a stored
   javascript: or data: value can never become a clickable href.

   In Node, where there is no window to resolve against, the base argument is
   only used to make a relative URL parseable so the protocol check still
   applies. */
const externalUrlOf = (problem, base = "https://localhost/") => {
  const raw = String(problem?.url || "").trim();
  if (!raw || raw === "#") return "";
  /* Refused rather than resolved against the page. A stored value like
     "/problems/two-sum" is a path within whatever app happens to be serving,
     so resolving it here would produce a link back into Quanta itself - a
     working-looking button that goes nowhere useful. Absolute only. */
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  return parsed.href;
};

const SEARCH_API = {
  EXTERNAL_LINK_LABEL,
  externalUrlOf,
  wordVariants,
  anyFieldContains,
  scoreWord,
  searchTerms,
  isBareNumber,
  matchesQuery,
  scoreQuery,
  searchProblems
};

if (typeof window !== "undefined" && window) {
  window.EXTERNAL_LINK_LABEL = EXTERNAL_LINK_LABEL;
  window.externalUrlOf = externalUrlOf;
  window.quantaSearch = SEARCH_API;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SEARCH_API;
}
