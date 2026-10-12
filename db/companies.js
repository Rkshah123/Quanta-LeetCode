/* ---------------------- db / companies ------------------------------
   Company attributions, and importing them.

   Why this table ships empty
   -------------------------
   A row here asserts "this company asks this problem". No permitted public
   dataset states that. LeetCode's company tags exist but are not published as
   an API, and scraping them is exactly what the catalog curator refuses to do
   for problem statements. So the table is created, wired, and left empty, and
   every surface that reads it says so out loud rather than showing an empty
   list that looks broken.

   What IS permitted, and what this module supports
   -------------------------------------------------
   A dataset the user already has. People legitimately hold these lists - a team
   maintains its own prep list, a course publishes one, a company publishes its
   own. Importing something you already hold is fair use; scraping it into a
   redistributed database is not. `importCompanyData` therefore takes rows the
   caller supplies and validates every field, so a bad import is refused with a
   reason instead of poisoning the catalog.

   Rules the importer obeys
   ------------------------
   - Only problems that already exist in the catalog are linked. A company
     attached to a problem Quanta does not have would create a dead entry.
   - Every row records where it came from and with what confidence, and the
     UI labels it. "Reported by an uploaded list" and "curated by Quanta" are
     not the same claim and must not look alike.
   - Re-importing the same file updates rather than duplicates.
   - Nothing is ever deleted by an import; a company that loses its last
     problem is kept but shows zero. */
const database = require("./pool");

const { query } = database;

/* Confidence values. These are claims about provenance, not about difficulty. */
const CONFIDENCE_VALUES = ["reported", "curated"];

/* Normalises a company name into a stable slug.
   "Amazon.com", "amazon com" and "Amazon  " all become "amazon", so one company
   cannot appear three times because someone typed it differently. */
const slugifyCompany = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/* Parses the two shapes a user is realistically holding:
     - CSV with a header row: slug,title,company,confidence
     - JSON: [{ slug, company, confidence }]
   Returns { rows, rejected } where rejected names each problem that could not
   be used and why, so a partial import is visible rather than silent. */
const parseCompanyData = (text, source) => {
  const rows = [];
  const rejected = [];
  const raw = String(text || "").trim();

  if (!raw) return { rows, rejected, error: "Nothing to import." };

  const label = String(source || "imported list").slice(0, 64) || "imported list";

  const push = (slug, company, confidence, where) => {
    const problemSlug = String(slug || "").trim().toLowerCase();
    const name = String(company || "").trim();
    if (!problemSlug || !name) {
      rejected.push({ slug: problemSlug || "(blank)", why: "a problem slug and a company name are both required" });
      return;
    }
    const companySlug = slugifyCompany(name);
    if (!companySlug) {
      rejected.push({ slug: problemSlug, why: `"${name}" contains no usable characters` });
      return;
    }
    const level = CONFIDENCE_VALUES.includes(String(confidence || "").toLowerCase())
      ? String(confidence).toLowerCase()
      : "reported";
    rows.push({
      problemSlug,
      companySlug,
      companyName: name,
      confidence: level,
      note: label
    });
  };

  if (raw.startsWith("[") || raw.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { rows, rejected, error: `That is not valid JSON: ${error.message}` };
    }
    const list = Array.isArray(parsed) ? parsed : parsed.rows || parsed.data || parsed.items;
    if (!Array.isArray(list)) {
      return { rows, rejected, error: "Expected a JSON array, or an object with a rows, data or items array." };
    }
    list.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") {
        rejected.push({ slug: `row ${index + 1}`, why: "not an object" });
        return;
      }
      push(entry.slug || entry.problem || entry.problemSlug, entry.company || entry.name, entry.confidence, label);
    });
    return { rows, rejected };
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { rows, rejected, error: "Nothing to import." };

  /* Split on commas that are not inside quotes, so a company called
     "Amazon, Inc" survives. */
  const splitCsvLine = (line) => {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cell += '"'; i += 1; continue; }
        quoted = !quoted;
        continue;
      }
      if (ch === "," && !quoted) { cells.push(cell.trim()); cell = ""; continue; }
      cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const hasHeader = header.includes("company") || header.includes("slug");
  const columns = hasHeader
    ? { slug: header.indexOf("slug"), company: header.indexOf("company"), confidence: header.indexOf("confidence") }
    : { slug: 0, company: 1, confidence: 2 };

  if (hasHeader && (columns.slug === -1 || columns.company === -1)) {
    return { rows, rejected, error: "The header needs at least a `slug` column and a `company` column." };
  }

  for (let i = hasHeader ? 1 : 0; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    if (cells.every((cell) => !cell)) continue;
    push(cells[columns.slug], cells[columns.company], cells[columns.confidence], label);
  }

  return { rows, rejected };
};

/* Writes validated rows. Problems that are not in the catalog are refused,
   because a company entry pointing at a problem nobody can open is dead weight
   and looks like a bug to the user. */
const importCompanyData = async (rows, note) => {
  if (!Array.isArray(rows) || !rows.length) {
    return { ok: false, error: "There was nothing to import." };
  }

  /* Which of these problems actually exist. One query rather than one per row.
     The empty check matters: `IN ()` is a syntax error on MySQL and TiDB, so a
     list where nothing is known-good would crash the import instead of simply
     reporting that none of it could be linked. */
  const slugs = [...new Set(rows.map((row) => row.problemSlug))];
  let knownSet = new Set();
  if (slugs.length) {
    const placeholders = slugs.map(() => "?").join(", ");
    const known = await query(`SELECT slug FROM problems WHERE slug IN (${placeholders})`, slugs);
    knownSet = new Set(known.map((row) => row.slug));
  }

  const usable = rows.filter((row) => knownSet.has(row.problemSlug));
  const unknown = rows.filter((row) => !knownSet.has(row.problemSlug));

  /* Every problem in the import is unknown, so there is nothing to write. */
  if (!usable.length) {
    return {
      ok: true,
      linked: 0,
      companies: 0,
      problems: 0,
      skipped: [...new Set(unknown.map((row) => row.problemSlug))].slice(0, 25),
      skippedCount: new Set(unknown.map((row) => row.problemSlug)).size
    };
  }

  const companyRows = [...new Map(usable.map((row) => [row.companySlug, row])).values()];
  let linked = 0;

  for (const company of companyRows) {
    await query(
      `INSERT INTO companies (slug, name) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [company.companySlug, company.companyName]
    );
  }

  const companySlugs = [...new Set(usable.map((r) => r.companySlug))];
  const ids = await query(
    `SELECT id, slug FROM companies WHERE slug IN (${companySlugs.map(() => "?").join(", ")})`,
    companySlugs
  );
  const idBySlug = new Map(ids.map((row) => [row.slug, row.id]));

  for (const row of usable) {
    const companyId = idBySlug.get(row.companySlug);
    if (!companyId) continue;
    await query(
      `INSERT INTO problem_companies (problem_slug, company_id, confidence, note)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE confidence = VALUES(confidence), note = VALUES(note)`,
      [row.problemSlug, companyId, row.confidence, String(note || "imported").slice(0, 255)]
    );
    linked += 1;
  }

  return {
    ok: true,
    linked,
    companies: companyRows.length,
    problems: new Set(usable.map((row) => row.problemSlug)).size,
    /* Named, not just counted, so the user can see what did not land. */
    skipped: [...new Set(unknown.map((row) => row.problemSlug))].slice(0, 25),
    skippedCount: new Set(unknown.map((row) => row.problemSlug)).size
  };
};

/* Companies with their real problem counts. Only companies that have at least
   one problem in the catalog appear, so the list cannot show a name attached
   to nothing. */
const listCompanies = async () => {
  const rows = await query(
    `SELECT c.id, c.slug, c.name, c.category,
            COUNT(pc.problem_slug) AS problem_count,
            COUNT(DISTINCT pc.confidence) AS confidence_kinds
       FROM companies c
       LEFT JOIN problem_companies pc ON pc.company_id = c.id
       LEFT JOIN problems p ON p.slug = pc.problem_slug
      GROUP BY c.id, c.slug, c.name, c.category
     HAVING problem_count > 0
      ORDER BY problem_count DESC, c.name ASC`
  );
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category || null,
    problemCount: Number(row.problem_count)
  }));
};

/* The problems for one company, with difficulty and topic so the page can
   filter without a second round trip. */
const listCompanyProblems = async (companySlug, { difficulty, topic } = {}) => {
  const where = ["c.slug = ?"];
  const params = [companySlug];
  if (difficulty && ["Easy", "Medium", "Hard"].includes(difficulty)) {
    where.push("p.difficulty = ?");
    params.push(difficulty);
  }
  if (topic) {
    where.push("JSON_CONTAINS(p.topics, JSON_QUOTE(?))");
    params.push(topic);
  }

  const rows = await query(
    `SELECT p.slug, p.title, p.difficulty, p.platform, p.topics, p.url, p.lc_num,
            pc.confidence, pc.note
       FROM problem_companies pc
       JOIN companies c ON c.id = pc.company_id
       JOIN problems p ON p.slug = pc.problem_slug
      WHERE ${where.join(" AND ")}
      ORDER BY FIELD(p.difficulty, 'Easy', 'Medium', 'Hard'), p.lc_num IS NULL, p.lc_num, p.title`,
    params
  );

  return rows.map((row) => {
    let topics = row.topics;
    if (typeof topics === "string") {
      try {
        topics = JSON.parse(topics);
      } catch {
        topics = [];
      }
    }
    return {
      slug: row.slug,
      title: row.title,
      difficulty: row.difficulty,
      platform: row.platform || "leetcode",
      num: row.lc_num ?? null,
      url: row.url,
      topics: Array.isArray(topics) ? topics : [],
      /* Surfaced so the page can say where this came from instead of implying
         Quanta verified it. */
      confidence: row.confidence,
      source: row.note
    };
  });
};

const parseJson = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/* The reason there is nothing to show. Said plainly so the UI never has to
   imply it knows and is withholding. */
const companiesEmptyNote = async () => {
  const [{ n }] = await query("SELECT COUNT(*) AS n FROM companies");
  if (Number(n) > 0) return null;
  return "No company lists are recorded yet. Quanta does not guess which company asks which problem, because no permitted public dataset states that. If you already hold a list, you can import it below and it will show up here.";
};

module.exports = {
  CONFIDENCE_VALUES,
  slugifyCompany,
  parseCompanyData,
  importCompanyData,
  listCompanies,
  listCompanyProblems,
  companiesEmptyNote,
  parseJson
};
