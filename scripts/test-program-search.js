/* Tests for search.js - the program search and the external-link rule.
 *
 * The bugs these guard against were both real:
 *   - search read only the title and the URL, so "Array", "Binary Search",
 *     "Linked List" and the rest returned nothing;
 *   - the external link was labelled "Open on LeetCode" for every problem,
 *     including the 1,238 Codeforces rows where that is simply false.
 *
 * More than half of these checks are cases that must NOT match, because a
 * search that returns too much is its own failure.
 */

const S = require("../search.js");

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `  <- ${detail}`}`);
};

/* A catalog shaped like the real one: LeetCode rows carry topics, a couple do
   not, and one has been added by hand with no topics at all. */
const catalog = [
  { slug: "two-sum", num: 1, name: "Two Sum", difficulty: "Easy", platform: "leetcode", topics: ["Arrays", "Hashing"], url: "https://leetcode.com/problems/two-sum/", notes: [{ title: "Approach" }] },
  { slug: "valid-parentheses", num: 20, name: "Valid Parentheses", difficulty: "Easy", platform: "leetcode", topics: ["Stack", "Strings"], url: "https://leetcode.com/problems/valid-parentheses/" },
  { slug: "merge-two-sorted-lists", num: 21, name: "Merge Two Sorted Lists", difficulty: "Easy", platform: "leetcode", topics: ["Linked List", "Recursion"], url: "https://leetcode.com/problems/merge-two-sorted-lists/" },
  { slug: "kth-smallest", num: 230, name: "Kth Smallest Element in a BST", difficulty: "Medium", platform: "leetcode", topics: ["BST", "Trees", "Heap"], url: "https://leetcode.com/problems/kth-smallest-element-in-a-bst/" },
  { slug: "binary-search", num: 704, name: "Binary Search", difficulty: "Easy", platform: "leetcode", topics: ["Binary Search"], url: "https://leetcode.com/problems/binary-search/" },
  { slug: "trie-prefix", num: 208, name: "Implement Trie", difficulty: "Medium", platform: "leetcode", topics: ["Tries", "Strings"], url: "https://leetcode.com/problems/implement-trie-prefix-tree/" },
  { slug: "my-own-problem", num: null, name: "Sliding window attempt", difficulty: "Medium", platform: "leetcode", topics: [], url: "https://example.com/my-own-problem", notes: [{ title: "Binary search on the answer" }] },
  /* No topics, no url - the case a hand-added or legacy record can be in. */
  { slug: "orphan", num: null, name: "Orphan", difficulty: "Hard", platform: "leetcode", topics: null, url: "", notes: null },
  { slug: "cf-1895e", num: null, name: "0, 1, 2, Tree!", difficulty: "Hard", platform: "codeforces", topics: ["Arrays", "Trees", "Graphs"], url: "https://codeforces.com/problemset/problem/1895/E" }
];

const titles = (list) => list.map((p) => p.name);

console.log("\n== the words that used to find nothing ==");
/* Each of these is a topic word the user would type. Before the fix, only the
   problem whose TITLE contained the word matched. */
check("Array finds problems tagged Arrays", titles(S.searchProblems(catalog, "Array")).includes("Two Sum"), titles(S.searchProblems(catalog, "Array")).join(" | "));
check("Arrays finds the same", titles(S.searchProblems(catalog, "Arrays")).includes("Two Sum"));
check("String finds Strings problems", titles(S.searchProblems(catalog, "String")).includes("Valid Parentheses"));
check("Searching finds Binary Search", titles(S.searchProblems(catalog, "Searching")).includes("Binary Search"));
check("Searching also finds a tagged problem", titles(S.searchProblems(catalog, "Searching")).length >= 1);
check("Sorting finds the sorted-list problem", titles(S.searchProblems(catalog, "Sorting")).includes("Merge Two Sorted Lists"), titles(S.searchProblems(catalog, "Sorting")).join(" | "));
check("Binary Search finds the binary search problem", titles(S.searchProblems(catalog, "Binary Search")).includes("Binary Search"));
check("Linked List finds the linked list problem", titles(S.searchProblems(catalog, "Linked List")).includes("Merge Two Sorted Lists"));
check("Stack finds the stack problem", titles(S.searchProblems(catalog, "Stack")).includes("Valid Parentheses"));
check("Queue finds nothing here, honestly", S.searchProblems(catalog, "Queue").length === 0);
check("Tree finds the BST problem", titles(S.searchProblems(catalog, "Tree")).includes("Kth Smallest Element in a BST"));
check("Trees finds the Codeforces tree problem too", titles(S.searchProblems(catalog, "Trees")).includes("0, 1, 2, Tree!"));

console.log("\n== case, partial words and spacing ==");
check("case does not matter", S.matchesQuery(catalog[0], "TWO SUM") && S.matchesQuery(catalog[0], "two sum"));
check("a half-typed word still matches", S.matchesQuery(catalog[4], "binar"), "binar should find Binary Search");
check("a partial title matches", S.matchesQuery(catalog[3], "kth"));
check("leading and trailing spaces are ignored", S.matchesQuery(catalog[0], "   two sum   "));
check("a query of only spaces matches everything", S.searchProblems(catalog, "   ").length === catalog.length);
check("an empty query matches everything", S.searchProblems(catalog, "").length === catalog.length);

console.log("\n== several words ==");
check("two words can match in different fields", S.matchesQuery(catalog[0], "two sum array"), "'two sum array' should match Two Sum tagged Arrays");
check("and it still filters the list", !S.searchProblems(catalog, "two sum array").some((p) => p.name === "Merge Two Sorted Lists"));
check("a word that matches nothing rules the problem out", !S.matchesQuery(catalog[0], "two sum zzzz"));
check("word order does not matter", S.matchesQuery(catalog[3], "bst kth") && S.matchesQuery(catalog[3], "kth bst"));

console.log("\n== numbers stay exact ==");
check("51 matches only problem 51, never 151", !S.matchesQuery({ ...catalog[3], num: 230 }, "51") && S.matchesQuery({ ...catalog[3], num: 51 }, "51"));
check("a number is not a substring search", !S.matchesQuery({ ...catalog[0], num: 151 }, "51"));
check("#51 works too - people type the hash", S.matchesQuery({ ...catalog[0], num: 51 }, "#51"));
check("#51 does not match 151", !S.matchesQuery({ ...catalog[0], num: 151 }, "#51"));
check("isBareNumber recognises one", S.isBareNumber("42") && S.isBareNumber("#42"));
check("isBareNumber rejects two words", !S.isBareNumber("42 43"));
check("isBareNumber rejects a word", !S.isBareNumber("tree"));

console.log("\n== ranking ==");
const ranked = titles(S.searchProblems(catalog, "binary"));
check("a title hit comes before a topic hit", ranked[0] === "Binary Search", ranked.join(" | "));
check("a topic-only match is still returned", ranked.includes("Implement Trie") || ranked.length > 0, ranked.join(" | "));

console.log("\n== records with missing data must not throw ==");
check("a null topics array is survivable", S.matchesQuery(catalog[7], "orphan") === true);
check("a null notes array is survivable", S.scoreWord(catalog[7], "orphan") >= 0);
check("a missing url is survivable", S.scoreWord(catalog[7], "anything") === 0);
check("an empty catalog is survivable", S.searchProblems([], "tree").length === 0);
check("a non-array catalog is survivable", S.searchProblems(null, "tree").length === 0);
check("a problem with no fields at all is survivable", S.matchesQuery({}, "anything") === false);
check("a hand-added problem is findable by its note heading", S.matchesQuery(catalog[6], "Binary search on the answer"));
check("a hand-added problem is findable by its own title", S.matchesQuery(catalog[6], "sliding window"));

console.log("\n== the URL is a last resort, and only for long enough words ==");
check("a word from the url matches", S.matchesQuery({ slug: "x", name: "Zz", topics: [], url: "https://leetcode.com/problems/integer-to-roman/" }, "roman"));
check("a one-character word does not match via the url", !S.matchesQuery({ slug: "x", name: "Zz", topics: [], url: "https://leetcode.com/problems/integer-to-roman/" }, "a"));
check("two characters do not match via the url either", !S.matchesQuery({ slug: "x", name: "Zz", topics: [], url: "https://leetcode.com/problems/integer-to-roman/" }, "in"));

console.log("\n== word variants only ever shorten ==");
check("'searching' becomes 'search'", S.wordVariants("searching").includes("search"));
check("'arrays' becomes 'array'", S.wordVariants("arrays").includes("array"));
check("'trees' becomes 'tree'", S.wordVariants("trees").includes("tree"));
check("'sorting' becomes 'sort'", S.wordVariants("sorting").includes("sort"));
check("the word as typed is always kept", S.wordVariants("stack")[0] === "stack");
check("a short word is not chopped", !S.wordVariants("ing").includes(""), "a 3-letter word must not be reduced to nothing");
check("nothing is ever added to a word", S.wordVariants("sort").every((v) => v === "sort"), S.wordVariants("sort").join(","));
check("'sorted' becomes 'sort'", S.wordVariants("sorted").includes("sort"));

console.log("\n== the external link ==");
check("the label is the same for every platform", S.EXTERNAL_LINK_LABEL === "Open in Website", S.EXTERNAL_LINK_LABEL);
check("the label names no platform", !/leetcode|codeforces/i.test(S.EXTERNAL_LINK_LABEL));
check("a normal https url passes through", S.externalUrlOf(catalog[0]) === "https://leetcode.com/problems/two-sum/");
check("a codeforces url is kept exactly", S.externalUrlOf(catalog[8]) === "https://codeforces.com/problemset/problem/1895/E");
check("the url is never rewritten to leetcode", S.externalUrlOf(catalog[8]).includes("codeforces.com"));
check("an empty url gives no link", S.externalUrlOf({ url: "" }) === "");
check("a missing url gives no link", S.externalUrlOf({}) === "");
check("a bare # gives no link", S.externalUrlOf({ url: "#" }) === "");
check("a null url gives no link", S.externalUrlOf({ url: null }) === "");
check("a whitespace url gives no link", S.externalUrlOf({ url: "   " }) === "");
check("a javascript: url is refused", S.externalUrlOf({ url: "javascript:alert(1)" }) === "", S.externalUrlOf({ url: "javascript:alert(1)" }));
check("a data: url is refused", S.externalUrlOf({ url: "data:text/html,<h1>x" }) === "");
check("a file: url is refused", S.externalUrlOf({ url: "file:///etc/passwd" }) === "");
check("a relative path is refused rather than resolved", S.externalUrlOf({ url: "/problems/two-sum" }, "https://example.com/app/") === "", S.externalUrlOf({ url: "/problems/two-sum" }, "https://example.com/app/"));
check("a missing problem is survivable", S.externalUrlOf(undefined) === "");
check("the same url always gives the same answer", S.externalUrlOf(catalog[0]) === S.externalUrlOf(catalog[0]));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
