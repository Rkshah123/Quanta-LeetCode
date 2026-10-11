/* ---------------------------- db / progress ------------------------------- */
/* Repository for coding progress: what the user marked solved, and what the
   server actually executed.

   Two different facts are stored on purpose and must never be conflated:

     problem_progress.solved = the user pressed "Mark solved". This app cannot
       verify algorithmic correctness (JavaScript runs in the browser, other
       languages run on Judge0 against free-form stdin, never against the
       problem's hidden test cases), so this is an assertion by the user, not a
       verified acceptance.
     problem_runs           = a real execution the server performed and observed.
       "ok" means the program ran to completion, nothing more.

   Every statement is parameterized, every value is validated here, and no
   result ever contains credentials or user code. */

const { query } = require("./pool");

/* The app has no login system. All progress belongs to this single implicit
   owner; every read and write is scoped by it so rows can never be merged with
   another owner's data if identities are introduced later. */
const PROGRESS_OWNER = "default";

const DIFFICULTIES = ["Easy", "Medium", "Hard"];
const ACTIVITY_DAYS_DEFAULT = 365;
const ACTIVITY_DAYS_MIN = 30;
const ACTIVITY_DAYS_MAX = 730;
const ACTIVITY_PAGE_MAX = 50;
const RUN_STATUS_MAX = 48;
const TITLE_MAX = 255;
const LANGUAGE_MAX = 32;

/* ----------------------------- pure helpers ------------------------------ */

/* Clamps a client timezone offset (minutes east of UTC, e.g. +330 for UTC+5:30)
   to a sane integer. SQL cannot parameterize an INTERVAL unit, so the value is
   validated here and inlined as a number. */
const normalizeTzOffset = (value) => {
  const offset = Number(value);
  if (!Number.isFinite(offset)) return 0;
  return Math.max(-840, Math.min(840, Math.trunc(offset)));
};

const normalizeDays = (value) => {
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days)) return ACTIVITY_DAYS_DEFAULT;
  return Math.max(ACTIVITY_DAYS_MIN, Math.min(ACTIVITY_DAYS_MAX, days));
};

const clampLimit = (value, fallback = 20, max = ACTIVITY_PAGE_MAX) => {
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1) return fallback;
  return Math.min(limit, max);
};

const clampOffset = (value) => {
  const offset = Number.parseInt(value, 10);
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.min(offset, 1000000);
};

/* LeetCode slugs are lowercase, digits and dashes. Anything else is refused so
   the key can never drift between the client, the catalog and LeetCode. */
const normalizeSlug = (value) => {
  const slug = String(value ?? "").trim().toLowerCase();
  if (!slug || slug.length > 191) return "";
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug)) return "";
  return slug;
};

const normalizeDifficulty = (value) => (DIFFICULTIES.includes(value) ? value : "Medium");

const cleanTitle = (value) => String(value ?? "").trim().slice(0, TITLE_MAX);

const cleanNumber = (value) => {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) && num > 0 ? num : null;
};

/* "YYYY-MM-DD" for a UTC-shifted date, used as the calendar key everywhere. */
const toDayKey = (date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

/* Parses "YYYY-MM-DD" back into a UTC midnight Date. */
const dayKeyToDate = (key) => {
  const [year, month, day] = String(key).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

/* Adds n days to a "YYYY-MM-DD" key, staying on UTC midnight so no local
   daylight-saving rule can move a calendar day. */
const shiftDayKey = (key, days) => {
  const date = dayKeyToDate(key);
  date.setUTCDate(date.getUTCDate() + days);
  return toDayKey(date);
};

const compareDayKeys = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/* Monday-based ISO week key, e.g. "2026-11-W03". Weeks start on Monday so the
   "current week" matches the calendar most people plan with. */
const isoWeekKey = (dayKey) => {
  const date = dayKeyToDate(dayKey);
  /* getUTCDay(): 0 = Sunday. Shift so Monday is the first day of the week. */
  const dayIndex = (date.getUTCDay() + 6) % 7;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - dayIndex);
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDayIndex = (firstThursday.getUTCDay() + 6) % 7;
  const firstMonday = new Date(firstThursday);
  firstMonday.setUTCDate(firstThursday.getUTCDate() - firstDayIndex + 3);
  const week = Math.round((thursday - firstMonday) / (7 * 24 * 3600 * 1000)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
};

const monthKey = (dayKey) => String(dayKey).slice(0, 7);

/* Every day between two keys, inclusive. Missing days are included with a zero
   count so a gap always breaks a streak instead of being skipped. */
const dayRange = (fromKey, toKey) => {
  const keys = [];
  let cursor = fromKey;
  let guard = 0;
  while (compareDayKeys(cursor, toKey) <= 0 && guard < ACTIVITY_DAYS_MAX + 7) {
    keys.push(cursor);
    cursor = shiftDayKey(cursor, 1);
    guard += 1;
  }
  return keys;
};

/* Builds a dense Map<dayKey, count> so calendar, streaks and trends all read
   from the same source of truth. */
const toCountMap = (rows) => {
  const map = new Map();
  rows.forEach((row) => {
    const key = String(row.day || "").slice(0, 10);
    if (!key) return;
    const count = Number(row.solved) || 0;
    map.set(key, (map.get(key) || 0) + count);
  });
  return map;
};

/* Current streak: consecutive active days ending today, or ending yesterday
   when today has no activity yet (the day is not over, so an unbroken streak is
   not broken by it). Longest streak: the longest run anywhere in the history. */
const computeStreaks = (countMap, todayKey) => {
  const activeDays = [...countMap.entries()]
    .filter(([, count]) => count > 0)
    .map(([key]) => key)
    .sort(compareDayKeys);

  if (!activeDays.length) return { current: 0, longest: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < activeDays.length; i += 1) {
    if (shiftDayKey(activeDays[i - 1], 1) === activeDays[i]) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }

  const lastDay = activeDays[activeDays.length - 1];
  let current = 0;
  let cursor = todayKey;
  if ((countMap.get(todayKey) || 0) === 0) cursor = shiftDayKey(todayKey, -1);
  while ((countMap.get(cursor) || 0) > 0) {
    current += 1;
    cursor = shiftDayKey(cursor, -1);
  }
  /* A streak cannot survive a gap larger than the recorded history. */
  return { current: current <= longest ? current : longest, longest };
};

/* Dense series for the activity calendar: every day in range, with a count. */
const buildDailySeries = (countMap, days, todayKey) =>
  dayRange(shiftDayKey(todayKey, -(days - 1)), todayKey).map((key) => ({
    day: key,
    count: countMap.get(key) || 0
  }));

const buildWeeklySeries = (countMap, weeks, todayKey) => {
  /* Start on the Monday of the week `weeks - 1` weeks back. */
  const today = dayKeyToDate(todayKey);
  const dayIndex = (today.getUTCDay() + 6) % 7;
  const thisMonday = new Date(today);
  thisMonday.setUTCDate(today.getUTCDate() - dayIndex);
  const firstMonday = new Date(thisMonday);
  firstMonday.setUTCDate(thisMonday.getUTCDate() - 7 * (weeks - 1));

  const buckets = new Map();
  dayRange(toDayKey(firstMonday), todayKey).forEach((key) => {
    const week = isoWeekKey(key);
    if (!buckets.has(week)) buckets.set(week, { key: week, start: key, count: 0 });
    buckets.get(week).count += countMap.get(key) || 0;
  });
  return [...buckets.values()];
};

const buildMonthlySeries = (countMap, months, todayKey) => {
  const today = dayKeyToDate(todayKey);
  const buckets = new Map();
  for (let i = months - 1; i >= 0; i -= 1) {
    const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    const key = monthKey(toDayKey(cursor));
    buckets.set(key, { key, start: toDayKey(cursor), count: 0 });
  }
  dayRange(shiftDayKey(todayKey, -(ACTIVITY_DAYS_MAX - 1)), todayKey).forEach((key) => {
    const bucket = buckets.get(monthKey(key));
    if (bucket) bucket.count += countMap.get(key) || 0;
  });
  return [...buckets.values()];
};

/* Sum of a day range, inclusive. Used for today / this week / this month and
   for the comparison with the previous period. */
const sumRange = (countMap, fromKey, toKey) => {
  let total = 0;
  dayRange(fromKey, toKey).forEach((key) => {
    total += countMap.get(key) || 0;
  });
  return total;
};

/* Week containing today, Monday-based, as two day keys. */
const currentWeekRange = (todayKey) => {
  const today = dayKeyToDate(todayKey);
  const dayIndex = (today.getUTCDay() + 6) % 7;
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - dayIndex);
  return { from: toDayKey(monday), to: todayKey };
};

const previousWeekRange = (todayKey) => {
  const { from } = currentWeekRange(todayKey);
  return { from: shiftDayKey(from, -7), to: shiftDayKey(from, -1) };
};

const currentMonthRange = (todayKey) => {
  const date = dayKeyToDate(todayKey);
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  return { from: toDayKey(first), to: todayKey };
};

const previousMonthRange = (todayKey) => {
  const date = dayKeyToDate(todayKey);
  const firstThis = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const lastPrev = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
  const firstPrev = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return { from: toDayKey(firstPrev), to: toDayKey(lastPrev) };
};

/* Difference and ratio between this period and the previous one. A previous
   period of zero is reported as null rather than a fake percentage. */
const comparePeriods = (current, previous) => {
  const delta = current - previous;
  let percent = null;
  if (previous > 0) percent = Math.round((delta / previous) * 100);
  return { current, previous, delta, percent };
};

/* ------------------------------ repository ------------------------------- */

/* Upsert of the user's own "Mark solved" decision.
   - solved_at is kept when a problem is re-marked solved, so a stray double
     click cannot rewrite history and move a streak.
   - it is cleared when the problem is marked unsolved again, so the problem
     disappears from the calendar instead of lingering as a ghost entry. */
const markSolved = async ({ slug, title, num, difficulty, solved }) => {
  const cleanSlug = normalizeSlug(slug);
  if (!cleanSlug) throw new Error("A valid problem slug is required.");

  const isSolved = solved === true ? 1 : 0;
  const existingRows = await query(
    "SELECT lc_num, title, difficulty FROM problem_progress WHERE owner_key = ? AND slug = ?",
    [PROGRESS_OWNER, cleanSlug]
  );
  const existing = existingRows[0] || null;

  /* Metadata is only replaced when the client actually knows it, so a thin
     client can never wipe a title or a difficulty that is already stored. */
  const nextNum = cleanNumber(num) ?? existing?.lc_num ?? null;
  const nextTitle = cleanTitle(title) || existing?.title || "";
  const nextDifficulty = DIFFICULTIES.includes(difficulty) ? difficulty : existing?.difficulty || "Medium";

  /* The SQL fragment is chosen from a boolean, never from user input. */
  const solvedAtSql = isSolved ? "COALESCE(solved_at, UTC_TIMESTAMP())" : "NULL";

  if (!existing) {
    await query(
      `INSERT INTO problem_progress (owner_key, slug, lc_num, title, difficulty, solved, solved_at)
       VALUES (?, ?, ?, ?, ?, ?, ${isSolved ? "UTC_TIMESTAMP()" : "NULL"})`,
      [PROGRESS_OWNER, cleanSlug, nextNum, nextTitle, nextDifficulty, isSolved]
    );
  } else {
    /* solved_at keeps its first value so a stray double click cannot move a
       streak, and it is cleared when the problem is marked unsolved again. */
    await query(
      `UPDATE problem_progress
          SET lc_num = ?, title = ?, difficulty = ?, solved = ?,
              solved_at = ${solvedAtSql}, updated_at = UTC_TIMESTAMP()
        WHERE owner_key = ? AND slug = ?`,
      [nextNum, nextTitle, nextDifficulty, isSolved, PROGRESS_OWNER, cleanSlug]
    );
  }

  const rows = await query(
    `SELECT slug, lc_num, title, difficulty, solved,
            DATE_FORMAT(solved_at, '%Y-%m-%d %H:%i:%s') AS solved_at
       FROM problem_progress WHERE owner_key = ? AND slug = ?`,
    [PROGRESS_OWNER, cleanSlug]
  );

  const row = rows[0] || null;
  return row
    ? {
        slug: row.slug,
        num: row.lc_num ?? null,
        title: row.title,
        difficulty: row.difficulty,
        solved: Boolean(Number(row.solved)),
        solvedAt: row.solved_at || null
      }
    : null;
};

/* Everything currently marked solved, used by the client to sync its local
   list. One row per problem, no duplicates by construction (primary key). */
const listSolved = async () => {
  const rows = await query(
    `SELECT pp.slug, pp.lc_num, pp.title, COALESCE(p.difficulty, pp.difficulty) AS difficulty,
            DATE_FORMAT(pp.solved_at, '%Y-%m-%d %H:%i:%s') AS solved_at
       FROM problem_progress pp
       LEFT JOIN problems p ON p.slug = pp.slug
      WHERE pp.owner_key = ? AND pp.solved = 1
      ORDER BY pp.solved_at DESC, pp.slug ASC`,
    [PROGRESS_OWNER]
  );
  return rows.map((row) => ({
    slug: row.slug,
    num: row.lc_num ?? null,
    title: row.title,
    difficulty: row.difficulty,
    solvedAt: row.solved_at || null
  }));
};

/* Paginated solved history for the "recent activity" list. */
const listActivity = async ({ limit, offset } = {}) => {
  const safeLimit = clampLimit(limit);
  const safeOffset = clampOffset(offset);

  const totals = await query(
    "SELECT COUNT(*) AS total FROM problem_progress WHERE owner_key = ? AND solved = 1 AND solved_at IS NOT NULL",
    [PROGRESS_OWNER]
  );

  const rows = await query(
    `SELECT pp.slug, pp.lc_num, pp.title, COALESCE(p.difficulty, pp.difficulty) AS difficulty,
            DATE_FORMAT(pp.solved_at, '%Y-%m-%d %H:%i:%s') AS solved_at
       FROM problem_progress pp
       LEFT JOIN problems p ON p.slug = pp.slug
      WHERE pp.owner_key = ? AND pp.solved = 1 AND pp.solved_at IS NOT NULL
      ORDER BY pp.solved_at DESC, pp.slug ASC
      LIMIT ? OFFSET ?`,
    [PROGRESS_OWNER, safeLimit, safeOffset]
  );

  return {
    items: rows.map((row) => ({
      slug: row.slug,
      num: row.lc_num ?? null,
      title: row.title,
      difficulty: row.difficulty,
      solvedAt: row.solved_at
    })),
    total: Number(totals[0]?.total || 0),
    limit: safeLimit,
    offset: safeOffset
  };
};

/* Records one real execution. Called from POST /api/run after the runner has
   answered, and never allowed to break that response. */
const recordRun = async ({ slug, num, language, status, ok, durationMs }) => {
  const cleanSlug = normalizeSlug(slug);
  const duration = Number.parseInt(durationMs, 10);
  await query(
    `INSERT INTO problem_runs (owner_key, slug, lc_num, language, status, ok, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      PROGRESS_OWNER,
      cleanSlug || null,
      cleanNumber(num),
      String(language || "unknown").slice(0, LANGUAGE_MAX),
      String(status || "Unknown").slice(0, RUN_STATUS_MAX),
      ok ? 1 : 0,
      Number.isFinite(duration) && duration >= 0 ? Math.min(duration, 600000) : null
    ]
  );
  return true;
};

/* Everything the dashboard needs, in one response and a handful of aggregated
   queries - never one query per solved problem. */
const getSummary = async (options = {}) => {
  const tzOffsetMinutes = normalizeTzOffset(options.tzOffsetMinutes);
  const days = normalizeDays(options.days);
  const weeks = Math.min(26, Math.max(4, Number.parseInt(options.weeks, 10) || 12));
  const months = Math.min(12, Math.max(3, Number.parseInt(options.months, 10) || 6));

  const [catalogRows, solvedByDifficulty, dailyRows, runRows, activeSinceRows] = await Promise.all([
    query("SELECT difficulty, COUNT(*) AS total FROM problems GROUP BY difficulty"),
    query(
      `SELECT COALESCE(p.difficulty, pp.difficulty) AS difficulty,
              COUNT(*) AS solved,
              SUM(CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END) AS solved_in_catalog
         FROM problem_progress pp
         LEFT JOIN problems p ON p.slug = pp.slug
        WHERE pp.owner_key = ? AND pp.solved = 1
        GROUP BY COALESCE(p.difficulty, pp.difficulty)`,
      [PROGRESS_OWNER]
    ),
    query(
      /* DATE_FORMAT keeps the day a plain string: a raw DATE arrives as a driver
         Date object and would shift with the connection timezone. */
      `SELECT DATE_FORMAT(DATE(DATE_ADD(solved_at, INTERVAL ${tzOffsetMinutes} MINUTE)), '%Y-%m-%d') AS day,
              COUNT(*) AS solved
         FROM problem_progress
        WHERE owner_key = ? AND solved = 1 AND solved_at IS NOT NULL
          AND solved_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${days + 2} DAY)
        GROUP BY day
        ORDER BY day ASC`,
      [PROGRESS_OWNER]
    ),
    query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(ok), 0) AS successful,
              COUNT(DISTINCT slug) AS problems_tried
         FROM problem_runs WHERE owner_key = ?`,
      [PROGRESS_OWNER]
    ),
    query(
      `SELECT MIN(solved_at) AS first_solved
         FROM problem_progress WHERE owner_key = ? AND solved = 1 AND solved_at IS NOT NULL`,
      [PROGRESS_OWNER]
    )
  ]);

  /* "Today" in the caller's timezone, from the same shift the SQL used. */
  const nowUtcMs = Date.now() + tzOffsetMinutes * 60000;
  const todayKey = toDayKey(new Date(nowUtcMs));

  const counts = toCountMap(dailyRows);
  const byDifficulty = DIFFICULTIES.map((difficulty) => {
    const row = solvedByDifficulty.find((entry) => entry.difficulty === difficulty) || {};
    const catalog = Number(
      catalogRows.find((entry) => entry.difficulty === difficulty)?.total || 0
    );
    const solved = Number(row.solved || 0);
    /* Only problems that really exist in the catalog may lower the catalog's
       completion percentage; the rest are reported separately. */
    const solvedInCatalog = Number(row.solved_in_catalog || 0);
    return {
      difficulty,
      total: catalog,
      solved,
      solvedInCatalog,
      percent: catalog > 0 ? Math.round((solvedInCatalog / catalog) * 100) : 0
    };
  });

  const totalProblems = byDifficulty.reduce((sum, row) => sum + row.total, 0);
  const totalSolved = byDifficulty.reduce((sum, row) => sum + row.solved, 0);
  const solvedInCatalog = byDifficulty.reduce((sum, row) => sum + row.solvedInCatalog, 0);
  const completionPercent = totalProblems > 0 ? Math.round((solvedInCatalog / totalProblems) * 100) : 0;

  const streaks = computeStreaks(counts, todayKey);
  const thisWeek = currentWeekRange(todayKey);
  const lastWeek = previousWeekRange(todayKey);
  const thisMonth = currentMonthRange(todayKey);
  const lastMonth = previousMonthRange(todayKey);

  const runsTotal = Number(runRows[0]?.total || 0);
  const runsSuccessful = Number(runRows[0]?.successful || 0);
  const firstSolved = activeSinceRows[0]?.first_solved || null;

  return {
    generatedAt: new Date().toISOString(),
    timezoneOffsetMinutes: tzOffsetMinutes,
    today: todayKey,
    catalog: {
      total: totalProblems,
      solved: solvedInCatalog,
      unsolved: Math.max(0, totalProblems - solvedInCatalog),
      completionPercent
    },
    solved: {
      total: totalSolved,
      /* Problems marked solved that are not part of the catalog. */
      outsideCatalog: Math.max(0, totalSolved - solvedInCatalog),
      byDifficulty,
      today: sumRange(counts, todayKey, todayKey),
      thisWeek: sumRange(counts, thisWeek.from, thisWeek.to),
      thisMonth: sumRange(counts, thisMonth.from, thisMonth.to)
    },
    streaks: {
      current: streaks.current,
      longest: streaks.longest,
      /* The day the very first problem was solved, in the caller's timezone. */
      firstSolvedAt: firstSolved
    },
    runs: {
      total: runsTotal,
      successful: runsSuccessful,
      failed: Math.max(0, runsTotal - runsSuccessful),
      problemsTried: Number(runRows[0]?.problems_tried || 0),
      /* "Runs" never means "accepted solutions" - see the module header. */
      note: "Server-executed runs only; browser JavaScript runs are not recorded."
    },
    comparison: {
      week: comparePeriods(
        sumRange(counts, thisWeek.from, thisWeek.to),
        sumRange(counts, lastWeek.from, lastWeek.to)
      ),
      month: comparePeriods(
        sumRange(counts, thisMonth.from, thisMonth.to),
        sumRange(counts, lastMonth.from, lastMonth.to)
      )
    },
    activity: {
      days,
      daily: buildDailySeries(counts, days, todayKey),
      weekly: buildWeeklySeries(counts, weeks, todayKey),
      monthly: buildMonthlySeries(counts, months, todayKey)
    }
  };
};

module.exports = {
  PROGRESS_OWNER,
  markSolved,
  listSolved,
  listActivity,
  recordRun,
  getSummary,
  normalizeSlug,
  normalizeDifficulty,
  normalizeTzOffset,
  normalizeDays,
  toDayKey,
  shiftDayKey,
  isoWeekKey,
  computeStreaks,
  buildDailySeries,
  buildWeeklySeries,
  buildMonthlySeries,
  comparePeriods
};