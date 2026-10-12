/* Removes anything the browser tests wrote to the shared database.

   The browser suites run against the same database the app does, so anything
   they leave behind outlives the run. Used between passes, and before handing
   the database back. */
require("dotenv").config({ path: ".env", quiet: true });
const { query, closePool } = require("../db/pool");

const TEST_COMPANIES = ["quanta-test-co", "e2e-import-co", "none", "none-2"];
const TEST_SLUGS = ["two-sum", "valid-parentheses", "reverse-string"];

const main = async () => {
  const delCompanies = await query(`DELETE FROM companies WHERE slug IN (${TEST_COMPANIES.map(() => "?").join(", ")})`, TEST_COMPANIES);
  const delLinks = await query(`DELETE FROM problem_companies WHERE problem_slug IN (${TEST_SLUGS.map(() => "?").join(", ")})`, TEST_SLUGS);
  const delSolutions = await query(`DELETE FROM problem_solutions WHERE slug IN (${TEST_SLUGS.map(() => "?").join(", ")})`, TEST_SLUGS);
  const delRevisions = await query(`DELETE FROM revision_reviews WHERE slug LIKE 'quanta-%test%'`);

  console.log(`removed ${delCompanies.affectedRows} companies, ${delLinks.affectedRows} links, ${delSolutions.affectedRows} solutions, ${delRevisions.affectedRows} revision rows`);

  for (const table of ["companies", "problem_companies", "problem_solutions", "problem_progress", "problem_runs", "revision_items", "revision_reviews"]) {
    const counted = await query(`SELECT COUNT(*) AS n FROM ${table}`);
    console.log(`  ${table}: ${counted[0].n}`);
  }
  const counted = await query(`SELECT COUNT(*) AS n FROM problems`);
  console.log(`  catalog: ${counted[0].n}`);
  await closePool();
};

main().catch((error) => {
  console.error("cleanup failed:", error.message);
  process.exit(1);
});
