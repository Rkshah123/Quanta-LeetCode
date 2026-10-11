/* ----------------------------- db / problems ---------------------------- */
/* Repository for the problem catalog. Every statement is parameterized, every
   value is validated by the caller (server.js), and no result ever contains
   credentials. */

const { query } = require("./pool");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const parseJson = (value) => {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const toSummary = (row) => ({
  id: row.id,
  num: row.lc_num ?? null,
  slug: row.slug,
  title: row.title,
  difficulty: row.difficulty,
  url: row.url,
  topics: parseJson(row.topics),
  hasDescription: Boolean(row.description_html),
  updatedAt: row.updated_at
});

const toDetail = (row, examples = [], categories = []) => ({
  ...toSummary(row),
  descriptionHtml: row.description_html || "",
  examples: examples.map((example) => ({
    position: example.position,
    input: example.input_text ?? "",
    output: example.output_text ?? "",
    explanation: example.explanation_text ?? ""
  })),
  categories
});

const clampLimit = (value) => {
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
};

const clampOffset = (value) => {
  const offset = Number.parseInt(value, 10);
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.min(offset, 1000000);
};

/* Every sort the API accepts, in one place so the route can validate the same
   list. "catalog" keeps the original order (problems without a LeetCode number
   last), and every sort falls back to the problem number so equal rows never
   shuffle between requests. */
const PROBLEM_SORTS = ["catalog", "title", "difficulty", "solved", "attempted", "revision"];
const PROBLEM_STATUS_FILTERS = ["all", "yes", "no"];
const REVISION_FILTERS = ["all", "scheduled", "due", "overdue"];
const STATEMENT_FILTERS = ["all", "stored", "missing"];

const SORT_SQL = {
  catalog: "(p.lc_num IS NULL) ASC, p.lc_num ASC, p.title ASC",
  title: "p.title ASC, (p.lc_num IS NULL) ASC, p.lc_num ASC",
  difficulty: "FIELD(p.difficulty, 'Easy', 'Medium', 'Hard') ASC, p.lc_num ASC",
  /* Most recently solved first; problems never solved sink to the bottom. */
  solved: "(pp.solved_at IS NULL) ASC, pp.solved_at DESC, p.lc_num ASC",
  /* Most recently attempted first, whether or not the run succeeded. */
  attempted: "(lr.last_run_at IS NULL) ASC, lr.last_run_at DESC, p.lc_num ASC",
  /* Next review soonest first; problems that are not scheduled sink to the
     bottom rather than being treated as due in 1970. */
  revision: "(ri.due_date IS NULL) ASC, ri.due_date ASC, p.lc_num ASC"
};

const PROBLEM_OWNER = "default";

/* GET /api/problems — search, filter, sort and paginate.
   Never loads the whole table: every extra table is only joined when the caller
   actually asks for something from it. */
const listProblems = async (options = {}) => {
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);
  const sort = PROBLEM_SORTS.includes(options.sort) ? options.sort : "catalog";

  const where = [];
  const params = [];

  const search = String(options.q || "").trim();
  if (search) {
    /* LIKE wildcards typed by a user are escaped, so a search for "100%" finds
       nothing rather than matching everything. */
    const pattern = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    /* The terms are OR-ed inside one group, so looking inside the statement
       widens the search instead of narrowing it to problems that match both
       the title and the text. */
    const terms = [];
    const termParams = [];
    if (/^\d+$/.test(search)) {
      /* An exact problem number is the strongest signal, but a title that
         contains the digits is still a useful result ("15" also finds
         "15-puzzle"). */
      terms.push("p.lc_num = ?", "p.title LIKE ?");
      termParams.push(Number(search), pattern);
    } else {
      terms.push("p.title LIKE ?", "p.slug LIKE ?");
      termParams.push(pattern, pattern);
    }
    /* Statement text is only searched when asked for: it is a large column and
       almost never what someone typing a problem name wants. */
    if (options.inStatement === true) {
      terms.push("p.description_html LIKE ?");
      termParams.push(pattern);
    }
    where.push(`(${terms.join(" OR ")})`);
    params.push(...termParams);
  }

  const difficulty = String(options.difficulty || "").trim();
  if (difficulty && difficulty !== "all") {
    where.push("p.difficulty = ?");
    params.push(difficulty);
  }

  if (options.hasDescription === true) where.push("p.description_html IS NOT NULL");
  if (options.hasDescription === false) where.push("p.description_html IS NULL");

  if (Number.isInteger(options.lcNum) && options.lcNum > 0) {
    where.push("p.lc_num = ?");
    params.push(options.lcNum);
  }

  const status = PROBLEM_STATUS_FILTERS.includes(options.solved) ? options.solved : "all";
  const revisionFilter = REVISION_FILTERS.includes(options.revision) ? options.revision : "all";
  const statementFilter = STATEMENT_FILTERS.includes(options.statement) ? options.statement : "all";

  if (statementFilter === "stored") where.push("p.description_html IS NOT NULL");
  if (statementFilter === "missing") where.push("p.description_html IS NULL");

  /* Solved state and review schedule live in their own tables, which are joined
     only when the request needs them. Both are scoped to one owner. */
  const joinParts = [];
  const joinParams = [];

  if (status !== "all" || sort === "solved") {
    joinParts.push("LEFT JOIN problem_progress pp ON pp.owner_key = ? AND pp.slug = p.slug");
    joinParams.push(PROBLEM_OWNER);
  }
  if (status === "yes") where.push("pp.solved = 1");
  if (status === "no") where.push("(pp.solved IS NULL OR pp.solved = 0)");

  if (revisionFilter !== "all" || sort === "revision") {
    joinParts.push("LEFT JOIN revision_items ri ON ri.owner_key = ? AND ri.slug = p.slug");
    joinParams.push(PROBLEM_OWNER);
  }
  if (revisionFilter === "scheduled") where.push("ri.slug IS NOT NULL");
  /* "Due" and "overdue" only ever mean problems still on the schedule: a
     finished problem is not due however far its old date has passed. */
  if (revisionFilter === "due") where.push("(ri.status = 'active' AND ri.due_date = ?)");
  if (revisionFilter === "overdue") where.push("(ri.status = 'active' AND ri.due_date < ?)");
  if (revisionFilter === "due" || revisionFilter === "overdue") {
    params.push(String(options.today || "").slice(0, 10));
  }

  if (sort === "attempted") {
    /* One grouped scan of this owner's runs, not a correlated subquery per row. */
    joinParts.push(
      "LEFT JOIN (SELECT slug, MAX(created_at) AS last_run_at FROM problem_runs WHERE owner_key = ? GROUP BY slug) lr ON lr.slug = p.slug"
    );
    joinParams.push(PROBLEM_OWNER);
  }

  let join = "";
  const category = String(options.category || "").trim();
  if (category) {
    joinParts.unshift(
      "JOIN problem_categories pc ON pc.problem_id = p.id" +
        " JOIN categories c ON c.id = pc.category_id AND (c.slug = ? OR c.name = ?)"
    );
    joinParams.unshift(category, category);
  }
  /* The joins are written without leading spaces and joined with one space
     between them, so the result always reads `FROM problems p LEFT JOIN ...`. */
if (joinParts.length) join = ` ${joinParts.join(" ")}`;

  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  /* Placeholders are positional, so they must be given in the order the SQL
     reads them: the JOIN conditions first, then the WHERE conditions. Before
     this was one array, which put a search term where the category was
     expected whenever both were used together. */
  const queryParams = [...joinParams, ...params];

  const countRow = (
    await query(`SELECT COUNT(DISTINCT p.id) AS total FROM problems p${join}${whereSql}`, queryParams)
  )[0];

  /* Only the joined tables the caller asked about are read, and a column that
     was not joined is simply not selected. */
  const extraColumns = [];
  if (status !== "all" || sort === "solved") {
    extraColumns.push("(pp.solved IS NOT NULL AND pp.solved = 1) AS is_solved");
    extraColumns.push("DATE_FORMAT(pp.solved_at, '%Y-%m-%d %H:%i:%s') AS solved_at");
  }
  if (revisionFilter !== "all" || sort === "revision") {
    extraColumns.push("ri.status AS revision_status");
    extraColumns.push("DATE_FORMAT(ri.due_date, '%Y-%m-%d') AS revision_due_date");
  }
  if (sort === "attempted") extraColumns.push("DATE_FORMAT(lr.last_run_at, '%Y-%m-%d %H:%i:%s') AS last_run_at");


  const rows = await query(
    `SELECT p.id, p.lc_num, p.slug, p.title, p.difficulty, p.url, p.topics,
            (p.description_html IS NOT NULL) AS has_description, p.updated_at
            ${extraColumns.length ? `, ${extraColumns.join(",\n            ")}` : ""}
       FROM problems p${join}${whereSql}
      ORDER BY ${SORT_SQL[sort]}
      LIMIT ? OFFSET ?`,
    [...queryParams, limit, offset]
  );

  return {
    items: rows.map((row) => {
      const item = {
        id: row.id,
        num: row.lc_num ?? null,
        slug: row.slug,
        title: row.title,
        difficulty: row.difficulty,
        url: row.url,
        topics: parseJson(row.topics),
        hasDescription: Boolean(Number(row.has_description)),
        updatedAt: row.updated_at
      };
      /* These are only present when the request asked about them, so a client
         never reads a field that was not really queried. */
      if (row.is_solved !== undefined) {
        item.solved = Boolean(Number(row.is_solved));
        item.solvedAt = row.solved_at || null;
      }
      if (row.revision_status !== undefined) {
        item.revisionStatus = row.revision_status || null;
        item.revisionDueDate = row.revision_due_date || null;
      }
      if (row.last_run_at !== undefined) item.lastRunAt = row.last_run_at || null;
      return item;
    }),
    total: Number(countRow?.total || 0),
    limit,
    offset,
    sort
  };
};

const findProblem = async ({ id, slug, num }) => {
  if (slug) {
    const rows = await query("SELECT * FROM problems WHERE slug = ? LIMIT 1", [slug]);
    if (rows.length) return rows[0];
  }
  if (Number.isInteger(id) && id > 0) {
    const rows = await query("SELECT * FROM problems WHERE id = ? LIMIT 1", [id]);
    if (rows.length) return rows[0];
  }
  if (Number.isInteger(num) && num > 0) {
    const rows = await query("SELECT * FROM problems WHERE lc_num = ? LIMIT 1", [num]);
    if (rows.length) return rows[0];
  }
  return null;
};

const getExamples = async (problemId) =>
  query(
    "SELECT position, input_text, output_text, explanation_text FROM problem_examples WHERE problem_id = ? ORDER BY position ASC",
    [problemId]
  );

const getCategories = async (problemId) =>
  query(
    "SELECT c.slug, c.name FROM categories c" +
      " JOIN problem_categories pc ON pc.category_id = c.id" +
      " WHERE pc.problem_id = ? ORDER BY c.position ASC, c.name ASC",
    [problemId]
  );

const getProblemDetail = async ({ id, slug, num }) => {
  const row = await findProblem({ id, slug, num });
  if (!row) return null;
  const [examples, categories] = await Promise.all([getExamples(row.id), getCategories(row.id)]);
  return toDetail(row, examples, categories);
};

/* Called when a description arrives from LeetCode (live proxy or importer).
   Only fills catalog rows that already exist — it never invents records. */
const saveFetchedDescription = async (slug, html) => {
  if (!slug || typeof html !== "string" || !html.trim()) return 0;
  const result = await query(
    "UPDATE problems SET description_html = ? WHERE slug = ? AND (description_html IS NULL OR description_html <> ?)",
    [html, slug, html]
  );
  return result?.affectedRows || 0;
};

/* Learns the real LeetCode number / title / difficulty for a slug, used when
   a description arrives for a problem that is not in the catalog yet. Returns
   null when LeetCode cannot be reached or the problem does not exist. */
const fetchLeetCodeMeta = async (slug) => {
  try {
    const response = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: "https://leetcode.com" },
      body: JSON.stringify({
        query:
          "query questionData($titleSlug: String!) { question(titleSlug: $titleSlug) { questionFrontendId title difficulty } }",
        variables: { titleSlug: slug }
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const question = payload?.data?.question;
    if (!question?.questionFrontendId || !question.title) return null;
    const difficulty = ["Easy", "Medium", "Hard"].includes(question.difficulty) ? question.difficulty : "Medium";
    return { num: Number(question.questionFrontendId), title: String(question.title).trim(), difficulty };
  } catch {
    return null;
  }
};

/* Repeatable import path used by the live endpoint and the import script:
   store the description for an existing row, or create the row from real
   LeetCode metadata. Never overwrites an existing statement unless it differs
   and the row was empty — existing user-visible data is left untouched. */
const importDescription = async (slug, html) => {
  if (!slug || typeof html !== "string" || !html.trim()) return false;
  if (await saveFetchedDescription(slug, html)) return true;

  const meta = await fetchLeetCodeMeta(slug);
  if (!meta) return false;

  const url = `https://leetcode.com/problems/${slug}/`;
  /* The slug is known to be absent here, so a plain INSERT is used: an
     ON DUPLICATE KEY UPDATE could attach this statement to a different row
     whose lc_num happens to match. */
  const insertSql =
    "INSERT INTO problems (lc_num, slug, title, difficulty, url, description_html, source) VALUES (?, ?, ?, ?, ?, ?, 'leetcode')";
  try {
    await query(insertSql, [meta.num, slug, meta.title, meta.difficulty, url, html]);
    return true;
  } catch (error) {
    if (error?.code !== "ER_DUP_ENTRY") return false;
    /* lc_num already used by another row — keep the slug unique instead. */
    try {
      await query(insertSql, [null, slug, meta.title, meta.difficulty, url, html]);
      return true;
    } catch {
      /* the row appeared meanwhile (another request) — its own write wins */
      return false;
    }
  }
};

const listCategories = async () =>
  query("SELECT id, slug, name, position FROM categories ORDER BY position ASC, name ASC");

module.exports = {
  listProblems,
  findProblem,
  getProblemDetail,
  PROBLEM_SORTS,
  PROBLEM_STATUS_FILTERS,
  REVISION_FILTERS,
  STATEMENT_FILTERS,
  getExamples,
  getCategories,
  saveFetchedDescription,
  importDescription,
  listCategories,
  toSummary,
  toDetail,
  clampLimit,
  clampOffset
};
