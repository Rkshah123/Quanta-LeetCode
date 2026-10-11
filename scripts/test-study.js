/* --------------------------- scripts / test-study ------------------------ */
/* Tests for study notes and saved solutions.
   Usage:
     npm run test:study

   Layer 1: pure functions (tag normalisation, text limits, slug rules).
   Layer 2: the real repository against the real database, using dedicated test
     slugs ("quanta-study-test-*"). The test refuses to run if they already
     exist and removes exactly the rows it created, so real notes and solutions
     are never touched.

   A note on truthfulness: nothing here checks whether a solution is correct.
   The runner has no access to a problem's hidden tests, so the tests only
   verify storage, revisions, conflicts, isolation and search. */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const { query, closePool } = require("../db/pool");
const study = require("../db/study");

const TEST_SLUGS = ["quanta-study-test-a", "quanta-study-test-b", "quanta-study-test-c"];
const keepRows = process.argv.includes("--keep-rows");

let passed = 0;
let failures = 0;
const createdSolutionIds = [];

const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};
const equal = (name, actual, expected) =>
  check(name, actual === expected, actual === expected ? String(actual) : `expected ${expected}, got ${actual}`);

/* Arrays and objects need a deep comparison; === would always fail on them. */
const same = (name, actual, expected) =>
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual) === JSON.stringify(expected) ? JSON.stringify(actual) : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );

const clean = async () => {
  for (const id of createdSolutionIds.splice(0)) {
    await query("DELETE FROM problem_solutions WHERE id = ? AND owner_key = ?", [id, study.STUDY_OWNER]);
  }
  await query("DELETE FROM problem_notes WHERE owner_key = ? AND slug IN (?)", [study.STUDY_OWNER, TEST_SLUGS]);
  await query("DELETE FROM problem_solutions WHERE owner_key = ? AND slug IN (?)", [study.STUDY_OWNER, TEST_SLUGS]);
};

const testPure = () => {
  console.log("\n-- tags --");
  same("tags lowercased and trimmed", study.normalizeTags([" Array ", "HashMap"]), ["array", "hashmap"]);
  same("duplicates removed", study.normalizeTags(["array", "ARRAY", " array "]), ["array"]);
  same("comma string accepted", study.normalizeTags("one, two ,two"), ["one", "two"]);
  same("empty entries dropped", study.normalizeTags(["", "   ", null]), []);
  same("non-list ignored", study.normalizeTags(null), []);
  const many = study.normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`));
  equal("tag list is capped", many.length, 12);
  equal("long tag is shortened", study.normalizeTags(["x".repeat(80)])[0].length, 32);

  console.log("\n-- slugs and text --");
  equal("slug normalised", study.normalizeSlug(" Two-Sum "), "two-sum");
  equal("slug with spaces refused", study.normalizeSlug("two sum"), "");
  equal("slug with symbols refused", study.normalizeSlug("two_sum!"), "");
  equal("text is truncated to the limit", study.cleanText("x".repeat(200), 50).length, 50);
  equal("language defaults to java", study.normalizeLanguage(""), "java");
  equal("language lowercased", study.normalizeLanguage("  Python "), "python");
  equal("limit capped", study.clampLimit(9999), 100);
  equal("bad limit falls back", study.clampLimit("abc"), 50);
};

/* Creates a problem_notes row owned by somebody else, to prove the queries that
   read the owner's own data never see it. */
const createForeignRow = async () => {
  await query(
    "INSERT INTO problem_notes (owner_key, slug, title, approach) VALUES ('other-owner', 'quanta-study-test-a', 'Private note', 'Private approach')"
  );
  await query(
    "INSERT INTO problem_solutions (owner_key, slug, title, language, code) VALUES ('other-owner', 'quanta-study-test-a', 'Private solution', 'java', 'class Private {}')"
  );
};

const removeForeignRow = async () => {
  await query("DELETE FROM problem_notes WHERE owner_key = 'other-owner'");
  await query("DELETE FROM problem_solutions WHERE owner_key = 'other-owner'");
};

const testRepository = async () => {
  console.log("\n-- preconditions --");
  await clean();
  const before = await query(
    "SELECT COUNT(*) AS n FROM problem_notes WHERE owner_key = ? AND slug IN (?)",
    [study.STUDY_OWNER, TEST_SLUGS]
  );
  equal("test slugs are free", Number(before[0].n), 0);

  console.log("\n-- notes: create, read, update --");
  equal("missing note reads as null", await study.getNote(TEST_SLUGS[0]), null);

  const created = await study.saveNote({
    slug: TEST_SLUGS[0],
    title: "Two Sum study",
    approach: "Hash map, one pass.",
    observations: "Store value -> index.",
    edgeCases: "Empty array.",
    timeComplexity: "O(n)",
    spaceComplexity: "O(n)",
    tags: ["array", "hashmap"],
    sections: [{ id: "s1", title: "Approach", html: "<p>hi</p>", collapsed: false }]
  });
  check("note created without conflict", created.conflict === false);
  equal("first revision is 1", created.note.revision, 1);
  equal("tags normalised", created.note.tags.join(","), "array,hashmap");
  equal("sections kept", created.note.sections.length, 1);
  equal("edge cases stored", created.note.edgeCases, "Empty array.");

  const read = await study.getNote(TEST_SLUGS[0]);
  equal("note reads back identically", read.approach, "Hash map, one pass.");

  const wrongRevision = await study.saveNote({ slug: TEST_SLUGS[0], title: "stale", baseRevision: 99 });
  equal("stale write is refused", wrongRevision.conflict, true);
  equal("refused write returns the server copy", wrongRevision.server.title, "Two Sum study");
  equal("refused write did not change the note", (await study.getNote(TEST_SLUGS[0])).title, "Two Sum study");

  const noBase = await study.saveNote({ slug: TEST_SLUGS[0], title: "second try", baseRevision: 0 });
  equal("creating over an existing note is refused", noBase.conflict, true);

  const second = await study.saveNote({ slug: TEST_SLUGS[0], title: "Two Sum study v2", baseRevision: 1 });
  equal("correct revision updates", second.conflict, false);
  equal("revision increases", second.note.revision, 2);

  const replay = await study.saveNote({ slug: TEST_SLUGS[0], title: "replay", baseRevision: 1 });
  equal("replaying an old revision is refused", replay.conflict, true);
  equal("replay leaves the note alone", (await study.getNote(TEST_SLUGS[0])).title, "Two Sum study v2");

  const missingServer = await study.saveNote({ slug: TEST_SLUGS[2], title: "gone", baseRevision: 5 });
  equal("a note deleted elsewhere is reported as missing", missingServer.reason, "missing");

  console.log("\n-- solutions: several per problem --");
  const one = await study.createSolution({
    slug: TEST_SLUGS[0],
    clientId: "study-test-client-1",
    title: "Hash map",
    language: "java",
    code: "class Solution { }",
    explanation: "Single pass.",
    timeComplexity: "O(n)",
    spaceComplexity: "O(n)"
  });
  createdSolutionIds.push(one.solution.id);
  equal("solution created", one.created, true);
  equal("first solution revision is 1", one.solution.revision, 1);
  equal("language kept", one.solution.language, "java");

  const two = await study.createSolution({
    slug: TEST_SLUGS[0],
    clientId: "study-test-client-2",
    title: "Brute force",
    language: "python",
    code: "def solve():\n    return 0\n"
  });
  createdSolutionIds.push(two.solution.id);

  const three = await study.createSolution({
    slug: TEST_SLUGS[1],
    clientId: "study-test-client-3",
    title: "Second problem",
    language: "cpp",
    code: "int main() { return 0; }"
  });
  createdSolutionIds.push(three.solution.id);

  const retry = await study.createSolution({
    slug: TEST_SLUGS[0],
    clientId: "study-test-client-1",
    title: "Hash map",
    language: "java",
    code: "class Solution { }"
  });
  equal("retrying a create does not duplicate", retry.created, false);
  equal("retry returns the same solution", retry.solution.id, one.solution.id);

  const list = await study.listSolutions({ slug: TEST_SLUGS[0] });
  equal("two solutions for the problem", list.total, 2);
  check(
    "both languages kept",
    list.items.map((item) => item.language).sort().join(",") === "java,python",
    list.items.map((item) => item.language).join(",")
  );
  equal("other problem is not listed", (await study.listSolutions({ slug: TEST_SLUGS[1] })).total, 1);
  equal("unknown problem has none", (await study.listSolutions({ slug: "no-such-problem" })).total, 0);

  console.log("\n-- solutions: update, conflicts, delete --");
  const staleUpdate = await study.updateSolution(one.solution.id, { title: "stale", code: "x", baseRevision: 42 });
  equal("stale solution update refused", staleUpdate.conflict, true);
  equal("refused update returns the server copy", staleUpdate.server.title, "Hash map");

  const goodUpdate = await study.updateSolution(one.solution.id, {
    title: "Hash map v2",
    code: "class Solution { int f() { return 1; } }",
    explanation: "Updated.",
    baseRevision: 1
  });
  equal("correct revision updates the solution", goodUpdate.conflict, false);
  equal("solution revision increases", goodUpdate.solution.revision, 2);
  equal("edited code stored", goodUpdate.solution.code.includes("int f()"), true);

  equal("unknown solution id reports missing", (await study.updateSolution(999999999, { code: "x", baseRevision: 1 })).notFound, true);
  equal("deleting an unknown solution returns false", await study.deleteSolution(999999999), false);

  console.log("\n-- user isolation --");
  await createForeignRow();
  const mine = await study.getNote(TEST_SLUGS[0]);
  equal("another owner's note is not visible", mine.title, "Two Sum study v2");
  equal("another owner's solution is not listed", (await study.listSolutions({ slug: TEST_SLUGS[0] })).total, 2);
  const searchResults = await study.searchStudy({ q: "Private" });
  equal("search never returns another owner's note", searchResults.filter((r) => r.title === "Private note").length, 0);
  equal("search never returns another owner's solution", searchResults.filter((r) => r.title === "Private solution").length, 0);
  await removeForeignRow();

  console.log("\n-- search --");
  const byText = await study.searchStudy({ q: "Hash map" });
  check("text search finds the solution", byText.some((item) => item.title === "Hash map v2"), `hits: ${byText.length}`);
  const byLanguage = await study.searchStudy({ language: "python" });
  equal("language filter", byLanguage.length, 1);
  equal("language filter returns only that language", byLanguage[0].language, "python");
  const byTag = await study.searchStudy({ tag: "hashmap" });
  check("tag search finds the note", byTag.some((item) => item.kind === "note"), `hits: ${byTag.length}`);
  const byComplexity = await study.searchStudy({ q: "O(n)" });
  check("complexity text is searchable", byComplexity.length > 0, `hits: ${byComplexity.length}`);
  equal("no filters returns nothing", (await study.searchStudy({})).length, 0);

  console.log("\n-- large payloads --");
  const bigCode = Array.from({ length: 5000 }, (_, i) => `int line${i} = ${i};`).join("\n");
  const big = await study.createSolution({ slug: TEST_SLUGS[2], title: "Large", language: "java", code: bigCode });
  createdSolutionIds.push(big.solution.id);
  equal("large code stored whole", big.solution.code.length, bigCode.length);
  equal("large code unchanged", big.solution.code === bigCode, true);

  const longText = study.cleanText("x".repeat(100000), 60000);
  equal("free text is bounded", longText.length, 60000);

  console.log("\n-- deletion --");
  equal("delete removes the solution", await study.deleteSolution(two.solution.id), true);
  equal("deleted solution is gone", (await study.listSolutions({ slug: TEST_SLUGS[0] })).total, 1);
  equal("delete note reports true", await study.deleteNote(TEST_SLUGS[0]), true);
  equal("deleted note reads as null", await study.getNote(TEST_SLUGS[0]), null);
  equal("deleting a note twice reports false", await study.deleteNote(TEST_SLUGS[0]), false);
};

const main = async () => {
  testPure();
  try {
    await testRepository();
  } catch (error) {
    failures += 1;
    console.log(`FAIL  repository tests threw: ${error?.message || error}`);
  } finally {
    if (!keepRows) {
      try {
        await clean();
        await removeForeignRow();
        console.log("\ncleanup: test rows removed");
      } catch (error) {
        console.log(`\ncleanup failed: ${error?.message || error}`);
      }
    } else {
      console.log("\ncleanup skipped (--keep-rows)");
    }
    await closePool();
  }
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
};

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});