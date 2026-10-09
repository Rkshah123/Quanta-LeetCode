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

/* GET /api/problems — search + paginate. Never loads the whole table. */
const listProblems = async (options = {}) => {
  const limit = clampLimit(options.limit);
  const offset = clampOffset(options.offset);

  const where = [];
  const params = [];

  const search = String(options.q || "").trim();
  if (search) {
    if (/^\d+$/.test(search)) {
      /* Exact problem number: "53" must not match 530/1530. */
      where.push("(lc_num = ? OR title LIKE ?)");
      params.push(Number(search), `%${search}%`);
    } else {
      where.push("(title LIKE ? OR slug LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
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

  let join = "";
  const category = String(options.category || "").trim();
  if (category) {
    join =
      " JOIN problem_categories pc ON pc.problem_id = p.id" +
      " JOIN categories c ON c.id = pc.category_id AND (c.slug = ? OR c.name = ?)";
    params.push(category, category);
  }

  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  const countRow = (
    await query(
      `SELECT COUNT(DISTINCT p.id) AS total FROM problems p${join}${whereSql}`,
      params
    )
  )[0];

  const rows = await query(
    `SELECT p.id, p.lc_num, p.slug, p.title, p.difficulty, p.url, p.topics,
            (p.description_html IS NOT NULL) AS has_description, p.updated_at
       FROM problems p${join}${whereSql}
      ORDER BY (p.lc_num IS NULL) ASC, p.lc_num ASC, p.title ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return {
    items: rows.map((row) => ({
      id: row.id,
      num: row.lc_num ?? null,
      slug: row.slug,
      title: row.title,
      difficulty: row.difficulty,
      url: row.url,
      topics: parseJson(row.topics),
      hasDescription: Boolean(Number(row.has_description)),
      updatedAt: row.updated_at
    })),
    total: Number(countRow?.total || 0),
    limit,
    offset
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
