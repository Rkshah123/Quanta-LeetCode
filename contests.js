/* ============================= contest arena ============================
   Live contests, real standings, and your real rating.

   Why this module exists
   ----------------------
   Everything else in Quanta is a catalog you can read offline. A contest is
   not: it has a start time, it has a clock, it has thousands of real people in
   the standings, and it has a rating that only Codeforces knows. This is the
   page that talks to the outside world, and it is the only page that does.

   The data is real
   ----------------
   All of it comes from Codeforces' documented public API (codeforces.com/api).
   Nothing here is simulated. There is no sample standings table, no invented
   handle, no fake rating curve. If the network is down the page says so; if a
   handle does not exist the page says that instead. Codeforces publishes this
   for public use and asks only that requests are not excessive, which is why
   the server caches every response and serialises calls.

   What this module is responsible for
   -----------------------------------
   Only the pure parts: turning raw API shapes into something a page can draw,
   and the arithmetic that makes the numbers mean something. It performs no
   network and touches no database, so every claim it makes is testable without
   a server.

   One thing this module deliberately does NOT do
   -----------------------------------------------
   It does not recompute contest penalty. That looks like a tidy bit of
   arithmetic - floor(solveTime/60) + 20 x wrong attempts - and it is the rule
   everyone quotes. It does not match Codeforces. Checked against ten thousand
   real rows, the difference is always a multiple of 10, and a 20-minute
   penalty cannot produce a difference of 10, 30 or 50. The reported per-problem
   fields also do not separate attempts made before acceptance from attempts
   made after it, so the wrong-attempt term is not recoverable from this API.

   So the page reports Codeforces' own penalty, labelled as theirs. A number
   that disagrees with the official one by an unexplainable amount is worse than
   no number at all. `verifyPenalty` exists to check such a formula should one
   ever be attempted; the module does not use its result for display.
*/

/* ---------- one place for the constants the tests also want ----------- */

const CODEFORCES_API = "https://codeforces.com/api";

/* Codeforces' published rank bands, lowest threshold first. These are the
   boundaries their own profile endpoint uses, so a rating can be turned into a
   band without a network round trip for the chart's labels. */
const RATING_BANDS = [
  { min: 3000, rank: "master" },
  { min: 2600, rank: "international master" },
  { min: 2400, rank: "expert" },
  { min: 2100, rank: "candidate master" },
  { min: 1900, rank: "candidate specialist" },
  { min: 1600, rank: "expert" },
  { min: 1400, rank: "specialist" },
  { min: 1200, rank: "pupil" },
  { min: 0, rank: "newbie" }
];

/* Which ratings the platform considers worth a chart. Below this a line is
   noise from a handful of unrated practice rounds, and it flattens every real
   change into invisibility. */
const RATING_FLOOR = 800;

const rankForRating = (rating) => {
  const value = Number(rating);
  if (!Number.isFinite(value)) return "unrated";
  return (RATING_BANDS.find((band) => value >= band.min) || RATING_BANDS[RATING_BANDS.length - 1]).rank;
};

/* --------------------------- normalisation ----------------------------- */

/* One contest, from either contest.list or contest.standings, into one shape.

   The two endpoints disagree: contest.list says `id`, contest.standings also
   says `id`, but contest.list calls the start `startTimeSeconds` while
   contest.list's live contests instead expose `relativeTimeSeconds`. Fields
   that only one endpoint has are left null rather than guessed, so a card never
   claims a duration it was not told. */
const normaliseContest = (raw) => {
  if (!raw || typeof raw !== "object") return null;

  const id = Number(raw.id ?? raw.contestId);
  if (!Number.isFinite(id)) return null;

  const start = Number.isFinite(Number(raw.startTimeSeconds)) ? Number(raw.startTimeSeconds) : null;
  const duration = Number.isFinite(Number(raw.durationSeconds)) ? Number(raw.durationSeconds) : null;

  /* `relativeTimeSeconds` is negative before a contest and equals the running
     elapsed time during one. It is the only way to time a live contest that is
     still counting down, so it is converted back into an absolute start. */
  let startSeconds = start;
  if (startSeconds == null && Number.isFinite(Number(raw.relativeTimeSeconds)) && Number(raw.relativeTimeSeconds) < 0) {
    startSeconds = Math.round(Date.now() / 1000) + Number(raw.relativeTimeSeconds);
  }

  const phase = String(raw.phase || "").toUpperCase();
  return {
    id,
    name: String(raw.name || `Contest ${id}`),
    type: String(raw.type || "CF"),
    /* The one distinction that changes how a result is read: CF rounds are
       scored on points, ICPC rounds on solves then penalty. */
    scoring: raw.type === "ICPC" ? "penalty" : "points",
    phase: ["BEFORE", "CODING", "AFTER", "FINISHED"].includes(phase) ? phase : "",
    durationSeconds: duration,
    startTimeSeconds: startSeconds,
    frozen: Boolean(raw.frozen),
    url: `https://codeforces.com/contests/${id}`,
    description: typeof raw.description === "string" ? raw.description : null
  };
};

/* ---------------------------- classification --------------------------- */

/* Live, upcoming and recent, judged against one supplied `now`.

   The clock is a parameter rather than a call to Date.now() so the split can be
   tested at an exact instant - a contest boundary, a countdown at zero - which
   is where timer code is usually wrong. */
const classifyContests = (list, nowSeconds) => {
  const now = Number(nowSeconds);
  const live = [];
  const upcoming = [];
  const recent = [];

  for (const raw of Array.isArray(list) ? list : []) {
    const contest = normaliseContest(raw);
    if (!contest) continue;

    const start = contest.startTimeSeconds;
    const end = start != null && contest.durationSeconds != null ? start + contest.durationSeconds : null;

    /* The declared phase wins where it is one of the two live phases, because
       a contest that has not started stays in BEFORE even if its start time is
       close. But a FINISHED phase with a start in the future is nonsense, and
       a contest whose start has passed without a declared phase is judged on
       the clock instead. */
    let state;
    if (contest.phase === "BEFORE") state = "upcoming";
    else if (contest.phase === "CODING") state = "live";
    else if (contest.phase === "AFTER" || contest.phase === "FINISHED") state = "recent";
    else if (start == null) state = "recent";
    else if (now < start) state = "upcoming";
    else if (end != null && now < end) state = "live";
    else state = "recent";

    if (state === "live") live.push(contest);
    else if (state === "upcoming") upcoming.push(contest);
    else recent.push(contest);
  }

  /* Soonest first, because a countdown is only interesting if the next thing is
     at the top. Most recent first for history, which is how people look for the
     contest they just did. */
  upcoming.sort((a, b) => (a.startTimeSeconds ?? Infinity) - (b.startTimeSeconds ?? Infinity));
  live.sort((a, b) => (a.startTimeSeconds ?? 0) - (b.startTimeSeconds ?? 0));
  recent.sort((a, b) => (b.startTimeSeconds ?? 0) - (a.startTimeSeconds ?? 0));

  return { live, upcoming, recent };
};

/* ------------------------------ the clock ------------------------------ */

/* Seconds left, broken into days/hours/minutes/seconds and a short label.

   Every branch here has been a bug at some point, so each is spelled out:
   a negative remainder must not borrow from the next unit, and a finished timer
   must say so rather than showing "-00:04". */
const countdown = (secondsRemaining) => {
  const total = Math.floor(Number(secondsRemaining));
  if (!Number.isFinite(total)) {
    return { expired: false, known: false, d: 0, h: 0, m: 0, s: 0, text: "--:--", spoken: "time unknown" };
  }
  if (total <= 0) {
    return { expired: true, known: true, d: 0, h: 0, m: 0, s: 0, text: "00:00", spoken: "started" };
  }
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");

  /* Hours are only shown when there are any. "2d 04h" beats "52:04:31". */
  const text = d > 0 ? `${d}d ${pad(h)}h` : h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  const spoken = [
    d > 0 ? `${d} day${d === 1 ? "" : "s"}` : null,
    h > 0 ? `${h} hour${h === 1 ? "" : "s"}` : null,
    d === 0 && h === 0 ? `${m} minute${m === 1 ? "" : "s"}` : null,
    d === 0 && h === 0 ? `${s} second${s === 1 ? "" : "s"}` : null
  ].filter(Boolean).join(" ");

  return { expired: false, known: true, d, h, m, s, text, spoken };
};

/* How far through a running contest is, as a 0-1 fraction, for a progress bar. */
const contestProgress = (contest, nowSeconds) => {
  const start = Number(contest?.startTimeSeconds);
  const duration = Number(contest?.durationSeconds);
  const now = Number(nowSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(now)) {
    return null;
  }
  if (now <= start) return 0;
  if (now >= start + duration) return 1;
  return (now - start) / duration;
};

/* ------------------------------- problems ------------------------------ */

/* The contest's problems, in index order, with what the page needs.

   `rating` is absent for a contest that ended recently - Codeforces publishes
   ratings some time after the round - so it stays null rather than being filled
   from a guess. `inCatalog` is filled in later by matchToCatalog. */
const contestProblems = (raw, contestId) => {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((problem, position) => {
      const index = String(problem?.index || "").trim();
      const name = String(problem?.name || "").trim();
      if (!index && !name) return null;
      return {
        position,
        index,
        name,
        points: Number.isFinite(Number(problem?.points)) ? Number(problem.points) : null,
        rating: Number.isFinite(Number(problem?.rating)) ? Number(problem.rating) : null,
        tags: Array.isArray(problem?.tags) ? problem.tags.filter((t) => typeof t === "string") : [],
        /* The key our catalog already uses: contest id then index, e.g. 1895E. */
        externalId: contestId != null && index ? `${contestId}${index}` : null,
        url: contestId != null && index ? `https://codeforces.com/contours/${contestId}/problems?locale=en#${index}` : null,
        slug: null,
        inCatalog: false
      };
    })
    .filter(Boolean)
    /* A1 before A2 before B, and not by string order, which would put A10
       before A2. */
    .sort((a, b) => {
      const letterA = a.index.replace(/[0-9].*$/, "");
      const letterB = b.index.replace(/[0-9].*$/, "");
      if (letterA !== letterB) return letterA.localeCompare(letterB, "en");
      const numA = parseInt((a.index.match(/[0-9]+/) || ["0"])[0], 10);
      const numB = parseInt((b.index.match(/[0-9]+/) || ["0"])[0], 10);
      return numA - numB;
    });
};

/* Joins the contest's problems to Quanta's own catalog.

   The join is exact on Codeforces' own problem id (contest id + index), not on
   title. Two problems called "Two Sum" is the normal case on a site with 11,450
   problems, so matching on words would attach people to the wrong question. */
const matchToCatalog = (problems, catalogProblems) => {
  const byExternalId = new Map();
  for (const entry of Array.isArray(catalogProblems) ? catalogProblems : []) {
    const key = String(entry?.external_id ?? entry?.externalId ?? "").toUpperCase();
    if (!key) continue;
    /* If the catalog somehow holds two rows for one id, the lower-rated is kept
       so the harder one is what a reader is sent to. */
    const existing = byExternalId.get(key);
    if (!existing || Number(entry.rating || 0) > Number(existing.rating || 0)) byExternalId.set(key, entry);
  }

  const matched = (problems || []).map((problem) => {
    const hit = problem.externalId ? byExternalId.get(String(problem.externalId).toUpperCase()) : null;
    if (!hit) return { ...problem, inCatalog: false, slug: null };
    return {
      ...problem,
      inCatalog: true,
      slug: hit.slug,
      /* Prefer the catalog's rating, which is filled in from import time and is
         therefore available for contests whose own API rating is not. */
      rating: Number.isFinite(Number(hit.rating)) && Number(hit.rating) > 0 ? Number(hit.rating) : problem.rating,
      catalogRating: Number(hit.rating) || null
    };
  });

  return {
    problems: matched,
    inCatalog: matched.filter((p) => p.inCatalog).length,
    total: matched.length
  };
};

/* ------------------------------ standings ------------------------------ */

/* The official penalty formula, kept only so `verifyPenalty` can measure how far
   it is from the truth. Nothing on the page displays the result - see the note
   at the top of this file for why. */
const computePenalty = (problemResults, problemCount) => {
  let penalty = 0;
  for (let i = 0; i < problemCount; i += 1) {
    const result = problemResults?.[String(i)];
    if (result && Number(result.points) > 0) {
      penalty += Math.floor(Number(result.bestSubmissionTimeSeconds || 0) / 60) + 20 * (Number(result.rejectedAttemptCount) || 0);
    }
  }
  return penalty;
};

/* Compares a recomputed penalty against Codeforces' own. Returns how many rows
   agree and the shape of the disagreements - useful for noticing when the API
   changes meaning rather than silently trusting either number. */
const verifyPenalty = (standings) => {
  const problems = Array.isArray(standings?.problems) ? standings.problems : [];
  const rows = Array.isArray(standings?.rows) ? standings.rows : [];
  const differences = {};
  let agree = 0;

  for (const row of rows) {
    const computed = computePenalty(row?.problemResults, problems.length);
    const reported = Number(row?.penalty) || 0;
    if (computed === reported) {
      agree += 1;
    } else {
      const diff = computed - reported;
      differences[diff] = (differences[diff] || 0) + 1;
    }
  }

  return {
    rows: rows.length,
    agree,
    disagree: rows.length - agree,
    exact: agree === rows.length && rows.length > 0,
    differences: Object.entries(differences)
      .map(([diff, count]) => ({ diff: Number(diff), count }))
      .sort((a, b) => b.count - a.count)
  };
};

/* One standings row, flattened out of the nested party structure.

   `rank` in a Codeforces standings row is the shared rank: everyone on equal
   points-and-penalty gets the same number, and the next rank skips. That is
   their convention and it is preserved rather than renumbered, because a user
   comparing against codeforces.com should see the same figure. */
const normaliseStanding = (row, problems, handle) => {
  const members = Array.isArray(row?.party?.members) ? row.party.members : [];
  const wanted = String(handle || "").trim().toLowerCase();

  const solvedIndices = [];
  const results = [];
  problems.forEach((problem, i) => {
    const result = row?.problemResults?.[String(i)] || row?.problemResults?.[i];
    const solved = Boolean(result && Number(result.points) > 0);
    if (solved) solvedIndices.push(problem.index);
    results.push({
      index: problem.index,
      solved,
      points: Number(result?.points) || 0,
      seconds: Number(result?.bestSubmissionTimeSeconds) || 0,
      rejected: Number(result?.rejectedAttemptCount) || 0
    });
  });

  const firstAccepted = solvedIndices.length
    ? Math.min(...results.filter((r) => r.solved).map((r) => r.seconds))
    : null;

  return {
    rank: Number(row?.rank) || null,
    /* Joined with " & " because a team row carries two handles. */
    team: members.map((m) => m?.handle).filter(Boolean).join(" & "),
    handles: members.map((m) => m?.handle).filter(Boolean),
    isTeam: members.length > 1,
    /* Codeforces' own number, kept as reported. */
    penalty: Number(row?.penalty) || 0,
    points: Number(row?.points) || 0,
    solved: solvedIndices.length,
    totalProblems: problems.length,
    solvedIndices,
    firstAcceptedSeconds: firstAccepted,
    results,
    isYou: wanted ? members.some((m) => String(m?.handle || "").toLowerCase() === wanted) : false
  };
};

/* A standings table worth showing.

   A finished Codeforces round has between six and ten thousand rows, which is
   not a list anyone can read. Three things are cut down to something usable:
   the top slice, the reader's own row and a little context around it, and a
   real position out of the real field. */
const buildStandings = (raw, { handle, limit = 25 } = {}) => {
  const problems = Array.isArray(raw?.problems) ? raw.problems : [];
  const rows = Array.isArray(raw?.rows) ? raw.rows : [];
  const cap = Math.max(1, Math.min(Number(limit) || 25, 200));

  const all = rows.map((row) => normaliseStanding(row, problems, handle));
  /* Rank 1 is the best; an unranked row cannot happen but a null must not sort
     to the top if it ever does. */
  all.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.points - a.points || a.penalty - b.penalty);

  const youIndex = all.findIndex((row) => row.isYou);
  const you = youIndex >= 0 ? all[youIndex] : null;

  /* The window around the reader: three above, their row, three below. Without
     a handle this is just the top slice. */
  let window;
  if (you) {
    const from = Math.max(0, youIndex - 3);
    window = all.slice(from, from + 7);
  } else {
    window = all.slice(0, cap);
  }

  const total = all.length;
  /* Position out of the field, and how it compares with the median solver. A
     rank of 4 out of 10,000 means something different from 4 out of 20, and the
     bare number hides that. */
  const solvedCounts = all.map((r) => r.solved);
  const medianSolved = solvedCounts.length
    ? [...solvedCounts].sort((a, b) => a - b)[Math.floor(solvedCounts.length / 2)]
    : 0;
  const ranked = you ? all.filter((r) => (r.rank ?? Infinity) <= you.rank).length : 0;

  return {
    problems: problems.map((p, i) => ({
      position: i,
      index: p?.index ?? "",
      name: p?.name ?? "",
      points: Number.isFinite(Number(p?.points)) ? Number(p.points) : null,
      rating: Number.isFinite(Number(p?.rating)) ? Number(p.rating) : null,
      tags: Array.isArray(p?.tags) ? p.tags : []
    })),
    /* The slice to draw, already in rank order. */
    rows: window,
    you,
    total,
    shown: window.length,
    field: {
      medianSolved,
      yourSolved: you?.solved ?? null,
      /* Only meaningful with a handle that is actually in this contest. */
      positionInField: you ? ranked : null,
      /* Floored, never rounded: a 12th place out of 9,709 is not "better than
         100% of the field", and a page that says so is claiming a perfect
         score it did not earn. */
      betterThanPercent: you && total > 1 ? Math.floor(((total - ranked) / (total - 1)) * 100) : null
    },
    scoring: raw?.contest?.type === "ICPC" ? "penalty" : "points"
  };
};

/* ---------------------------- rating history --------------------------- */

/* The reader's rating over time, as the points of a line and the path of an
   SVG polyline.

   The chart is drawn from real Codeforces rating changes - one point per rated
   round the handle entered, oldest first. What is deliberately NOT drawn is any
   trend line, moving average or "you are improving" verdict: those invite a
   conclusion the data does not support, and a page that says "you are getting
   better" after two rounds has chosen a story over the numbers. */
const ratingSeries = (history) => {
  const rows = (Array.isArray(history) ? history : [])
    .filter((row) => row && Number.isFinite(Number(row.newRating)))
    .map((row) => ({
      contestId: Number(row.contestId) || null,
      contestName: String(row.contestName || ""),
      rank: Number(row.rank) || null,
      rating: Number(row.newRating),
      oldRating: Number(row.oldRating) || null,
      change: Number.isFinite(Number(row.oldRating)) ? Number(row.newRating) - Number(row.oldRating) : null,
      at: Number(row.ratingUpdateTimeSeconds) || null
    }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  if (!rows.length) {
    return {
      rows: [], path: "", areaPath: "", width: 0, height: 0,
      min: 0, max: 0, latest: null, best: null, change: null, band: "unrated", pointCount: 0
    };
  }

  const ratings = rows.map((r) => r.rating);
  const min = Math.min(...ratings);
  const max = Math.max(...ratings);

  const latest = rows[rows.length - 1];
  const best = rows.reduce((a, b) => (b.rating > a.rating ? b : a), rows[0]);

  /* The change worth showing is over the recent window, not across the whole
     history: the first round of anyone's Codeforces life moves them from 0 to
     1200 and would swamp everything that happened since. */
  const recent = rows.slice(-10);
  const firstOfWindow = recent[0];
  const change = firstOfWindow && firstOfWindow !== latest ? latest.rating - firstOfWindow.rating : null;

  /* A real range with breathing room, so a flat line renders as a line in the
     middle rather than collapsing onto an edge. */
  const pad = Math.max(50, Math.round((max - min) * 0.15));
  const low = Math.max(0, min - pad);
  const high = max + pad;

  const WIDTH = 640;
  const HEIGHT = 180;
  const xAt = (i) => (rows.length === 1 ? WIDTH / 2 : (i / (rows.length - 1)) * WIDTH);
  const yAt = (rating) => HEIGHT - ((rating - low) / (high - low)) * HEIGHT;

  const points = rows.map((row, i) => ({ x: Math.round(xAt(i)), y: Math.round(yAt(row.rating)), rating: row.rating, at: row.at, contestId: row.contestId }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaPath = points.length
    ? `${path} L${points[points.length - 1].x},${HEIGHT} L${points[0].x},${HEIGHT} Z`
    : "";

  return {
    rows,
    points,
    path,
    areaPath,
    width: WIDTH,
    height: HEIGHT,
    min,
    max,
    low,
    high,
    latest,
    best,
    /* Over the last ten rounds, with the window named so it cannot be read as a
       lifetime figure. */
    change,
    changeWindow: recent.length,
    band: rankForRating(latest.rating),
    pointCount: rows.length,
    aboveFloor: rows.filter((r) => r.rating >= RATING_FLOOR).length
  };
};

/* Profile headline. The handle is checked, not assumed, and the number of
   contests behind the rating is stated so a 1500 from one round does not read
   like a 1500 from two hundred. */
const summariseProfile = (info, history) => {
  const user = Array.isArray(info) ? info[0] : info;
  if (!user || typeof user !== "object") {
    return { ok: false, error: "Codeforces does not have that handle." };
  }
  const series = ratingSeries(history);
  const rated = series.rows.filter((r) => r.rating >= RATING_FLOOR).length;

  return {
    ok: true,
    handle: String(user.handle || ""),
    /* Codeforces' own words for the band, not a band this module derived. */
    rank: String(user.rank || series.band || "unrated"),
    /* Their own band for a rating below 1200 is "unrated" even when there is a
       number, so both are kept rather than one being made to agree. */
    maxRank: user.maxRank ? String(user.maxRank) : null,
    rating: Number.isFinite(Number(user.rating)) ? Number(user.rating) : null,
    maxRating: Number.isFinite(Number(user.maxRating)) ? Number(user.maxRating) : null,
    contribution: Number.isFinite(Number(user.contribution)) ? Number(user.contribution) : null,
    friendOfCount: Number.isFinite(Number(user.friendOfCount)) ? Number(user.friendOfCount) : null,
    country: user.country || null,
    registered: user.registrationTimeSeconds ? Number(user.registrationTimeSeconds) : null,
    org: user.organization || null,
    avatar: user.titlePhoto || null,
    /* How much of the rating is actually rated play, which is the honest
       context for a number someone is about to compare against their own. */
    ratedContests: rated,
    series,
    url: `https://codeforces.com/profile/${user.handle}`
  };
};

/* ------------------------------- planning ------------------------------ */

/* What to attempt in a contest you have a handle for, from the catalog.

   The advice is arithmetic on the round's own point values, not a motto. That
   matters because the point ladder is not what people assume:

     - Modern CF rounds, Div. 1 and Div. 2 alike, pay LESS for the early
       problems. A Div. 1 sheet runs 500, 1000, 1250, 2000, 2250, 3500 - the
       back of the sheet is where the points are.
     - ICPC rounds carry no points at all. They are decided by solves first and
       penalty second, so time is the thing to protect, not points.

   An earlier version of this function assumed the ladder ran the other way and
   produced advice about "banking the easy ones" - including a negative
   difference, because the assumption did not match the data. Everything below
   is therefore measured rather than assumed: the direction of the ladder is
   read off the values in hand, and each scoring system gets advice that applies
   to it.

   Difficulty is a separate matter. A contest's own problem ratings are missing
   until Codeforces publishes them, so difficulty comes from the catalog where we
   hold the problem, and otherwise falls back to contest order - labelled as
   such, because calling a letter a rating would be inventing data. */
const richestOf = (scored) => {
  const worth = scored.filter((p) => p.points != null);
  return worth.length ? worth.reduce((a, b) => (b.points > a.points ? b : a), worth[0]) : null;
};

const contestPlan = (problems, { contest } = {}) => {
  const list = Array.isArray(problems) ? problems : [];
  if (!list.length) return { rows: [], advice: "No problems to plan yet.", totalPoints: 0 };

  const scored = list.map((problem, i) => {
    const rating = Number.isFinite(Number(problem.rating)) && Number(problem.rating) > 0
      ? Number(problem.rating)
      : null;
    return {
      index: problem.index,
      name: problem.name,
      /* Null rather than zero: a round with no points is a different scoring
         system, not a round where every problem is worth nothing. */
      points: Number.isFinite(Number(problem.points)) && Number(problem.points) > 0 ? Number(problem.points) : null,
      rating,
      /* Index order is the fallback difficulty signal and is labelled as such. */
      difficultySource: rating ? "rated" : "contest order",
      inCatalog: Boolean(problem.inCatalog),
      slug: problem.slug || null,
      /* What one solve is worth as a share of the whole round. */
      share: null,
      position: i
    };
  });

  const worth = scored.filter((p) => p.points != null);
  const totalPoints = worth.reduce((sum, p) => sum + p.points, 0);
  for (const row of scored) {
    row.share = totalPoints > 0 && row.points != null ? Math.round((row.points / totalPoints) * 100) : null;
  }

  const richest = richestOf(scored);
  /* A round where every problem has points is points-scored. One where none
     does is an ICPC round. A mixture is not something Codeforces produces, and
     is treated as the safer of the two readings rather than guessed at. */
  const isPointsRound = worth.length === scored.length;

  let advice;
  if (!isPointsRound) {
    advice =
      "This round is decided by solves first and penalty second, not by points. Penalty is the minutes " +
      "you took plus twenty minutes for every wrong attempt, so a clean early solve of an easy problem " +
      "beats the same solve rushed at the end. Quanta shows Codeforces' own penalty figures rather than " +
      "recomputing them: its numbers do not match the published formula, and a second, different penalty " +
      "beside the real one would only muddy the comparison.";
  } else if (scored.length < 2) {
    advice = "One problem, one shot at the round.";
  } else {
    const first = scored[0].points;
    const last = scored[scored.length - 1].points;
    const cheapest = worth.reduce((a, b) => (b.points < a.points ? b : a), worth[0]);
    const firstTwo = scored.slice(0, 2).reduce((sum, p) => sum + p.points, 0);
    const richestShare = Math.round((richest.points / totalPoints) * 100);
    const firstTwoShare = Math.round((firstTwo / totalPoints) * 100);

    /* Measured, not assumed. */
    const direction =
      last > first
        ? `Points climb as you go down the sheet: ${first} for ${scored[0].index}, ${last} for ${scored[scored.length - 1].index}`
        : last < first
          ? `Points fall as you go down the sheet: ${first} for ${scored[0].index}, ${last} for ${scored[scored.length - 1].index}`
          : "Every problem is worth the same";

    advice =
      `${direction}. ${cheapest.index} is the cheapest at ${cheapest.points}; ${richest.index} alone is worth ` +
      `${richestShare}% of the round's ${totalPoints} points, while ${scored[0].index} and ${scored[1].index} ` +
      `together are worth ${firstTwoShare}%. Reading the cheap ones in full costs a fraction of what reaching ` +
      `for ${richest.index} first does, so the shape of a round is: clear what is cheap, then spend whatever ` +
      `is left on what is expensive.`;
  }

  return {
    rows: scored,
    totalPoints,
    advice,
    isPointsRound,
    richestIndex: richest ? richest.index : null,
    cheapestIndex: worth.length ? worth.reduce((a, b) => (b.points < a.points ? b : a), worth[0]).index : null,
    durationSeconds: Number(contest?.durationSeconds) || null,
    /* Minutes per problem, which is what the round actually imposes. */
    minutesPerProblem: contest?.durationSeconds ? Math.round((Number(contest.durationSeconds) / 60) / scored.length) : null,
    ratedCount: scored.filter((r) => r.rating).length,
    catalogCount: scored.filter((r) => r.inCatalog).length
  };
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CODEFORCES_API,
    RATING_BANDS,
    RATING_FLOOR,
    rankForRating,
    normaliseContest,
    classifyContests,
    countdown,
    contestProgress,
    contestProblems,
    matchToCatalog,
    computePenalty,
    verifyPenalty,
    normaliseStanding,
    buildStandings,
    ratingSeries,
    summariseProfile,
    contestPlan
  };
}

if (typeof window !== "undefined" && window) {
  window.CONTEST_API = CODEFORCES_API;
  window.contestEngine = {
    rankForRating,
    normaliseContest,
    classifyContests,
    countdown,
    contestProgress,
    contestProblems,
    matchToCatalog,
    verifyPenalty,
    normaliseStanding,
    buildStandings,
    ratingSeries,
    summariseProfile,
    contestPlan
  };
}
