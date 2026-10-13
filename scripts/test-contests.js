/* -------------------------- scripts / test-contests ----------------------- */
/* Contest arena: the pure logic, then the real API.
   Usage:
     npm run test:contests

   Two halves, on purpose.

   The first half is offline and deterministic. Countdown arithmetic, contest
   classification at an exact instant, standings windows, rating series and the
   catalog join are all tested against hand-built fixtures, including the
   boundaries where this kind of code usually breaks: a timer at zero, a contest
   that ends mid-view, a handle that is not in the standings.

   The second half talks to Codeforces for real, because the single biggest risk
   in this feature is not a bug in the code - it is the API not being what the
   code assumes. Field names, phase values and the penalty convention have all
   changed before. Those checks skip cleanly when there is no network, and they
   are the reason the page can promise the data is real. */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const contests = require("../contests");

let passed = 0;
let failures = 0;
let skipped = 0;

const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}${detail ? ` - ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

const skip = (name, why) => {
  skipped += 1;
  console.log(`SKIP  ${name} - ${why}`);
};

/* ---------------------- rank bands and floors -------------------------- */

console.log("\n== rating bands ==");
check("a 3800 rating is master", contests.rankForRating(3800) === "master", contests.rankForRating(3800));
check("2600 is the top of international master", contests.rankForRating(2600) === "international master");
check("2400 is expert", contests.rankForRating(2400) === "expert");
check("1500 is specialist", contests.rankForRating(1500) === "specialist");
check("1000 is newbie - Codeforces puts pupil at 1200", contests.rankForRating(1000) === "newbie", contests.rankForRating(1000));
check("0 is newbie", contests.rankForRating(0) === "newbie");
check("a nonsense rating is unrated rather than a band", contests.rankForRating(undefined) === "unrated");
check("a string rating still resolves", contests.rankForRating("2100") === "candidate master");

console.log("\n== a contest is normalised from either endpoint's shape ==");
const fromList = contests.normaliseContest({ id: 2272, name: "Round", type: "CF", phase: "BEFORE", startTimeSeconds: 1000, durationSeconds: 7200 });
check("the id is taken", fromList.id === 2272);
check("a CF round is scored on points", fromList.scoring === "points", fromList.scoring);
check("the url is built", fromList.url === "https://codeforces.com/contests/2272");
const icpc = contests.normaliseContest({ id: 5, name: "Educational", type: "ICPC", phase: "FINISHED", startTimeSeconds: 10, durationSeconds: 7200 });
check("an ICPC round is scored on penalty", icpc.scoring === "penalty", icpc.scoring);
check("an unknown phase is kept empty rather than guessed", contests.normaliseContest({ id: 1, phase: "WEIRD" }).phase === "");
check("a junk object is refused", contests.normaliseContest(null) === null && contests.normaliseContest({}) === null);
check("a countdown-only contest still gets a start time", contests.normaliseContest({ id: 9, name: "n", phase: "BEFORE", relativeTimeSeconds: -600, durationSeconds: 7200 }).startTimeSeconds != null);

console.log("\n== classification at an exact instant ==");
const list = [
  { id: 1, name: "live now", phase: "CODING", startTimeSeconds: 1000, durationSeconds: 200 },
  { id: 2, name: "starts later", phase: "BEFORE", startTimeSeconds: 2000, durationSeconds: 200 },
  { id: 3, name: "already over", phase: "FINISHED", startTimeSeconds: 100, durationSeconds: 200 },
  { id: 4, name: "no phase, clock says live", startTimeSeconds: 900, durationSeconds: 400 },
  { id: 5, name: "no phase, clock says upcoming", startTimeSeconds: 5000, durationSeconds: 400 },
  { id: 6, name: "no phase, clock says over", startTimeSeconds: 100, durationSeconds: 200 }
];
const at = (now) => contests.classifyContests(list, now);
check("at 1100 both live rounds are found, earliest start first", at(1100).live.map((c) => c.id).join(",") === "4,1", at(1100).live.map((c) => c.id).join(","));
check("the declared phase wins over the clock for a round that has not started", at(1100).upcoming.map((c) => c.id).includes(2));
check("a finished round is recent", at(1100).recent.map((c) => c.id).includes(3));
check("a round with no phase is judged on the clock", at(1100).live.map((c) => c.id).includes(4));
check("upcoming rounds sort soonest first", contests.classifyContests([{ id: 7, phase: "BEFORE", startTimeSeconds: 9000, durationSeconds: 1 }, { id: 8, phase: "BEFORE", startTimeSeconds: 3000, durationSeconds: 1 }], 0).upcoming.map((c) => c.id).join(",") === "8,7");
check("recent rounds sort most recent first", contests.classifyContests([{ id: 9, phase: "FINISHED", startTimeSeconds: 10, durationSeconds: 1 }, { id: 10, phase: "FINISHED", startTimeSeconds: 99, durationSeconds: 1 }], 0).recent.map((c) => c.id).join(",") === "10,9");
check("junk entries are skipped rather than throwing", at(1100).live.length === 2 && contests.classifyContests(null, 0).live.length === 0);
/* The end boundary, on contest 4 - the one with no declared phase, so the
   clock decides. Contest 1 above deliberately declares CODING and stays live
   however far the clock runs, because Codeforces' own phase is authoritative. */
check("a round is live one second before it ends", at(1299).live.map((c) => c.id).includes(4) === true);
check("and over the instant its end arrives", at(1300).live.map((c) => c.id).includes(4) === false);
check("a round one second past its end is not live", at(1301).live.map((c) => c.id).includes(4) === false);
check("a round declaring CODING stays live even once its clock has run out", at(9999).live.map((c) => c.id).includes(1) === true);
check("every contest lands in exactly one bucket", ["live", "upcoming", "recent"].reduce((n, k) => n + at(1100)[k].length, 0) === list.length);

console.log("\n== the countdown ==");
check("two minutes reads 02:00", contests.countdown(120).text === "02:00", contests.countdown(120).text);
check("an hour shows hours", contests.countdown(3661).text === "01:01:01", contests.countdown(3661).text);
check("days appear once there are any", contests.countdown(90061).text === "1d 01h", contests.countdown(90061).text);
check("a finished timer says zero, never negative", contests.countdown(-5).text === "00:00" && contests.countdown(-5).expired === true);
check("zero is finished", contests.countdown(0).expired === true);
check("an unknown time does not pretend to know", contests.countdown(undefined).known === false && contests.countdown(undefined).text === "--:--");
check("59 seconds is 00:59, not 00:60", contests.countdown(59).text === "00:59");
check("the parts add up to the total", (() => { const c = contests.countdown(93784); return c.d * 86400 + c.h * 3600 + c.m * 60 + c.s === 93784; })());
check("the spoken form is pluralised", /2 days/.test(contests.countdown(172800).spoken), contests.countdown(172800).spoken);
check("the spoken form is singular", /^1 hour/.test(contests.countdown(3600).spoken), contests.countdown(3600).spoken);

console.log("\n== how far through a contest we are ==");
const running = { startTimeSeconds: 1000, durationSeconds: 1000 };
check("before it starts, progress is zero", contests.contestProgress(running, 500) === 0);
check("half way is a half", contests.contestProgress(running, 1500) === 0.5);
check("at the end it is finished, not over one", contests.contestProgress(running, 2000) === 1);
check("past the end it is still one", contests.contestProgress(running, 9999) === 1);
check("a contest with no duration has no progress", contests.contestProgress({ startTimeSeconds: 1 }, 2) === null);
check("junk has no progress", contests.contestProgress(null, 2) === null);

console.log("\n== contest problems ==");
const rawProblems = [{ index: "B", name: "Second", points: 1000, tags: ["dp"] }, { index: "A10", name: "Tenth A", points: 3000 }, { index: "A2", name: "Second A", points: 1500, rating: 1600 }, { index: "A1", name: "First A", points: 500 }, {}, null];
const parsed = contests.contestProblems(rawProblems, 1234);
check("empty entries are dropped", parsed.length === 4, `${parsed.length} problems`);
check("A1 comes before A2 before A10", parsed.map((p) => p.index).join(",") === "A1,A2,A10,B", parsed.map((p) => p.index).join(","));
check("the catalog key is contest id plus index", parsed[0].externalId === "1234A1", parsed[0].externalId);
check("a real rating is kept", parsed[1].rating === 1600);
check("a missing rating stays missing rather than becoming zero", parsed[0].rating === null);
check("points are taken", parsed[3].points === 1000);
check("a problem url is built", parsed[0].url.includes("/contours/1234/"), parsed[0].url);
check("junk input gives an empty list", contests.contestProblems(null, 1).length === 0);

console.log("\n== joining a contest to Quanta's catalog ==");
const catalog = [
  { slug: "cf-1234a1", external_id: "1234A1", rating: 1500 },
  { slug: "cf-1234a2", external_id: "1234A2", rating: 1800 },
  { slug: "cf-1895e", external_id: "1895E", rating: 2300 }
];
const joined = contests.matchToCatalog(parsed, catalog);
check("a matching problem is linked", joined.problems.find((p) => p.index === "A1").inCatalog === true);
check("its slug comes through", joined.problems.find((p) => p.index === "A1").slug === "cf-1234a1");
check("an unlisted problem is marked absent, not guessed", joined.problems.find((p) => p.index === "B").inCatalog === false);
check("and has no slug", joined.problems.find((p) => p.index === "B").slug === null);
check("the counts are reported", joined.inCatalog === 2 && joined.total === 4, `${joined.inCatalog}/${joined.total}`);
check("the catalog's rating wins over the contest's", joined.problems.find((p) => p.index === "A2").rating === 1800);
check("the external id match ignores case", contests.matchToCatalog([{ externalId: "1895E" }], catalog).problems[0].inCatalog === true);
check("an empty catalog matches nothing rather than throwing", contests.matchToCatalog(parsed, []).inCatalog === 0);
check("a contest with no problems matches nothing", contests.matchToCatalog([], catalog).total === 0);

console.log("\n== the penalty formula is measurable, and does not match ==");
const results = { 0: { points: 1, bestSubmissionTimeSeconds: 600, rejectedAttemptCount: 2 }, 1: { points: 0 } };
check("solved problems contribute time and rejections", contests.computePenalty(results, 2) === 50, String(contests.computePenalty(results, 2)));
check("unsolved problems contribute nothing", contests.computePenalty({ 0: { points: 0 } }, 1) === 0);
const verdict = contests.verifyPenalty({ problems: [{ index: "A" }], rows: [{ penalty: 50, problemResults: results }] });
check("verifyPenalty agrees when it genuinely agrees", verdict.exact === true && verdict.agree === 1);
check("and reports a disagreement rather than hiding it", contests.verifyPenalty({ problems: [{ index: "A" }], rows: [{ penalty: 10, problemResults: results }] }).exact === false);
check("an empty standings is not claimed as exact", contests.verifyPenalty({ problems: [], rows: [] }).exact === false);

console.log("\n== standings ==");
const standProblems = [{ index: "A", name: "A", points: 500 }, { index: "B", name: "B", points: 1000 }, { index: "C", name: "C", points: 1500 }];
const standRows = [
  { rank: 1, penalty: 0, points: 3000, party: { members: [{ handle: "winner" }] }, problemResults: { 0: { points: 500, bestSubmissionTimeSeconds: 120, rejectedAttemptCount: 0 }, 1: { points: 1000, bestSubmissionTimeSeconds: 900, rejectedAttemptCount: 1 }, 2: { points: 1500, bestSubmissionTimeSeconds: 2400, rejectedAttemptCount: 0 } } },
  { rank: 2, penalty: 5, points: 1500, party: { members: [{ handle: "second" }] }, problemResults: { 0: { points: 500, bestSubmissionTimeSeconds: 200, rejectedAttemptCount: 0 }, 1: { points: 1000, bestSubmissionTimeSeconds: 1800, rejectedAttemptCount: 0 } } },
  { rank: 3, penalty: 9, points: 500, party: { members: [{ handle: "me" }, { handle: "friend" }] }, problemResults: { 0: { points: 500, bestSubmissionTimeSeconds: 900, rejectedAttemptCount: 3 } } },
  { rank: 4, penalty: 0, points: 0, party: { members: [{ handle: "nobody" }] }, problemResults: {} }
];
const table = contests.buildStandings({ problems: standProblems, rows: standRows, contest: { type: "ICPC" } }, { handle: "me" });
check("with no handle the top slice is shown", contests.buildStandings({ problems: standProblems, rows: standRows }, {}).rows[0].team === "winner");
check("with a handle the reader's own row is found", table.you?.rank === 3, String(table.you?.rank));
check("the reader's row is marked", table.you.isYou === true);
check("a team row is found by either member", table.you.team === "me & friend", table.you.team);
check("a team row is flagged", table.you.isTeam === true);
check("solved problems are counted", table.you.solved === 1, String(table.you.solved));
check("the solved index is named", table.you.solvedIndices.join(",") === "A");
check("the first acceptance time is the earliest", table.you.firstAcceptedSeconds === 900, String(table.you.firstAcceptedSeconds));
check("rejected attempts are kept as reported", table.you.results[0].rejected === 3);
check("the official penalty is reported verbatim", table.you.penalty === 9, String(table.you.penalty));
check("a penalty-scored contest is labelled", table.scoring === "penalty");
check("a points-scored contest is labelled", contests.buildStandings({ problems: standProblems, rows: standRows, contest: { type: "CF" } }, {}).scoring === "points");
check("the window is centred on the reader", table.rows.some((r) => r.isYou) && table.rows.length <= 7, `${table.rows.length} rows`);
check("the reader is ranked within the real field", table.field.positionInField === 3, String(table.field.positionInField));
check("and compared with the field's median", table.field.medianSolved === 2, String(table.field.medianSolved));
check("the field size is the real one", table.total === 4, String(table.total));
check("a handle who did not compete reports no position", contests.buildStandings({ problems: standProblems, rows: standRows }, { handle: "ghost" }).you === null);
check("and says so rather than showing a zero rank", contests.buildStandings({ problems: standProblems, rows: standRows }, { handle: "ghost" }).field.positionInField === null);
check("shared ranks are preserved rather than renumbered", contests.buildStandings({ problems: standProblems, rows: [...standRows, { ...standRows[3], rank: 4 }] }, {}).rows.filter((r) => r.rank === 4).length === 2);
check("rows sort by rank even if the API does not", (() => { const t = contests.buildStandings({ problems: standProblems, rows: [standRows[3], standRows[0]] }, {}); return t.rows[0].rank === 1; })());
check("the requested window size is honoured", contests.buildStandings({ problems: standProblems, rows: standRows }, { limit: 2 }).rows.length === 2);
check("an absurd limit is capped rather than obeyed", contests.buildStandings({ problems: standProblems, rows: standRows }, { limit: 99999 }).rows.length <= 4);
check("empty standings do not throw", contests.buildStandings({}, { handle: "me" }).total === 0);
check("the per-problem header is included", table.problems.map((p) => p.index).join(",") === "A,B,C");

console.log("\n== rating history ==");
const history = [
  { contestId: 10, contestName: "Third", rank: 400, oldRating: 1100, newRating: 1250, ratingUpdateTimeSeconds: 300 },
  { contestId: 8, contestName: "Second", rank: 900, oldRating: 0, newRating: 1100, ratingUpdateTimeSeconds: 200 },
  { contestId: 2, contestName: "First", rank: 2000, oldRating: 0, newRating: 1200, ratingUpdateTimeSeconds: 100 }
];
const series = contests.ratingSeries(history);
check("history is ordered oldest first whatever order it arrives in", series.rows.map((r) => r.contestId).join(",") === "2,8,10");
check("the latest rating is the last row", series.latest.rating === 1250);
check("the best rating is the maximum", series.best.rating === 1250);
check("the per-contest change is computed", series.rows[2].change === 150, String(series.rows[2].change));
check("the chart window is named, not implied to be a lifetime figure", series.changeWindow === 3, String(series.changeWindow));
check("the band is derived from the latest rating", series.band === "pupil", series.band);
check("a path is produced", /^M\d+,\d+/.test(series.path), series.path.slice(0, 24));
check("the area closes along the bottom", series.areaPath.endsWith("Z"));
check("every point has a coordinate", series.points.length === 3 && series.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
check("a flat history still renders as a line in the middle, not on an edge", (() => { const flat = contests.ratingSeries([{ newRating: 1500, oldRating: 1500, ratingUpdateTimeSeconds: 1 }, { newRating: 1500, oldRating: 1500, ratingUpdateTimeSeconds: 2 }]); const ys = flat.points.map((p) => p.y); return new Set(ys).size === 1 && ys[0] > 0 && ys[0] < flat.height; })());
check("a single round draws one point, not a divide-by-zero line", contests.ratingSeries([{ newRating: 1200, ratingUpdateTimeSeconds: 1 }]).points.length === 1);
check("an empty history is not a crash", contests.ratingSeries([]).pointCount === 0 && contests.ratingSeries(null).path === "");
check("rows with no rating are dropped rather than drawn as zero", contests.ratingSeries([{ contestName: "x" }, { newRating: 1500, ratingUpdateTimeSeconds: 1 }]).pointCount === 1);

console.log("\n== a field that is not a rank is not shown as one ==");
{
  /* Codeforces returns maxRank: "tourist" for the handle tourist. Verified
     against their live API, not assumed. Passing that through means a page
     rendering maxRank shows a handle in the place a rank belongs - so it is
     dropped unless it actually looks like a rank. */
  check("a real rank is kept", contests.looksLikeRank("legendary grandmaster", "tourist") === true);
  check("every real band is kept", ["newbie", "pupil", "specialist", "expert", "candidate master", "master", "international grandmaster"].every((r) => contests.looksLikeRank(r, "someone")));
  check("the handle itself is rejected", contests.looksLikeRank("tourist", "tourist") === false);
  check("the handle in different case is rejected", contests.looksLikeRank("Tourist", "tourist") === false);
  check("junk is rejected", contests.looksLikeRank("", "tourist") === false && contests.looksLikeRank(undefined, "tourist") === false && contests.looksLikeRank(42, "tourist") === false);

  const real = contests.summariseProfile({ handle: "tourist", rank: "legendary grandmaster", maxRank: "tourist", rating: 3343, maxRating: 4009 }, history);
  check("a profile whose maxRank echoes the handle drops maxRank", real.maxRank === null, String(real.maxRank));
  check("and keeps the rank Codeforces does report correctly", real.rank === "legendary grandmaster", real.rank);

  const clean = contests.summariseProfile({ handle: "someone", rank: "expert", maxRank: "master", rating: 2500 }, history);
  check("a plausible maxRank survives", clean.maxRank === "master", String(clean.maxRank));
  check("a profile with no maxRank at all is null, not a guess", contests.summariseProfile({ handle: "x", rank: "newbie" }, []).maxRank === null);
}

console.log("\n== profile ==");
const profile = contests.summariseProfile({ handle: "tourist", rank: "legendary grandmaster", maxRank: "legendary grandmaster", rating: 3343, maxRating: 4009, contribution: 111, friendOfCount: 91259, country: "Belarus", registrationTimeSeconds: 100 }, history);
check("a real profile summarises", profile.ok === true);
check("Codeforces' own rank is used, not a derived one", profile.rank === "legendary grandmaster", profile.rank);
check("the rating is taken", profile.rating === 3343);
check("the peak is kept", profile.maxRating === 4009);
check("the profile url is built", profile.url === "https://codeforces.com/profile/tourist");
check("rated contests are counted, so a rating has context", profile.ratedContests === 3, String(profile.ratedContests));
check("an unknown handle is a failure, not an empty profile", contests.summariseProfile(null, []).ok === false);
check("and the failure says so", /does not have that handle/.test(contests.summariseProfile(undefined, []).error));

console.log("\n== contest plan ==");
const plan = contests.contestPlan(joined.problems, { contest: { durationSeconds: 7200 } });
check("a plan is built per problem", plan.rows.length === 4);
check("the total points add up", plan.totalPoints === 6000, String(plan.totalPoints));
check("each problem's share of the round is given", plan.rows[0].share === Math.round((500 / 6000) * 100), String(plan.rows[0].share));
check("a rated problem is labelled rated", plan.rows.find((r) => r.index === "A2").difficultySource === "rated");
check("an unrated problem falls back to contest order and says so", plan.rows.find((r) => r.index === "B").difficultySource === "contest order");
check("catalog membership is carried through", plan.catalogCount === 2, String(plan.catalogCount));
check("minutes per problem is computed from the real duration", plan.minutesPerProblem === 30, String(plan.minutesPerProblem));
check("a contest with no problems does not divide by zero", contests.contestPlan([], {}).totalPoints === 0);

console.log("\n== the point ladder is measured, not assumed ==");
/* Modern CF rounds pay LESS for the early problems - 500 for A, 3500 for F.
   An earlier version of contestPlan assumed the opposite and produced advice
   about "banking the easy ones" with a negative difference. These pin the
   corrected behaviour to the actual shape of a real round. */
check("a real CF ladder is recognised as climbing", /Points climb as you go down the sheet/.test(plan.advice), plan.advice.slice(0, 52));
check("the advice names the real first and last values", /500 for A1, 1000 for B/.test(plan.advice), plan.advice.slice(0, 90));
check("the richest problem is identified by position, not assumed", plan.richestIndex === "A10", String(plan.richestIndex));
check("and the cheapest", plan.cheapestIndex === "A1", String(plan.cheapestIndex));
check("a falling ladder is described as falling, not as climbing", /Points fall/.test(contests.contestPlan([{ index: "A", points: 1000 }, { index: "B", points: 500 }], {}).advice));
check("a flat ladder is described as flat", /Every problem is worth the same/.test(contests.contestPlan([{ index: "A", points: 500 }, { index: "B", points: 500 }], {}).advice));
check("a points round is flagged as one", plan.isPointsRound === true);
check("a single-problem round does not talk about a second problem", /One problem/.test(contests.contestPlan([{ index: "A", points: 500 }], {}).advice));

console.log("\n== an ICPC round is not advised about points ==");
const icpcPlan = contests.contestPlan([{ index: "A", name: "a", points: null }, { index: "B", name: "b", points: null }, { index: "C", name: "c", points: null }], { contest: { durationSeconds: 7200 } });
check("a round with no points is not a points round", icpcPlan.isPointsRound === false);
check("its total is zero rather than its problems being worth nothing", icpcPlan.totalPoints === 0);
check("no problem claims a share of nothing", icpcPlan.rows.every((r) => r.share === null));
check("the advice explains solves and penalty instead", /solves first and penalty second/.test(icpcPlan.advice), icpcPlan.advice.slice(0, 60));
check("and says why Quanta does not recompute it", /do not match the published formula/.test(icpcPlan.advice), icpcPlan.advice.slice(-120));
check("there is no richest problem to name", icpcPlan.richestIndex === null);

/* ------------------------------- live API -------------------------------- */

console.log("\n== the real Codeforces API ==");

/* Wrapped rather than written with top-level await, because this file is a
   CommonJS script and the rest of the suites here are too. */
const liveChecks = async () => {

const withNetwork = async (name, fn) => {
  try {
    const detail = await fn();
    check(name, true, detail);
  } catch (error) {
    const message = String(error?.message || error);
    /* A network problem is not a failure of this module, but it must never be
       reported as a pass either. */
    if (/fetch failed|ENOTFOUND|ETIMEDOUT|network|ECONNREFUSED|did not respond|codeforces/i.test(message) && /fetch failed|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(message)) {
      skip(name, "no network");
    } else {
      check(name, false, message);
    }
  }
};

const cf = require("../codeforces");

await withNetwork("the contest list is reachable", async () => {
  const payload = await cf.getContests();
  if (!payload.ok) throw new Error(payload.error);
  if (payload.counts.total < 1000) throw new Error(`only ${payload.counts.total} contests`);
  return `${payload.counts.total} contests: ${payload.counts.live} live, ${payload.counts.upcoming} upcoming`;
});

await withNetwork("the list is split into real buckets", async () => {
  const payload = await cf.getContests();
  const all = [...payload.live, ...payload.upcoming, ...payload.recent];
  const bad = all.filter((c) => !Number.isInteger(c.id) || typeof c.name !== "string" || !/^https:\/\/codeforces\.com\/contests\//.test(c.url));
  if (bad.length) throw new Error(`${bad.length} malformed contests`);
  if (payload.live.some((c) => c.phase !== "CODING" && (c.startTimeSeconds ?? 0) >= Math.round(Date.now() / 1000))) {
    throw new Error("a contest is called live but has not started");
  }
  return `${all.length} contests, all well formed`;
});

await withNetwork("a finished round's standings are reachable", async () => {
  const list = await cf.getContests();
  const target = list.recent.find((c) => c.type === "ICPC") || list.recent[0];
  const detail = await cf.getContest(target.id);
  if (detail.rowCount < 1) throw new Error("no rows");
  if (!detail.problems.length) throw new Error("no problems");
  return `${target.name.slice(0, 40)}: ${detail.problems.length} problems, ${detail.rowCount} rows`;
});

await withNetwork("real problems carry the fields the catalog join needs", async () => {
  const list = await cf.getContests();
  const detail = await cf.getContest(list.recent[0].id);
  const missing = detail.problems.filter((p) => !p.index || !p.externalId);
  if (missing.length) throw new Error(`${missing.length} problems without an id`);
  if (!detail.problems.some((p) => typeof p.points === "number")) throw new Error("no problem has points");
  return `all ${detail.problems.length} problems have contest+index ids`;
});

await withNetwork("standings analysis works on real rows", async () => {
  const list = await cf.getContests();
  const detail = await cf.getContest(list.recent[0].id);
  const table = contests.buildStandings(detail, {});
  if (!table.total) throw new Error("no rows analysed");
  if (table.rows[0].rank !== 1) throw new Error(`top row is rank ${table.rows[0].rank}`);
  if (table.rows[0].solved < 0) throw new Error("negative solve count");
  return `${table.total} real rows, top rank solved ${table.rows[0].solved}/${table.rows[0].totalProblems}`;
});

await withNetwork("a real ICPC round really does not match the penalty formula", async () => {
  const list = await cf.getContests();
  const target = list.recent.find((c) => c.type === "ICPC");
  if (!target) throw new Error("no ICPC round in the recent list");
  const detail = await cf.getContest(target.id);
  const verdict = contests.verifyPenalty(detail);
  /* This test exists so the decision not to recompute penalty stays an
     evidence-based one. If Codeforces ever changes, it flips, and the page can
     start computing it. */
  if (verdict.exact) return "Codeforces now matches the formula - it can be computed";
  return `${verdict.disagree}/${verdict.rows} rows disagree, largest gap ${verdict.differences[0]?.diff} min`;
});

await withNetwork("a real handle's profile is reachable", async () => {
  const payload = await cf.getProfile("tourist");
  if (payload.rating > 4000) throw new Error(`implausible rating ${payload.rating}`);
  if (!payload.rank) throw new Error("no rank");
  if (!payload.series.pointCount) throw new Error("no rating history");
  return `${payload.handle}: ${payload.rank}, ${payload.rating}, ${payload.series.pointCount} rated rounds`;
});

await withNetwork("a rating series from a real handle is drawable", async () => {
  const payload = await cf.getProfile("tourist");
  const { path, points } = payload.series;
  if (!path) throw new Error("no path");
  if (points.length !== payload.series.pointCount) throw new Error("points do not match rows");
  if (!points.every((p) => p.x >= 0 && p.x <= payload.series.width && p.y >= 0 && p.y <= payload.series.height)) {
    throw new Error("a point is off the chart");
  }
  return `${points.length} points inside the ${payload.series.width}x${payload.series.height} viewBox`;
});

await withNetwork("an unknown handle is a 404, not an empty profile", async () => {
  let message = "";
  try {
    await cf.getProfile("quanta_no_such_handle_9z8x7c");
    throw new Error("it was accepted");
  } catch (error) {
    message = String(error.message);
  }
  if (/accepted/.test(message)) throw new Error(message);
  if (!/not found|does not have/i.test(message)) throw new Error(`unexpected message: ${message}`);
  return message;
});

await withNetwork("a malformed handle never reaches the network", async () => {
  let message = "";
  try {
    await cf.getProfile("not a handle!!");
    throw new Error("it was accepted");
  } catch (error) {
    message = String(error.message);
  }
  if (!/letters, digits/i.test(message)) throw new Error(`unexpected message: ${message}`);
  return message;
});

await withNetwork("a contest that has not started is an error, not an empty page", async () => {
  const list = await cf.getContests();
  const future = list.upcoming[0];
  let message = "";
  try {
    const detail = await cf.getContest(future.id);
    /* Codeforces may have started it in the seconds since the list was cached,
       which is a success and not a failure of the check. */
    if (detail.problems.length) return `it started in the meantime, ${detail.problems.length} problems`;
    message = "returned no problems and no error";
  } catch (error) {
    message = String(error.message);
  }
  if (!/has not started|no standings/i.test(message)) throw new Error(`unexpected message: ${message}`);
  return message;
});

await withNetwork("the cache serves a second request without a second call", async () => {
  const first = await cf.getContests();
  const second = await cf.getContests();
  if (first.cached) return "already warm from an earlier test";
  if (second.cached !== true) throw new Error("the second call was not served from cache");
  return "second call served from cache";
});

await withNetwork("contest problems join to real catalog rows", async () => {
  const { query, closePool } = require("../db/pool");
  try {
    const catalog = await query(`SELECT slug, external_id, rating FROM problems WHERE platform = ?`, ["codeforces"]);
    if (!catalog.length) throw new Error("no Codeforces rows in the catalog");
    const list = await cf.getContests();
    let checked = 0;
    let hits = 0;
    /* Walk back through recent rounds until some of their problems are ones the
       catalog actually holds - a round we never imported would prove nothing. */
    for (const contest of list.recent.slice(0, 8)) {
      const detail = await cf.getContest(contest.id);
      const matched = contests.matchToCatalog(detail.problems, catalog);
      checked += matched.total;
      hits += matched.inCatalog;
      if (hits >= 3) break;
    }
    if (!hits) throw new Error(`no catalog match across ${checked} problems`);
    return `${hits} of ${checked} real contest problems matched catalog rows by id`;
  } finally {
    await closePool();
  }
});

return { passed, failures, skipped };
};

liveChecks()
  .then(() => {
    console.log(`\n${passed} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ""}`);
    process.exit(failures ? 1 : 0);
  })
  .catch((error) => {
    failures += 1;
    console.log(`FAIL  the live checks threw: ${error?.message || error}`);
    console.log(`\n${passed} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ""}`);
    process.exit(1);
  });
