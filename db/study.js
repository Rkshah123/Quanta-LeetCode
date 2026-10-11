/* ------------------------------ db / study ------------------------------- */
/* Personal study notes and saved solutions.
   These are private working documents: notes you write about a problem, and the
   versions of your solution you want to keep. Nothing here is ever described as
   correct or accepted - the runner cannot check a problem's hidden test cases,
   so a stored solution is simply what you wrote.

   Concurrency: every write carries the `revision` the client edited. If the
   stored revision has moved on (the same note or solution was changed on another
   device), the write is refused and the current server copy is returned, so a
   slow device can never silently overwrite newer work. */

const { query } = require("./pool");

/* One implicit owner, same as db/progress.js - this app has no login system. */
const STUDY_OWNER = "default";

const LANGUAGE_MAX = 32;
const TITLE_MAX = 255;
const COMPLEXITY_MAX = 64;
const TEXT_MAX = 60000;
const CODE_MAX = 400000;
const TAG_MAX = 12;
const TAG_LENGTH_MAX = 32;
const SOLUTION_PAGE_MAX = 100;
const SEARCH_MAX = 200;

const DIFFICULTIES = ["Easy", "Medium", "Hard"];

/* ----------------------------- pure helpers ------------------------------ */

const cleanText = (value, max = TEXT_MAX) => String(value ?? "").slice(0, max);

/* Tags are stored as a JSON array; anything else is dropped rather than guessed. */
const normalizeTags = (value) => {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set();
  const tags = [];
  list.forEach((raw) => {
    if (tags.length >= TAG_MAX) return;
    const tag = String(raw ?? "").trim().slice(0, TAG_LENGTH_MAX).toLowerCase();
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    tags.push(tag);
  });
  return tags;
};

const normalizeLanguage = (value) => String(value ?? "").trim().toLowerCase().slice(0, LANGUAGE_MAX) || "java";

const normalizeSlug = (value) => {
  const slug = String(value ?? "").trim().toLowerCase();
  if (!slug || slug.length > 191) return "";
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug)) return "";
  return slug;
};

const clampLimit = (value, fallback = 50, max = SOLUTION_PAGE_MAX) => {
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1) return fallback;
  return Math.min(limit, max);
};

const clampOffset = (value) => {
  const offset = Number.parseInt(value, 10);
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.min(offset, 1000000);
};

const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const parseSections = (value) => parseJsonArray(value).filter((entry) => entry && typeof entry === "object");

const toIsoOrNull = (value) => {
  if (!value) return null;
  const parsed = new Date(`${String(value).replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/* Shape of a note as the API returns it. Kept in one place so the client and the
   tests cannot drift apart. */
const toNoteDto = (row) => ({
  slug: row.slug,
  title: row.title || "",
  approach: row.approach || "",
  observations: row.observations || "",
  edgeCases: row.edge_cases || "",
  timeComplexity: row.time_complexity || "",
  spaceComplexity: row.space_complexity || "",
  tags: parseJsonArray(row.tags),
  sections: parseSections(row.sections_json),
  revision: Number(row.revision) || 1,
  createdAt: toIsoOrNull(row.created_at),
  updatedAt: toIsoOrNull(row.updated_at)
});

const toSolutionDto = (row) => ({
  id: Number(row.id),
  clientId: row.client_id || null,
  slug: row.slug,
  title: row.title || "",
  language: row.language || "java",
  code: row.code || "",
  explanation: row.explanation || "",
  timeComplexity: row.time_complexity || "",
  spaceComplexity: row.space_complexity || "",
  revision: Number(row.revision) || 1,
  createdAt: toIsoOrNull(row.created_at),
  updatedAt: toIsoOrNull(row.updated_at),
  /* Only present on search results, where the catalog supplies the context. */
  problemTitle: row.problem_title ?? null,
  problemNum: row.lc_num ?? null
});

const noteSelect = `SELECT slug, title, approach, observations, edge_cases, time_complexity,
                           space_complexity, tags, sections_json, revision,
                           DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
                           DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
                      FROM problem_notes
                     WHERE owner_key = ? AND slug = ?`;

const solutionSelect = `SELECT id, client_id, slug, title, language, code, explanation,
                               time_complexity, space_complexity, revision,
                               DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
                               DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
                          FROM problem_solutions
                         WHERE owner_key = ?`;

/* ------------------------------- notes ---------------------------------- */

const getNote = async (slug) => {
  const cleanSlug = normalizeSlug(slug);
  if (!cleanSlug) return null;
  const rows = await query(noteSelect, [STUDY_OWNER, cleanSlug]);
  return rows[0] ? toNoteDto(rows[0]) : null;
};

/* Creates or replaces a note.
   `baseRevision` is the revision the client last saw:
     - 0 / undefined  -> create only; fails when a note already exists
     - n              -> update only when the stored revision is still n
   A mismatch resolves with { conflict: true, server } instead of writing. */
const saveNote = async (input = {}) => {
  const slug = normalizeSlug(input.slug);
  if (!slug) throw new Error("A valid problem slug is required.");

  /* A field that is not part of the request keeps its stored value: a client
     that only sends a new title must never wipe the approach or the tags. */
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  const title = has("title") ? cleanText(input.title, TITLE_MAX).trim() : undefined;
  const approach = has("approach") ? cleanText(input.approach) : undefined;
  const observations = has("observations") ? cleanText(input.observations) : undefined;
  const edgeCases = has("edgeCases") ? cleanText(input.edgeCases) : undefined;
  const timeComplexity = has("timeComplexity") ? cleanText(input.timeComplexity, COMPLEXITY_MAX).trim() : undefined;
  const spaceComplexity = has("spaceComplexity") ? cleanText(input.spaceComplexity, COMPLEXITY_MAX).trim() : undefined;
  const tags = has("tags") ? normalizeTags(input.tags) : undefined;
  const sections = has("sections") ? parseSections(input.sections) : undefined;
  const baseRevision = Number.isInteger(input.baseRevision) && input.baseRevision >= 0 ? input.baseRevision : 0;

  const existingRows = await query(
    "SELECT revision FROM problem_notes WHERE owner_key = ? AND slug = ?",
    [STUDY_OWNER, slug]
  );
  const existing = existingRows[0] || null;

  if (!existing) {
    if (baseRevision > 0) {
      /* The client believed a note existed, but the server has none. Hand back
         the empty state so the client can decide instead of silently creating. */
      return { conflict: true, server: null, reason: "missing" };
    }
    await query(
      `INSERT INTO problem_notes
         (owner_key, slug, title, approach, observations, edge_cases,
          time_complexity, space_complexity, tags, sections_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        STUDY_OWNER,
        slug,
        title ?? "",
        approach ?? "",
        observations ?? "",
        edgeCases ?? "",
        timeComplexity ?? "",
        spaceComplexity ?? "",
        tags && tags.length ? JSON.stringify(tags) : null,
        sections && sections.length ? JSON.stringify(sections) : null
      ]
    );
    return { conflict: false, note: await getNote(slug) };
  }

  if (baseRevision !== Number(existing.revision)) {
    return { conflict: true, server: await getNote(slug), reason: "stale" };
  }

  /* COALESCE keeps the stored value for every field this request left out. */
  await query(
    `UPDATE problem_notes
        SET title = COALESCE(?, title),
            approach = COALESCE(?, approach),
            observations = COALESCE(?, observations),
            edge_cases = COALESCE(?, edge_cases),
            time_complexity = COALESCE(?, time_complexity),
            space_complexity = COALESCE(?, space_complexity),
            tags = COALESCE(?, tags),
            sections_json = COALESCE(?, sections_json),
            revision = revision + 1
      WHERE owner_key = ? AND slug = ?`,
    [
      title,
      approach,
      observations,
      edgeCases,
      timeComplexity,
      spaceComplexity,
      tags && tags.length ? JSON.stringify(tags) : null,
      sections && sections.length ? JSON.stringify(sections) : null,
      STUDY_OWNER,
      slug
    ]
  );
  return { conflict: false, note: await getNote(slug) };
};

const deleteNote = async (slug) => {
  const cleanSlug = normalizeSlug(slug);
  if (!cleanSlug) return false;
  const result = await query("DELETE FROM problem_notes WHERE owner_key = ? AND slug = ?", [STUDY_OWNER, cleanSlug]);
  return (result?.affectedRows || 0) > 0;
};

/* ----------------------------- solutions -------------------------------- */

const getSolution = async (id) => {
  const numericId = Number.parseInt(id, 10);
  if (!Number.isFinite(numericId) || numericId < 1) return null;
  const rows = await query(`${solutionSelect} AND id = ?`, [STUDY_OWNER, numericId]);
  return rows[0] ? toSolutionDto(rows[0]) : null;
};

const listSolutions = async ({ slug, limit, offset } = {}) => {
  const cleanSlug = normalizeSlug(slug);
  const safeLimit = clampLimit(limit);
  const safeOffset = clampOffset(offset);

  let where = "";
  const params = [STUDY_OWNER];
  if (cleanSlug) {
    where = " AND slug = ?";
    params.push(cleanSlug);
  }

  const totals = await query(
    `SELECT COUNT(*) AS total FROM problem_solutions WHERE owner_key = ?${where}`,
    params
  );

  const rows = await query(
    `${solutionSelect}${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset]
  );

  return {
    items: rows.map(toSolutionDto),
    total: Number(totals[0]?.total || 0),
    limit: safeLimit,
    offset: safeOffset
  };
};

/* Creates a saved solution. `clientId` makes the call idempotent: retrying the
   same offline creation returns the solution that already exists instead of
   storing a second copy of the same code. */
const createSolution = async (input = {}) => {
  const slug = normalizeSlug(input.slug);
  if (!slug) throw new Error("A valid problem slug is required.");
  const code = cleanText(input.code, CODE_MAX);
  if (!code.trim()) throw new Error("Code is required.");

  const clientId = String(input.clientId ?? "").trim().slice(0, 64) || null;

  if (clientId) {
    const existing = await query(
      `${solutionSelect} AND client_id = ?`,
      [STUDY_OWNER, clientId]
    );
    if (existing[0]) return { created: false, solution: toSolutionDto(existing[0]) };
  }

  const result = await query(
    `INSERT INTO problem_solutions
       (owner_key, slug, client_id, title, language, code, explanation,
        time_complexity, space_complexity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      STUDY_OWNER,
      slug,
      clientId,
      cleanText(input.title, TITLE_MAX).trim() || "Solution",
      normalizeLanguage(input.language),
      code,
      cleanText(input.explanation),
      cleanText(input.timeComplexity, COMPLEXITY_MAX).trim(),
      cleanText(input.spaceComplexity, COMPLEXITY_MAX).trim()
    ]
  );

  return { created: true, solution: await getSolution(result.insertId) };
};

/* Updates one saved solution, refusing when `baseRevision` is stale. */
const updateSolution = async (id, input = {}) => {
  const numericId = Number.parseInt(id, 10);
  if (!Number.isFinite(numericId) || numericId < 1) return { notFound: true };
  const baseRevision = Number.isInteger(input.baseRevision) && input.baseRevision >= 0 ? input.baseRevision : 0;
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;

  const existing = await getSolution(numericId);
  if (!existing) return { notFound: true };
  if (existing.revision !== baseRevision) {
    return { conflict: true, server: existing };
  }

  const code = cleanText(input.code, CODE_MAX);
  if (!code.trim()) throw new Error("Code is required.");

  /* As with notes, an omitted field keeps what is already stored. */
  const title = has("title") && cleanText(input.title, TITLE_MAX).trim() ? cleanText(input.title, TITLE_MAX).trim() : undefined;
  const language = has("language") && input.language ? normalizeLanguage(input.language) : undefined;
  const explanation = has("explanation") ? cleanText(input.explanation) : undefined;
  const timeComplexity = has("timeComplexity") ? cleanText(input.timeComplexity, COMPLEXITY_MAX).trim() : undefined;
  const spaceComplexity = has("spaceComplexity") ? cleanText(input.spaceComplexity, COMPLEXITY_MAX).trim() : undefined;

  await query(
    `UPDATE problem_solutions
        SET title = COALESCE(?, title),
            language = COALESCE(?, language),
            code = ?,
            explanation = COALESCE(?, explanation),
            time_complexity = COALESCE(?, time_complexity),
            space_complexity = COALESCE(?, space_complexity),
            revision = revision + 1
      WHERE id = ? AND owner_key = ?`,
    [
      title,
      language,
      code,
      explanation,
      timeComplexity,
      spaceComplexity,
      numericId,
      STUDY_OWNER
    ]
  );

  return { conflict: false, solution: await getSolution(numericId) };
};

const deleteSolution = async (id) => {
  const numericId = Number.parseInt(id, 10);
  if (!Number.isFinite(numericId) || numericId < 1) return false;
  const result = await query("DELETE FROM problem_solutions WHERE id = ? AND owner_key = ?", [numericId, STUDY_OWNER]);
  return (result?.affectedRows || 0) > 0;
};

/* ------------------------------- search --------------------------------- */
/* One search over the user's own notes and saved solutions. Problem title and
   number come from the catalog when the problem exists there. */
const searchStudy = async (options = {}) => {
  const raw = String(options.q || "").trim().slice(0, SEARCH_MAX);
  /* An empty language means "any language" here - it must not fall back to the
     default language the way a create request does. */
  const language = String(options.language || "").trim().toLowerCase().slice(0, LANGUAGE_MAX);
  const tag = String(options.tag || "").trim().toLowerCase().slice(0, TAG_LENGTH_MAX);
  const safeLimit = clampLimit(options.limit, 30, SOLUTION_PAGE_MAX);

  const terms = [];
  if (raw) terms.push(`%${raw}%`);

  const results = [];
  if (!language && !terms.length && !tag) return results;

  /* Notes carry no language, so a language-only search skips them. */
  if (!language) {
    const noteWhere = ["owner_key = ?"];
    const noteParams = [STUDY_OWNER];
    if (terms.length) {
      noteWhere.push("(n.title LIKE ? OR n.approach LIKE ? OR n.observations LIKE ? OR n.edge_cases LIKE ? OR n.time_complexity LIKE ? OR n.space_complexity LIKE ?)");
      noteParams.push(...terms, ...terms, ...terms, ...terms, ...terms, ...terms);
    }
    if (tag) {
      /* Tags live in a JSON array; matching the quoted value is enough here
         because tag values are normalised to short lowercase words. */
      noteWhere.push("tags IS NOT NULL AND tags LIKE ?");
      noteParams.push(`%"${tag}"%`);
    }
    const noteRows = await query(
      `SELECT n.slug, n.title, n.approach, n.observations, n.edge_cases,
              n.time_complexity, n.space_complexity, n.tags, n.sections_json, n.revision,
              DATE_FORMAT(n.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
              DATE_FORMAT(n.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
              p.title AS problem_title, p.lc_num
         FROM problem_notes n
         LEFT JOIN problems p ON p.slug = n.slug
        WHERE ${noteWhere.join(" AND ")}
        ORDER BY n.updated_at DESC
        LIMIT ?`,
      [...noteParams, safeLimit]
    );
    noteRows.forEach((row) => {
      const note = toNoteDto(row);
      results.push({
        kind: "note",
        slug: note.slug,
        title: note.title || "Untitled note",
        snippet: (note.approach || note.observations || note.edgeCases || "").slice(0, 180),
        language: null,
        tags: note.tags,
        revision: note.revision,
        updatedAt: note.updatedAt,
        problemTitle: row.problem_title ?? null,
        problemNum: row.lc_num ?? null
      });
    });
  }

  /* Saved solutions. Solutions carry no tags, so a tag-only search must not
     fall through and return the whole list. */
  if (terms.length || language) {
  const solWhere = ["owner_key = ?"];
  const solParams = [STUDY_OWNER];
  if (terms.length) {
    solWhere.push("(s.title LIKE ? OR s.code LIKE ? OR s.explanation LIKE ? OR s.time_complexity LIKE ? OR s.space_complexity LIKE ?)");
    solParams.push(...terms, ...terms, ...terms, ...terms, ...terms);
  }
  if (language) {
    solWhere.push("language = ?");
    solParams.push(language);
  }
  const solRows = await query(
    `SELECT s.id, s.client_id, s.slug, s.title, s.language, s.code, s.explanation,
            s.time_complexity, s.space_complexity, s.revision,
            DATE_FORMAT(s.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
            DATE_FORMAT(s.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
            p.title AS problem_title, p.lc_num
       FROM problem_solutions s
       LEFT JOIN problems p ON p.slug = s.slug
      WHERE ${solWhere.join(" AND ")}
      ORDER BY s.updated_at DESC
      LIMIT ?`,
    [...solParams, safeLimit]
  );
  solRows.forEach((row) => {
    const solution = toSolutionDto(row);
    results.push({
      kind: "solution",
      id: solution.id,
      slug: solution.slug,
      title: solution.title,
      snippet: (solution.explanation || solution.code || "").slice(0, 180),
      language: solution.language,
      timeComplexity: solution.timeComplexity,
      spaceComplexity: solution.spaceComplexity,
      revision: solution.revision,
      updatedAt: solution.updatedAt,
      problemTitle: row.problem_title ?? null,
      problemNum: row.lc_num ?? null
    });
  });
  }

  return results.slice(0, safeLimit);
};

module.exports = {
  STUDY_OWNER,
  getNote,
  saveNote,
  deleteNote,
  getSolution,
  listSolutions,
  createSolution,
  updateSolution,
  deleteSolution,
  searchStudy,
  normalizeTags,
  normalizeLanguage,
  normalizeSlug,
  cleanText,
  clampLimit,
  toNoteDto,
  toSolutionDto,
  DIFFICULTIES
};