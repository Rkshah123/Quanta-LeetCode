/* =============================================================================
   Quanta — migration 002: coding progress and run history
   -----------------------------------------------------------------------------
   Safety rules for this project:
   - Only CREATE TABLE IF NOT EXISTS / ADD style statements.
   - Never DROP, TRUNCATE or DELETE. Re-running this file is harmless.
   - Existing catalog rows are never modified by this migration.

   Why these tables exist
   ----------------------
   Until now a "solved" flag only lived in the browser (localStorage), so the
   catalog had no idea what the user had worked on and no other device could see
   it. These two tables make progress a real, database-backed fact that the
   website and the Android app can both read.

   Identity
   --------
   This app has no login system, so it follows the existing single-user model
   instead of inventing one: every row carries `owner_key`, which is always the
   single value 'default' (see PROGRESS_OWNER in db/progress.js). The column
   exists so that user data can never be silently merged if an identity system
   is added later: every read and write is filtered by owner_key, and the
   primary keys include it.

   Solved semantics
   ----------------
   This application cannot verify algorithmic correctness - code runs either in
   the browser (JavaScript) or on Judge0 with free-form stdin, never against the
   problem's hidden test cases. So `solved` here means exactly what the user
   asserted by pressing "Mark solved", and `problem_runs` records what the server
   actually executed. The UI must keep these two ideas separate and never call a
   user-marked problem "verified accepted".

   Slug as the key
   ---------------
   `slug` (the LeetCode problem slug) is the identifier the frontend already
   uses in URLs, it is UNIQUE in the problems table, and it keeps working for
   problems the user added locally that are not in the catalog yet - a foreign
   key would silently drop those.
   ========================================================================== */

/* One row per problem the user has interacted with (solved or cleared again). */
CREATE TABLE IF NOT EXISTS problem_progress (
  owner_key VARCHAR(64) NOT NULL DEFAULT 'default',
  slug VARCHAR(191) NOT NULL,
  lc_num INT UNSIGNED NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  difficulty ENUM('Easy', 'Medium', 'Hard') NOT NULL DEFAULT 'Medium',
  solved TINYINT(1) NOT NULL DEFAULT 0,
  /* UTC timestamp of the moment the problem was marked solved, NULL while it is
     marked unsolved. Streaks and the activity calendar are computed from this
     column in the caller's timezone. */
  solved_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_key, slug),
  KEY idx_progress_owner_solved (owner_key, solved),
  KEY idx_progress_owner_solved_at (owner_key, solved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Real executions observed by the server (POST /api/run). Browser-only
   JavaScript runs are not recorded here because the server cannot see them.
   Code is never stored - only the outcome. */
CREATE TABLE IF NOT EXISTS problem_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_key VARCHAR(64) NOT NULL DEFAULT 'default',
  /* NULL when the run happened outside a problem (plain Lab session). */
  slug VARCHAR(191) NULL,
  lc_num INT UNSIGNED NULL,
  language VARCHAR(32) NOT NULL DEFAULT 'unknown',
  /* Runner status verbatim, e.g. Accepted, Wrong Answer, Time Limit Exceeded. */
  status VARCHAR(48) NOT NULL DEFAULT 'Unknown',
  /* 1 only when the execution itself succeeded. This is "the code ran", never
     "the solution is accepted". */
  ok TINYINT(1) NOT NULL DEFAULT 0,
  duration_ms INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_runs_owner_created (owner_key, created_at),
  KEY idx_runs_owner_slug (owner_key, slug),
  KEY idx_runs_owner_ok (owner_key, ok)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;