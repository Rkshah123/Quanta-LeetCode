/* ----------------------------- db / revision ------------------------------ */
/* Smart DSA revision: when each problem should be revisited next.
   The scheduling maths is a pure function (nextSchedule) so it can be tested
   without a database, and the queries below stay small and aggregated.

   Defaults: a problem is first reviewed the day after it is added, then after
   1, 3, 7, 14 and 30 days, doubling after the ladder runs out. Confidence
   moves along that ladder:

     again      could not solve or remember it -> back to the first rung (1 day)
     difficult  needed real help             -> stay on this rung, retry soon
     good       solved with some effort      -> up one rung
     easy       confident                    -> up two rungs

   Dates are calendar days chosen in the caller's timezone and stored as DATE, so
   no daylight-saving rule can shift a review by a day. */

const { query } = require("./pool");

const REVISION_OWNER = "default";

/* Default ladder in days. The user can override it per problem by rescheduling. */
const DEFAULT_LADDER = [1, 3, 7, 14, 30];
const LADDER_MAX_INTERVAL = 365;
const TITLE_MAX = 255;
const HISTORY_PAGE_MAX = 50;

const CONFIDENCE = ["again", "difficult", "good", "easy"];
const CONFIDENCE_LABELS = {
  again: "Again",
  difficult: "Difficult",
  good: "Good",
  easy: "Easy"
};

const DIFFICULTIES = ["Easy", "Medium", "Hard"];

/* ----------------------------- pure helpers ------------------------------ */

/* "YYYY-MM-DD" for the current moment shifted into the caller's timezone. */
const toDayKey = (date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const dayKeyToDate = (key) => {
  const [year, month, day] = String(key).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

const shiftDayKey = (key, days) => {
  const date = dayKeyToDate(key);
  date.setUTCDate(date.getUTCDate() + days);
  return toDayKey(date);
};

const compareDayKeys = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

const normalizeTzOffset = (value) => {
  const offset = Number(value);
  if (!Number.isFinite(offset)) return 0;
  return Math.max(-840, Math.min(840, Math.trunc(offset)));
};

const normalizeSlug = (value) => {
  const slug = String(value ?? "").trim().toLowerCase();
  if (!slug || slug.length > 191) return "";
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug)) return "";
  return slug;
};

const normalizeConfidence = (value) => (CONFIDENCE.includes(value) ? value : null);

const normalizeDifficulty = (value) => (DIFFICULTIES.includes(value) ? value : "Medium");

/* Accepts "YYYY-MM-DD" and refuses anything else, so a bad request can never
   push a review into the past or the year 0001 by accident. */
const normalizeDayKey = (value) => {
  const key = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "";
  const date = dayKeyToDate(key);
  if (Number.isNaN(date.getTime())) return "";
  if (toDayKey(date) !== key) return ""; /* rejects 2026-02-31 and similar */
  return key;
};

const clampLadder = (value) => {
  const list = Array.isArray(value) ? value : DEFAULT_LADDER;
  const cleaned = list
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isFinite(entry) && entry >= 1 && entry <= LADDER_MAX_INTERVAL);
  return cleaned.length ? cleaned.slice(0, 10) : DEFAULT_LADDER;
};

/* The interval for a rung. Inside the ladder it is the ladder entry; the first
   stage past the end is one doubling beyond the last rung (30 -> 60), and it
   keeps doubling up to a year. */
const intervalForStage = (stage, ladder) => {
  const steps = clampLadder(ladder);
  if (stage < steps.length) return steps[stage];
  const extra = stage - steps.length + 1;
  let interval = steps[steps.length - 1] * 2 ** extra;
  return Math.min(LADDER_MAX_INTERVAL, Math.round(interval));
};

/* The whole scheduling rule, in one testable place.
   `today` is the review day in the caller's timezone, as "YYYY-MM-DD".
   Returns the next stage, the interval used and the next due date. */
const nextSchedule = ({ stage = 0, confidence, today, ladder } = {}) => {
  const day = normalizeDayKey(today) || toDayKey(new Date());
  const rating = normalizeConfidence(confidence) || "good";
  const currentStage = Number.isInteger(stage) && stage >= 0 ? stage : 0;

  let nextStage = currentStage;
  if (rating === "again") nextStage = 0;
  else if (rating === "difficult") nextStage = currentStage;
  else if (rating === "good") nextStage = currentStage + 1;
  else nextStage = currentStage + 2; /* easy */

  const interval = intervalForStage(nextStage, ladder);
  return { stage: nextStage, intervalDays: interval, dueDate: shiftDayKey(day, interval) };
};

/* Buckets used by the dashboard. */
const bucketFor = (dueKey, todayKey, status) => {
  if (status === "completed") return "completed";
  if (compareDayKeys(dueKey, todayKey) < 0) return "overdue";
  if (dueKey === todayKey) return "today";
  return "upcoming";
};

/* Topics come from the catalog when the problem is in it. A problem that is not
   in the catalog simply has none - nothing is invented to fill the gap. */
const parseTopics = (value) => {
  if (Array.isArray(value)) return value.filter((topic) => typeof topic === "string" && topic).slice(0, 5);
  if (value === null || value === undefined) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((topic) => typeof topic === "string" && topic).slice(0, 5) : [];
  } catch {
    return [];
  }
};

const toItemDto = (row, todayKey) => {
  const dueDate = String(row.due_date || "").slice(0, 10);
  const topics = parseTopics(row.problem_topics);
  const noteTags = parseTopics(row.note_tags);
  /* The reader's own tags come first. They are specific to this problem and
     this reader - "hash map", "sliding window variant" - and they were typed on
     purpose. A catalog tag is a broad label applied to every problem of that
     kind, so it is the fallback rather than the answer.

     This was the other way round, because the catalog's topic column was empty
     for every problem and the question never arose. Now that the column is
     populated, leaving the order alone silently demoted the reader's own words
     to second place behind a generic label they had never chosen. */
  const topic = noteTags[0] ?? topics[0] ?? null;
  return {
    slug: row.slug,
    num: row.lc_num ?? null,
    title: row.title || "",
    difficulty: row.difficulty,
    stage: Number(row.stage) || 0,
    intervalDays: Number(row.interval_days) || 0,
    dueDate,
    confidence: row.confidence || null,
    status: row.status,
    bucket: bucketFor(dueDate, todayKey, row.status),
    reviewCount: Number(row.review_count) || 0,
    completedAt: row.completed_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    problemTitle: row.problem_title ?? null,
    topics,
    noteTags,
    topic,
    /* Must agree with the precedence above: whichever won is what the label
       says, so a card can never claim the topic came from the notes when it
       actually came from the catalog. */
    topicSource: noteTags.length ? "notes" : topics.length ? "catalog" : null
  };
};

const itemSelect = `SELECT i.slug, i.lc_num, i.title, i.difficulty, i.stage, i.interval_days,
                            DATE_FORMAT(i.due_date, '%Y-%m-%d') AS due_date,
                            i.confidence, i.status, i.review_count,
                            DATE_FORMAT(i.completed_at, '%Y-%m-%d %H:%i:%s') AS completed_at,
                            DATE_FORMAT(i.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
                            DATE_FORMAT(i.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
                            p.title AS problem_title, p.topics AS problem_topics,
                            n.tags AS note_tags
                       FROM revision_items i
                       LEFT JOIN problems p ON p.slug = i.slug
                       LEFT JOIN problem_notes n ON n.owner_key = i.owner_key AND n.slug = i.slug`;

/* ------------------------------ repository ------------------------------- */

/* Adds a problem to the revision list. Adding twice never creates a second row
   and never moves an existing due date - the schedule belongs to the item. */
const addItem = async (input = {}) => {
  const slug = normalizeSlug(input.slug);
  if (!slug) throw new Error("A valid problem slug is required.");
  const tzOffsetMinutes = normalizeTzOffset(input.tzOffsetMinutes);
  const todayKey = toDayKey(new Date(Date.now() + tzOffsetMinutes * 60000));

  /* Default first review: the day after adding. */
  const firstDue = shiftDayKey(todayKey, 1);
  const num = Number.parseInt(input.num, 10) > 0 ? Number.parseInt(input.num, 10) : null;
  const title = String(input.title || "").slice(0, TITLE_MAX);
  const difficulty = normalizeDifficulty(input.difficulty);

  /* Adding twice must never create a second row and never move the existing due
     date - the schedule belongs to the item. Values are merged here rather than
     compared in SQL, because this database's column collation differs from the
     server's string literals and a text comparison fails. */
  const existingRows = await query(
    "SELECT title, difficulty FROM revision_items WHERE owner_key = ? AND slug = ?",
    [REVISION_OWNER, slug]
  );
  const existing = existingRows[0];

  if (existing) {
    await query(
      "UPDATE revision_items SET lc_num = ?, title = ?, difficulty = ? WHERE owner_key = ? AND slug = ?",
      [num, title || existing.title, difficulty, REVISION_OWNER, slug]
    );
  } else {
    await query(
      `INSERT INTO revision_items
         (owner_key, slug, lc_num, title, difficulty, stage, interval_days, due_date, status)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?, 'active')`,
      [REVISION_OWNER, slug, num, title, difficulty, firstDue]
    );
  }

  const rows = await query(`${itemSelect} WHERE i.owner_key = ? AND i.slug = ?`, [REVISION_OWNER, slug]);
  return rows[0] ? toItemDto(rows[0], todayKey) : null;
};

const getItem = async (slug, todayKey) => {
  const cleanSlug = normalizeSlug(slug);
  if (!cleanSlug) return null;
  const rows = await query(`${itemSelect} WHERE i.owner_key = ? AND i.slug = ?`, [REVISION_OWNER, cleanSlug]);
  return rows[0] ? toItemDto(rows[0], todayKey) : null;
};

/* Records a review and schedules the next one. History is appended, never
   rewritten, and the ladder position moves only because of the confidence the
   user reported. */
const reviewItem = async (slug, input = {}) => {
  const cleanSlug = normalizeSlug(slug);
  if (!cleanSlug) throw new Error("A valid problem slug is required.");
  const confidence = normalizeConfidence(input.confidence);
  if (!confidence) throw new Error("Confidence must be again, difficult, good or easy.");

  const tzOffsetMinutes = normalizeTzOffset(input.tzOffsetMinutes);
  const todayKey = toDayKey(new Date(Date.now() + tzOffsetMinutes * 60000));

  const existing = await query(
    `SELECT stage, interval_days, review_count, status
       FROM revision_items WHERE owner_key = ? AND slug = ?`,
    [REVISION_OWNER, cleanSlug]
  );
  if (!existing[0]) return { notFound: true };
  if (existing[0].status === "completed") return { completed: true };

  const schedule = nextSchedule({
    stage: Number(existing[0].stage) || 0,
    confidence,
    today: todayKey,
    ladder: input.ladder
  });

  await query(
    `UPDATE revision_items
        SET stage = ?, interval_days = ?, due_date = ?, confidence = ?,
            review_count = review_count + 1, status = 'active'
      WHERE owner_key = ? AND slug = ?`,
    [schedule.stage, schedule.intervalDays, schedule.dueDate, confidence, REVISION_OWNER, cleanSlug]
  );

  await query(
    `INSERT INTO revision_reviews
       (owner_key, slug, confidence, stage_before, stage_after, interval_days, review_date, next_due_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      REVISION_OWNER,
      cleanSlug,
      confidence,
      Number(existing[0].stage) || 0,
      schedule.stage,
      schedule.intervalDays,
      todayKey,
      schedule.dueDate
    ]
  );

  return { item: await getItem(cleanSlug, todayKey), schedule };
};

/* Moves the due date without touching the ladder or the history - this is the
   "snooze" action. */
const rescheduleItem = async (slug, input = {}) => {
  const cleanSlug = normalizeSlug(slug);
  if (!cleanSlug) throw new Error("A valid problem slug is required.");
  const tzOffsetMinutes = normalizeTzOffset(input.tzOffsetMinutes);
  const todayKey = toDayKey(new Date(Date.now() + tzOffsetMinutes * 60000));

  let target = normalizeDayKey(input.dueDate);
  if (!target && Number.isInteger(input.snoozeDays) && input.snoozeDays >= 1 && input.snoozeDays <= 365) {
    target = shiftDayKey(todayKey, input.snoozeDays);
  }
  if (!target) throw new Error("Provide a dueDate (YYYY-MM-DD) or snoozeDays.");

  const result = await query(
    "UPDATE revision_items SET due_date = ?, status = 'active' WHERE owner_key = ? AND slug = ? AND status = 'active'",
    [target, REVISION_OWNER, cleanSlug]
  );
  if (!result?.affectedRows) return { notFound: true };
  return { item: await getItem(cleanSlug, todayKey) };
};

/* Finishes a problem: it leaves the schedule but keeps every review it had.
   Doing this twice is safe and honest - the first time is recorded and kept,
   and a repeat says so instead of quietly moving the date it was finished. */
const completeItem = async (slug, input = {}) => {
  const cleanSlug = normalizeSlug(slug);
  if (!cleanSlug) throw new Error("A valid problem slug is required.");
  const tzOffsetMinutes = normalizeTzOffset(input.tzOffsetMinutes);
  const todayKey = toDayKey(new Date(Date.now() + tzOffsetMinutes * 60000));

  const existing = await query(
    "SELECT status, completed_at FROM revision_items WHERE owner_key = ? AND slug = ?",
    [REVISION_OWNER, cleanSlug]
  );
  if (!existing[0]) return { notFound: true };
  const alreadyCompleted = existing[0].status === "completed" && Boolean(existing[0].completed_at);

  if (alreadyCompleted) {
    return { item: await getItem(cleanSlug, todayKey), alreadyCompleted: true };
  }

  await query(
    "UPDATE revision_items SET status = 'completed', completed_at = UTC_TIMESTAMP() WHERE owner_key = ? AND slug = ?",
    [REVISION_OWNER, cleanSlug]
  );
  return { item: await getItem(cleanSlug, todayKey), alreadyCompleted: false };
};

/* Removes a problem from the list. The review history is deliberately kept:
   "accidental loss of schedule history" must not happen by deleting a row. */
const removeItem = async (slug) => {
  const cleanSlug = normalizeSlug(slug);
  if (!cleanSlug) return false;
  const result = await query("DELETE FROM revision_items WHERE owner_key = ? AND slug = ?", [REVISION_OWNER, cleanSlug]);
  return (result?.affectedRows || 0) > 0;
};

/* Everything the revision dashboard shows, in two queries. */
const getDashboard = async (options = {}) => {
  const tzOffsetMinutes = normalizeTzOffset(options.tzOffsetMinutes);
  const todayKey = toDayKey(new Date(Date.now() + tzOffsetMinutes * 60000));

  const rows = await query(
    `${itemSelect}
      WHERE i.owner_key = ?
      ORDER BY (i.status = 'completed') ASC, i.due_date ASC, i.slug ASC`,
    [REVISION_OWNER]
  );

  const items = rows.map((row) => toItemDto(row, todayKey));
  const active = items.filter((item) => item.status === "active");
  const overdue = active.filter((item) => item.bucket === "overdue");
  const today = active.filter((item) => item.bucket === "today");
  const upcoming = active.filter((item) => item.bucket === "upcoming");
  const completed = items.filter((item) => item.status === "completed");

  /* "Done today" means reviews actually recorded today, not items whose due date
     happens to be today - a problem revised early still counts. Reviews of
     problems that were later removed still appear here, because the history is
     append-only and the History page shows exactly the same rows.

     The progress bar compares work finished with work left. A problem that was
     due is no longer due once it has been reviewed, so both halves are needed:
     what is still waiting (overdue + due today) and what was done today. */
  const reviewedTodayRows = await query(
    `SELECT DISTINCT slug
       FROM revision_reviews
      WHERE owner_key = ? AND review_date = ?
      LIMIT 500`,
    [REVISION_OWNER, todayKey]
  );
  const reviewedTodaySlugs = new Set(reviewedTodayRows.map((row) => row.slug));
  const reviewedToday = reviewedTodayRows.length;

  const dueTotal = overdue.length + today.length;
  const listSlugs = new Set(items.map((item) => item.slug));
  const doneToday = [...reviewedTodaySlugs].filter((slug) => listSlugs.has(slug)).length;
  const workedTotal = dueTotal + doneToday;
  const progressPercent = workedTotal > 0 ? Math.round((doneToday / workedTotal) * 100) : 0;

  return {
    generatedAt: new Date().toISOString(),
    today: todayKey,
    timezoneOffsetMinutes: tzOffsetMinutes,
    ladder: DEFAULT_LADDER,
    counts: {
      dueToday: today.length,
      overdue: overdue.length,
      upcoming: upcoming.length,
      completed: completed.length,
      total: items.length,
      reviewedToday,
      doneToday,
      dueTotal,
      progressPercent
    },
    items
  };
};

/* Review history, newest first, paginated. */
const listHistory = async ({ slug, limit, offset } = {}) => {
  const cleanSlug = normalizeSlug(slug);
  const safeLimit = Math.min(Number.parseInt(limit, 10) > 0 ? Number.parseInt(limit, 10) : 20, HISTORY_PAGE_MAX);
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);

  const where = cleanSlug ? "WHERE owner_key = ? AND slug = ?" : "WHERE owner_key = ?";
  const params = cleanSlug ? [REVISION_OWNER, cleanSlug] : [REVISION_OWNER];

  const totals = await query(`SELECT COUNT(*) AS total FROM revision_reviews ${where}`, params);
  const rows = await query(
    `SELECT id, slug, confidence, stage_before, stage_after, interval_days,
            DATE_FORMAT(review_date, '%Y-%m-%d') AS review_date,
            DATE_FORMAT(next_due_date, '%Y-%m-%d') AS next_due_date,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
       FROM revision_reviews ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset]
  );

  return {
    items: rows.map((row) => ({
      id: Number(row.id),
      slug: row.slug,
      confidence: row.confidence,
      confidenceLabel: CONFIDENCE_LABELS[row.confidence] || row.confidence,
      stageBefore: Number(row.stage_before) || 0,
      stageAfter: Number(row.stage_after) || 0,
      intervalDays: Number(row.interval_days) || 0,
      reviewDate: row.review_date,
      nextDueDate: row.next_due_date,
      createdAt: row.created_at
    })),
    total: Number(totals[0]?.total || 0),
    limit: safeLimit,
    offset: safeOffset
  };
};

module.exports = {
  REVISION_OWNER,
  DEFAULT_LADDER,
  CONFIDENCE,
  CONFIDENCE_LABELS,
  addItem,
  getItem,
  reviewItem,
  rescheduleItem,
  completeItem,
  removeItem,
  getDashboard,
  listHistory,
  nextSchedule,
  intervalForStage,
  bucketFor,
  toDayKey,
  shiftDayKey,
  normalizeDayKey,
  normalizeSlug,
  normalizeConfidence,
  normalizeTzOffset,
  clampLadder,
  parseTopics,
  compareDayKeys
};