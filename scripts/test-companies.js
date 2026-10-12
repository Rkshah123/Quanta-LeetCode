/* ------------------------ scripts / test-companies ---------------------- */
/* Company-wise preparation: parsing, validation and import behaviour.
   Usage:
     npm run test:companies

   The import is the only way company data gets into this app, so the tests
   care most about refusing bad input rather than accepting good input. A
   half-parsed company list is worse than none: it would attribute problems to
   companies that never asked them. */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const companies = require("../db/companies");

let passed = 0;
let failures = 0;

const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

const TEST_SLUG = "two-sum";
const OTHER_SLUG = "valid-parentheses";

const cleanup = async () => {
  const { query } = require("../db/pool");
  await query("DELETE FROM problem_companies WHERE problem_slug IN (?, ?)", [TEST_SLUG, OTHER_SLUG]);
  await query("DELETE FROM companies WHERE slug IN ('quanta-test-co', 'acme-corp')");
};

const main = async () => {
  console.log("\n== slugification ==");
  check("a plain name becomes a slug", companies.slugifyCompany("Amazon") === "amazon");
  check("punctuation is collapsed", companies.slugifyCompany("Meta Platforms, Inc.") === "meta-platforms-inc", companies.slugifyCompany("Meta Platforms, Inc."));
  check("an ampersand becomes 'and' rather than being dropped", companies.slugifyCompany("AT&T") === "at-and-t", companies.slugifyCompany("AT&T"));
  check("casing and padding are irrelevant", companies.slugifyCompany("  aMaZoN  ") === "amazon");
  check("a name with no usable characters becomes empty", companies.slugifyCompany("!!!") === "");
  check("the same company typed differently lands on one slug", companies.slugifyCompany("Google") === companies.slugifyCompany("google "));

  console.log("\n== CSV parsing ==");
  const csv = companies.parseCompanyData("slug,company\ntwo-sum,Amazon\nvalid-parentheses,Google", "team list");
  check("a headed CSV parses", csv.rows.length === 2, `${csv.rows.length} rows`);
  check("the problem slug is taken", csv.rows[0].problemSlug === "two-sum");
  check("the company is taken", csv.rows[0].companyName === "Amazon");
  check("the source is recorded", csv.rows[0].note === "team list", csv.rows[0].note);
  check("confidence defaults to reported", csv.rows[0].confidence === "reported");
  check("nothing is rejected in a clean file", csv.rejected.length === 0);

  const noHeader = companies.parseCompanyData("two-sum,Amazon\nvalid-parentheses,Google");
  check("a CSV with no header row still parses", noHeader.rows.length === 2, `${noHeader.rows.length} rows`);

  const quoted = companies.parseCompanyData('slug,company\ntwo-sum,"Amazon, Inc."');
  check("a quoted company name keeps its comma", quoted.rows[0].companyName === "Amazon, Inc.", quoted.rows[0].companyName);

  const messy = companies.parseCompanyData("slug,company\n\ntwo-sum,Amazon\n\n\nvalid-parentheses,Google\n");
  check("blank lines are ignored", messy.rows.length === 2, `${messy.rows.length} rows`);

  console.log("\n== bad rows are refused, not guessed ==");
  const missingCompany = companies.parseCompanyData("slug,company\ntwo-sum,");
  check("a row with no company is rejected", missingCompany.rows.length === 0);
  check("and the rejection says why", /company name/i.test(missingCompany.rejected[0]?.why || ""), missingCompany.rejected[0]?.why);
  check("the slug is still reported so it can be fixed", missingCompany.rejected[0]?.slug === "two-sum");

  const unusable = companies.parseCompanyData("slug,company\ntwo-sum,!!!");
  check("a company with no usable characters is rejected", unusable.rows.length === 0);
  check("with the characters named in the reason", /no usable characters/.test(unusable.rejected[0]?.why || ""), unusable.rejected[0]?.why);

  const partial = companies.parseCompanyData("slug,company\ntwo-sum,Amazon\n,Orphan\nvalid-parentheses,");
  check("good rows survive alongside bad ones", partial.rows.length === 1, `${partial.rows.length} good rows`);
  check("the bad rows are reported", partial.rejected.length === 2, `${partial.rejected.length} rejected`);
  check("blank slugs are caught", partial.rejected.some((r) => /blank/i.test(r.slug)), JSON.stringify(partial.rejected.map((r) => r.slug)));

  console.log("\n== confidence ==");
  check("a known confidence is kept", companies.parseCompanyData('slug,company,confidence\ntwo-sum,Amazon,curated').rows[0].confidence === "curated");
  check("an unknown confidence falls back to reported", companies.parseCompanyData('slug,company,confidence\ntwo-sum,Amazon,invented').rows[0].confidence === "reported");
  check("only the two real values are accepted", JSON.stringify(companies.CONFIDENCE_VALUES) === '["reported","curated"]');

  console.log("\n== JSON ==");
  const json = companies.parseCompanyData(JSON.stringify([{ slug: "two-sum", company: "Amazon" }]), "api dump");
  check("a JSON array parses", json.rows.length === 1);
  check("the source is recorded", json.rows[0].note === "api dump");
  const wrapped = companies.parseCompanyData(JSON.stringify({ rows: [{ problem: "two-sum", name: "Google" }] }));
  check("an object with a rows array parses", wrapped.rows.length === 1);
  check("and accepts the alternate field names", wrapped.rows[0].problemSlug === "two-sum" && wrapped.rows[0].companyName === "Google");
  const broken = companies.parseCompanyData("{not json");
  check("invalid JSON is refused with a reason", Boolean(broken.error), broken.error);
  const wrongShape = companies.parseCompanyData('{"nope": 1}');
  check("an object with no rows is refused", Boolean(wrongShape.error), wrongShape.error);
  const jsonBad = companies.parseCompanyData('[{"company":"Amazon"}, 42, null]');
  check("an entry with no slug is rejected", jsonBad.rows.length === 0 && jsonBad.rejected.length === 3, JSON.stringify(jsonBad.rejected.map((r) => r.slug)));
  check("non-object entries are named by position", jsonBad.rejected.some((r) => /row 2/.test(r.slug)), JSON.stringify(jsonBad.rejected.map((r) => r.slug)));

  console.log("\n== empty input ==");
  check("empty input is refused", Boolean(companies.parseCompanyData("").error));
  check("whitespace is refused", Boolean(companies.parseCompanyData("   \n  ").error));
  check("a header with no rows is refused", Boolean(companies.parseCompanyData("slug,company").error) || companies.parseCompanyData("slug,company").rows.length === 0);

  console.log("\n== import writes only what Quanta can show ==");
  await cleanup();
  const good = await companies.importCompanyData(
    [
      { problemSlug: TEST_SLUG, companySlug: "quanta-test-co", companyName: "Quanta Test Co", confidence: "reported", note: "team list" },
      { problemSlug: OTHER_SLUG, companySlug: "quanta-test-co", companyName: "Quanta Test Co", confidence: "reported", note: "team list" }
    ],
    "team list"
  );
  check("the import succeeds", good.ok === true, JSON.stringify(good));
  check("both rows linked", good.linked === 2, String(good.linked));
  check("two problems covered", good.problems === 2, String(good.problems));
  check("one company created", good.companies === 1, String(good.companies));

  const listed = await companies.listCompanies();
  const mine = listed.find((c) => c.slug === "quanta-test-co");
  check("the company appears in the listing", Boolean(mine), JSON.stringify(listed.map((c) => c.slug)));
  check("with the real problem count", mine?.problemCount === 2, String(mine?.problemCount));

  const problems = await companies.listCompanyProblems("quanta-test-co");
  check("its problems can be listed", problems.length === 2, `${problems.length} problems`);
  check("each carries its provenance", problems.every((p) => p.source === "team list"), problems[0]?.source);
  check("difficulty comes through for filtering", problems.every((p) => ["Easy", "Medium", "Hard"].includes(p.difficulty)));

  console.log("\n== the difficulty filter really filters ==");
  const easy = await companies.listCompanyProblems("quanta-test-co", { difficulty: "Easy" });
  check("filtering by Easy returns only Easy problems", easy.every((p) => p.difficulty === "Easy"), `${easy.length} returned`);

  console.log("\n== problems Quanta does not have are refused ==");
  const unknown = await companies.importCompanyData(
    [{ problemSlug: "not-a-real-problem-xyz", companySlug: "quanta-test-co", companyName: "Quanta Test Co", confidence: "reported", note: "x" }],
    "x"
  );
  check("an unknown problem is skipped, not linked", unknown.skippedCount === 1, JSON.stringify(unknown.skipped));
  check("the skipped problem is named", unknown.skipped.includes("not-a-real-problem-xyz"), JSON.stringify(unknown.skipped));
  check("and nothing was linked for it", unknown.linked === 0, String(unknown.linked));

  console.log("\n== re-importing updates rather than duplicating ==");
  const again = await companies.importCompanyData(
    [{ problemSlug: TEST_SLUG, companySlug: "quanta-test-co", companyName: "Quanta Test Co", confidence: "curated", note: "verified list" }],
    "verified list"
  );
  check("the second import succeeds", again.ok === true);
  const afterAgain = await companies.listCompanyProblems("quanta-test-co");
  check("the count is unchanged - no duplicate rows", afterAgain.length === 2, `${afterAgain.length} problems`);
  const updated = afterAgain.find((p) => p.slug === TEST_SLUG);
  check("the record was updated in place", updated?.confidence === "curated", updated?.confidence);
  check("and its provenance was updated too", updated?.source === "verified list", updated?.source);

  console.log("\n== empty state ==");
  await cleanup();
  const emptyList = await companies.listCompanies();
  check("with nothing imported the list is empty", !emptyList.some((c) => c.slug === "quanta-test-co"));
  const note = await companies.companiesEmptyNote();
  check("and the reason is given in words", typeof note === "string" && /does not guess/i.test(note), note?.slice(0, 80));

  await cleanup();
  await require("../db/pool").closePool();

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
};

main().catch(async (error) => {
  failures += 1;
  console.log(`FAIL  the suite threw: ${error?.message || error}`);
  try {
    await cleanup();
    await require("../db/pool").closePool();
  } catch {
    /* already closing */
  }
  process.exit(1);
});
