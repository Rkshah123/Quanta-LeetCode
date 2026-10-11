/* =============================================================================
   Quanta — migration 003: personal study notes and saved solutions
   -----------------------------------------------------------------------------
   Safety rules for this project:
   - Only CREATE TABLE IF NOT EXISTS / ADD style statements.
   - Never DROP, TRUNCATE or DELETE. Re-running this file is harmless.
   - Existing rows are never modified by this migration.

   Why
   ---
   Until now a problem kept exactly one blob of code per language and one set of
   rich-text sections, both living only in the browser. That means: one version
   per language, no way to keep two approaches for the same problem, and nothing
   visible on the other device.

   These tables keep the rich text exactly as the app already stores it
   (`sections_json`) and add the structured study fields around it, plus any
   number of saved solutions per problem.

   Identity and safety
   -------------------
   Same single-owner model as migration 002 (`owner_key`, always 'default' in
   db/study.js). Every read and write is filtered by it, so one owner's private
   notes can never be listed, read, changed or deleted by another.

   Revisions
   ---------
   `revision` starts at 1 and increases on every accepted change. A client sends
   the revision it edited; if the stored revision moved on, the write is refused
   and the caller is handed the current server copy, so a slow device can never
   silently overwrite newer work from another device.

   Truthfulness
   ------------
   No column here claims a solution is accepted or correct. The runner executes
   code with free-form stdin and has no access to a problem's hidden tests, so a
   stored solution is simply what the user wrote and saved.
   ========================================================================== */

/* One study note per problem. `sections_json` holds the app's existing rich
   text sections verbatim, so nothing already written has to be re-entered. */
CREATE TABLE IF NOT EXISTS problem_notes (
  owner_key VARCHAR(64) NOT NULL DEFAULT 'default',
  slug VARCHAR(191) NOT NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  approach MEDIUMTEXT NULL,
  observations MEDIUMTEXT NULL,
  edge_cases MEDIUMTEXT NULL,
  time_complexity VARCHAR(64) NOT NULL DEFAULT '',
  space_complexity VARCHAR(64) NOT NULL DEFAULT '',
  tags JSON NULL,
  sections_json MEDIUMTEXT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_key, slug),
  KEY idx_notes_owner_updated (owner_key, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Any number of saved solutions per problem, in any language. Code is stored
   exactly as typed; nothing is rewritten or reformatted. */
CREATE TABLE IF NOT EXISTS problem_solutions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_key VARCHAR(64) NOT NULL DEFAULT 'default',
  slug VARCHAR(191) NOT NULL,
  /* Set by the client when it creates a solution offline, so the same item can
     be recognised after the server assigns its own id. */
  client_id VARCHAR(64) NULL,
  title VARCHAR(255) NOT NULL DEFAULT 'Solution',
  language VARCHAR(32) NOT NULL DEFAULT 'java',
  code MEDIUMTEXT NOT NULL,
  explanation MEDIUMTEXT NULL,
  time_complexity VARCHAR(64) NOT NULL DEFAULT '',
  space_complexity VARCHAR(64) NOT NULL DEFAULT '',
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_solution_client (owner_key, client_id),
  KEY idx_solution_slug (owner_key, slug),
  KEY idx_solution_language (owner_key, language),
  KEY idx_solution_updated (owner_key, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;