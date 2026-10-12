/* ---------------------- 005 / multi-platform catalog --------------------- */
/* Purpose
   -------
   The catalog was built for a single platform: 782 LeetCode rows, no topics,
   no rating, and problems that could not be compared against anything from
   another source. This migration adds what is needed to hold a curated
   multi-platform collection of about 2,100 problems without disturbing a
   single existing row.

   Rules this migration obeys
   --------------------------
   - Additive only. No column is dropped, renamed or retyped, so the 782
     existing LeetCode rows keep working untouched and no user data moves.
   - Idempotent in practice: every statement is written so that re-running it
     after a partial failure is safe. Note that DDL implicitly commits on MySQL,
     so a mid-file failure cannot be rolled back as a unit - each statement is
     therefore independent and guarded on its own.
   - One column per ALTER TABLE. This database (TiDB) refuses an AFTER clause
     that refers to a column added by the very same statement, so `AFTER` is
     only ever used against a column that already exists in 001_init.sql.
   - Nullable everywhere new, so existing rows need no backfill to stay valid.
   - `source` already exists (varchar 32) and is NOT changed: the app already
     uses it to mean "where this statement text came from" (database,
     leetcode, offline-pack). Overloading it with platform would have
     corrupted the statement-source diagnostics, so `platform` is separate.

   Columns added to `problems`
   ----------------------------
   platform      Which judge/site the problem originates from ('leetcode',
                 'codeforces', ...).
   external_id   The site's own stable identifier, e.g. '1A'. Unique per
                 platform, NOT globally: Codeforces '1A' and LeetCode '1' are
                 different problems.
   rating        Numeric difficulty rating on the source's own scale (Codeforces
                 uses roughly 800-3500). NULL where a source has no numeric
                 rating. Never invented from a difficulty label.
   content_hash  SHA-1 of the normalized statement text, used to detect the same
                 problem arriving twice from different sources.
   statement_len Length of the normalized statement, so a truncated or empty
                 import is detectable instead of looking valid.
   interview_relevance
                 1 = core interview pattern, 2 = common, 3 = situational.
                 Assigned by the curator's topic rules, never by scraped
                 "frequency" claims.

   Tables added
   ------------
   problem_equivalents  Links two catalog entries that solve the same idea on
                        different platforms, so duplicates stay reachable
                        without deleting either row.
   companies            Company names. Created empty on purpose: a row here
                        asserts a company asks this question, and that must be
                        verifiable. Populated only by a source that states it.
   problem_companies    Many-to-many link, tagged with `confidence` ('reported'
                        by a source, or 'curated' by an explicit editorial
                        judgement) so the UI can always say which it is.
   problem_sources      Where each row's metadata came from, with the fetch
                        time, so an import can be re-verified later. */

/* -------------------------- problems: new columns ---------------------- */
/* No AFTER clause here: column order does not matter to any query, and
   omitting it avoids depending on a previous statement having committed.

   MySQL has no `ADD COLUMN IF NOT EXISTS`, and because DDL implicitly commits,
   a file that fails half way leaves its earlier statements applied. So these
   are added through the runner's `addColumnIfMissing` helper (see
   db/migrate.js), which checks information_schema before issuing the ALTER.
   The plain SQL below is what actually runs; it is generated from the
   statements in MIGRATION_ADD_COLUMNS and executed one at a time. */

/* The 782 existing rows are all LeetCode. Stating that explicitly is better
   than relying on a NULL default, because every query and filter can then
   treat platform as always present. */
UPDATE problems SET platform = 'leetcode' WHERE platform IS NULL OR platform = '';

/* --------------------------- indexes for scale -------------------------- */
/* With thousands of rows instead of hundreds, the catalog is only usable if
   the filters the UI actually offers are indexed. These match the sort and
   filter modes in db/problems.js exactly - no speculative indexes.

   001_init.sql already created idx_problems_difficulty, idx_problems_title,
   idx_problems_updated, uq_problems_lc_num and uq_problems_slug, so only the
   genuinely new access paths are needed.

   These are declared in MIGRATION_ADD_INDEXES in db/migrate.js rather than
   written here, because MySQL has no `CREATE INDEX IF NOT EXISTS` and DDL
   implicitly commits - a bare CREATE INDEX in this file would abort on any
   index a previous partial run had already created, leaving the migration
   permanently stuck. The runner checks information_schema first. */

/* ---------------------- equivalents (cross-platform) --------------------- */

CREATE TABLE IF NOT EXISTS problem_equivalents (
  id int unsigned NOT NULL AUTO_INCREMENT,
  /* The canonical entry the app opens by default. Slug, because that is the
     key the whole client uses to address a problem. */
  canonical_slug varchar(191) NOT NULL,
  /* A different entry that solves the same idea. */
  equivalent_slug varchar(191) NOT NULL,
  platform varchar(32) NOT NULL,
  reason varchar(255) NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_equivalent (canonical_slug, equivalent_slug),
  KEY idx_equiv_canonical (canonical_slug),
  KEY idx_equiv_equivalent (equivalent_slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ------------------------------- companies ------------------------------ */
/* Empty by design. A company row asserts that the company asks this question;
   it is inserted only when a source states it. */

CREATE TABLE IF NOT EXISTS companies (
  id int unsigned NOT NULL AUTO_INCREMENT,
  slug varchar(64) NOT NULL,
  name varchar(128) NOT NULL,
  category varchar(64) NULL,
  website varchar(255) NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_company_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS problem_companies (
  problem_slug varchar(191) NOT NULL,
  company_id int unsigned NOT NULL,
  /* 'reported' - a source states this company asks this problem
     'curated'  - an explicit editorial judgement, labelled as such in the UI
     Never inferred from popularity. */
  confidence varchar(16) NOT NULL DEFAULT 'reported',
  note varchar(255) NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (problem_slug, company_id),
  KEY idx_pc_company (company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* --------------------------- import provenance -------------------------- */
/* Records where each row's metadata came from so an import can be audited or
   re-run without guessing what was fetched when. */

CREATE TABLE IF NOT EXISTS problem_sources (
  problem_slug varchar(191) NOT NULL,
  source_name varchar(64) NOT NULL,
  source_url varchar(512) NULL,
  fetched_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes varchar(255) NULL,
  PRIMARY KEY (problem_slug, source_name),
  KEY idx_psource_source (source_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
