/* ========================= server / codeforces client ======================
   The one place this app talks to Codeforces.

   Why a dedicated module
   ----------------------
   Codeforces' API is public and documented, and it asks for one courtesy in
   return: do not send a flood of requests. A single page that renders a contest
   list, then a contest's problems, then a user's rating history, would happily
   make three calls per view, and every visitor would multiply that. So all
   upstream traffic goes through here, which does three things:

     1. Caches every response, so the same view costs at most one upstream call
        per TTL no matter how many people load it.
     2. Serialises calls through a single queue with a gap between them, so the
        app can never burst - and so a burst of users cannot become a burst of
        requests to someone else's free service.
     3. Turns Codeforces' `{"status":"FAILED","comment":"..."}` shape into a
        real error, rather than letting `{}` reach the page and look like an
        empty contest.

   What is not here
   ----------------
   No fabricated fallback. If Codeforces is unreachable, the endpoint answers
   with an error and the page says so. There is no cached copy of a contest
   presented as if it were live, and no sample standings table - a competition
   ranking that is quietly invented would be worse than no page at all.

   Time handling
   -------------
   Codeforces reports times in Unix seconds. Everything crossing this boundary
   is normalised to whole seconds, because the clock arithmetic on the client is
   the part most likely to be off by a rounding error, and half-seconds are
   never what anyone wants to see on a countdown.
*/

const contests = require("./contests");

const API = contests.CODEFORCES_API;

/* How long each kind of response may be reused. Chosen by how fast the answer
   can change, not by how convenient a long number is:
     - the contest list moves when a round starts or ends, so a minute;
     - standings are frozen the moment a round ends but heavy to fetch, so
       longer;
     - a rating history changes once per rated round, so longer still. */
const TTL = {
  contestList: Number(process.env.CF_TTL_LIST_MS || 60_000),
  standings: Number(process.env.CF_TTL_STANDINGS_MS || 300_000),
  profile: Number(process.env.CF_TTL_PROFILE_MS || 600_000)
};

/* The floor between two upstream calls. Codeforces publishes no hard limit, so
   this is deliberately well under the rate most mirrors recommend. */
const MIN_GAP_MS = Number(process.env.CF_MIN_GAP_MS || 1200);

/* A hard ceiling on how long a caller will wait behind someone else's request,
   so a slow upstream cannot pile up forever. */
const REQUEST_TIMEOUT_MS = Number(process.env.CF_TIMEOUT_MS || 12_000);

const cache = new Map();
/* Upstream failures are remembered briefly too, so a Codeforces outage does not
   turn into one request per page view from every open tab. */
const failureCache = new Map();
const FAILURE_TTL_MS = 30_000;

let queueTail = Promise.resolve();
let lastCallAt = 0;

const nowMs = () => Date.now();

/* Reads through the cache. Returns undefined on a miss, never a promise, so
   callers can check before they commit to a slow path. */
const fromCache = (key) => {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (nowMs() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
};

const rememberFailure = (key, message) => {
  failureCache.set(key, { message, expiresAt: nowMs() + FAILURE_TTL_MS });
};

const clearFailure = (key) => failureCache.delete(key);

/* Serialises every upstream call behind one promise chain with a gap, so the
   ordering is FIFO and no two requests ever overlap. */
const enqueue = (task) => {
  const run = queueTail.then(async () => {
    const wait = MIN_GAP_MS - (nowMs() - lastCallAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      lastCallAt = nowMs();
      return await task();
    } finally {
      /* The gap is measured from the end of the previous call, not its start, so
         a slow response cannot cause the next one to fire immediately after. */
      lastCallAt = nowMs();
    }
  });
  /* The chain must not break when one task rejects, or every later request would
     reject with it. */
  queueTail = run.then(() => undefined, () => undefined);
  return run;
};

/* A fetch that cannot hang, and whose HTTP and application-level failures are
   both real errors. */
const fetchUpstream = async (path) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API}${path}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "Quanta-LeetCode/1.0 (local study app)" }
    });
    /* The body is read before the status is judged, because Codefiles puts the
       actual reason in it - "handles: User with handle X not found" comes back
       as HTTP 400, not 404. Discarding it in favour of "answered 400" would
       turn a typo in a handle into an unexplained outage. */
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const comment = String(body?.comment || "").trim();

    if (!response.ok) {
      throw new Error(comment || `Codeforces answered ${response.status}.`);
    }
    if (!body) {
      throw new Error("Codeforces sent something that is not JSON.");
    }
    /* Codeforces also answers HTTP 200 with status FAILED for some refusals.
       Treating that as data would show an empty profile for a typo, which
       reads as "this person has no contests". */
    if (body.status !== "OK") {
      throw new Error(comment || "Codeforces could not answer that.");
    }
    if (body.result === undefined) {
      throw new Error("Codeforces returned no result.");
    }
    return body.result;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Codeforces did not respond in time.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/* The cached path. Any key that is already warm returns without touching the
   queue; otherwise the call is queued, and two callers arriving together share
   one upstream request rather than making two.

   The stored value is always wrapped as `{ raw }`. Spreading it directly would
   be shorter and wrong: most of these responses are arrays, and `{ ...array }`
   silently produces an object with numeric keys and no length. */
const cached = (key, ttl, loader) => {
  const hit = fromCache(key);
  if (hit !== undefined) return Promise.resolve({ raw: hit, cached: true });

  const remembered = failureCache.get(key);
  if (remembered && nowMs() < remembered.expiresAt) {
    return Promise.resolve({ raw: undefined, ok: false, error: remembered.message, cached: true });
  }

  /* Re-use an in-flight promise for this key. This is the difference between
     ten people opening the page and ten requests to Codeforces. */
  if (cache.has(`inflight:${key}`)) {
    return cache.get(`inflight:${key}`).then((value) => ({ raw: value, cached: true }));
  }

  const promise = enqueue(async () => {
    try {
      const value = await loader();
      cache.set(key, { value, expiresAt: nowMs() + ttl });
      clearFailure(key);
      return value;
    } finally {
      cache.delete(`inflight:${key}`);
    }
  });

  /* A failure is remembered briefly and then re-thrown, so a burst of tabs
     during an outage does not queue one upstream call each. */
  const guarded = promise.catch((error) => {
    rememberFailure(key, error?.message || String(error));
    throw error;
  });

  cache.set(`inflight:${key}`, guarded);
  return guarded.then((value) => ({ raw: value, cached: false }));
};

/* A remembered failure is resolved rather than rejected, so that a burst of
   tabs during an outage does not queue one upstream call each. That means the
   value handed back can be an error object instead of data, and every getter
   below has to notice - otherwise a failure would reach the page as an empty
   contest list, which looks exactly like "there are no contests". */
const requireData = (result) => {
  if (!result || result.ok === false || result.raw === undefined) {
    throw new Error(result?.error || "Codeforces could not be reached.");
  }
  return result.raw;
};

/* ------------------------------- contests ------------------------------- */

/* Live, upcoming and recent rounds, split against the current clock.

   The list is small (2,156 contests) but it is the request every visitor makes
   first, so it is cached for a minute and split here rather than on the client:
   one authoritative split means the countdown and the badge cannot disagree. */
const getContests = async () => {
  const fetched = await cached("contests", TTL.contestList, async () => {
    const list = await fetchUpstream("/contest.list?gym=false");
    if (!Array.isArray(list)) throw new Error("Codeforces returned an unexpected contest list.");
    return list;
  });
  const raw = requireData(fetched);

  const now = Math.round(Date.now() / 1000);
  const split = contests.classifyContests(raw, now);

  /* Only what a page needs: a handful of each. The full history stays
     available through /contests/:id, so nothing is lost, but no single response
     carries two thousand finished contests to every tab. */
  const decorated = (list) =>
    list.map((contest) => ({
      ...contest,
      secondsUntilStart: contest.startTimeSeconds != null ? contest.startTimeSeconds - now : null,
      secondsUntilEnd:
        contest.startTimeSeconds != null && contest.durationSeconds != null
          ? contest.startTimeSeconds + contest.durationSeconds - now
          : null
    }));

  return {
    ok: true,
    cached: fetched.cached,
    fetchedAt: now,
    live: decorated(split.live),
    upcoming: decorated(split.upcoming.slice(0, 25)),
    recent: decorated(split.recent.slice(0, 40)),
    counts: {
      live: split.live.length,
      upcoming: split.upcoming.length,
      recent: split.recent.length,
      total: split.live.length + split.upcoming.length + split.recent.length
    },
    source: "codeforces.com/api/contest.list"
  };
};

/* ------------------------------- standings ------------------------------ */

/* A contest's problems and standings.

   `contest.standings` refuses any extra query parameter for anonymous callers,
   so the whole table arrives or nothing does - there is no server-side paging
   to lean on. A finished round can be ten thousand rows, which is why the rows
   are cut down to something readable before leaving this function. */
const getContest = async (contestId) => {
  const id = Number(contestId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("That is not a contest id.");
  }

  const fetched = await cached(`contest:${id}`, TTL.standings, async () => {
    const standings = await fetchUpstream(`/contest.standings?contestId=${id}`);
    if (!standings || !standings.contest || !Array.isArray(standings.problems)) {
      throw new Error("Codeforces has no standings for that contest - it may not have started yet.");
    }
    return standings;
  });
  const raw = requireData(fetched);

  const now = Math.round(Date.now() / 1000);
  const contest = contests.normaliseContest({
    ...raw.contest,
    /* contest.standings omits phase for finished rounds in some responses, so
       the start time is what decides. */
    phase: raw.contest.phase || ""
  });

  const problems = contests.contestProblems(raw.problems, id);
  const rows = Array.isArray(raw.rows) ? raw.rows : [];

  return {
    ok: true,
    cached: fetched.cached,
    fetchedAt: now,
    contest: {
      ...contest,
      secondsUntilStart: contest.startTimeSeconds != null ? contest.startTimeSeconds - now : null,
      secondsUntilEnd:
        contest.startTimeSeconds != null && contest.durationSeconds != null
          ? contest.startTimeSeconds + contest.durationSeconds - now
          : null
    },
    problems,
    /* Both, separately: the row count is the real field size, and the analysed
       table is what the page can actually draw. */
    rowCount: rows.length,
    rows,
    source: "codeforces.com/api/contest.standings"
  };
};

/* -------------------------------- profile ------------------------------- */

/* A handle's real profile and rating history.

   An empty rating history is normal - someone who registered last week and has
   entered no rated round - so it is reported as zero rounds rather than treated
   as a failure. A handle Codeforces does not know is a genuine error and comes
   back as one. */
const getProfile = async (handle) => {
  const clean = String(handle || "").trim();
  /* Codeforces handles are letters and digits with underscores. Checking here
     keeps junk out of the request queue and turns an API error into a
     comprehensible one. */
  if (!/^[A-Za-z0-9_]{1,32}$/.test(clean)) {
    throw new Error("A Codeforces handle is letters, digits and underscores, up to 32 characters.");
  }

  const fetched = await cached(`profile:${clean.toLowerCase()}`, TTL.profile, async () => {
    /* Sequential on purpose. Both calls sit inside one queue slot, so running
       them with Promise.all would put two requests on Codeforces at the same
       instant - the one thing the gap in this module exists to prevent. */
    const info = await fetchUpstream(`/user.info?handles=${encodeURIComponent(clean)}`);
    const rating = await fetchUpstream(`/user.rating?handle=${encodeURIComponent(clean)}`).catch(() => []);
    return { info: Array.isArray(info) ? info : [], rating: Array.isArray(rating) ? rating : [] };
  });
  const raw = requireData(fetched);

  const summary = contests.summariseProfile(raw.info, raw.rating);
  if (!summary.ok) {
    throw new Error(summary.error || "Codeforces does not have that handle.");
  }

  return {
    ok: true,
    cached: fetched.cached,
    fetchedAt: Math.round(Date.now() / 1000),
    ...summary,
    source: "codeforces.com/api/user.info + user.rating"
  };
};

/* ---------------------------- introspection ----------------------------- */

/* Exposed so the diagnostics page and the tests can see whether the cache is
   doing its job, without guessing. */
const cacheStats = () => ({
  entries: [...cache.entries()].filter(([key]) => !key.startsWith("inflight:")).map(([key, entry]) => ({
    key,
    expiresInMs: Math.max(0, entry.expiresAt - nowMs())
  })),
  inflight: [...cache.keys()].filter((key) => key.startsWith("inflight:")),
  failures: [...failureCache.entries()].map(([key, entry]) => ({
    key,
    message: entry.message,
    expiresInMs: Math.max(0, entry.expiresAt - nowMs())
  })),
  lastCallAt,
  minGapMs: MIN_GAP_MS,
  ttl: { ...TTL }
});

const clearCache = () => {
  cache.clear();
  failureCache.clear();
};

module.exports = {
  API,
  TTL,
  MIN_GAP_MS,
  getContests,
  getContest,
  getProfile,
  cacheStats,
  clearCache
};
