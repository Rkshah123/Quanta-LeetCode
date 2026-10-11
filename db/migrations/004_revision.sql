/* =============================================================================
   Quanta — migration 004: smart DSA revision schedule
   -----------------------------------------------------------------------------
   Safety rules for this project:
   - Only CREATE TABLE IF NOT EXISTS / ADD style statements.
   - Never DROP, TRUNCATE or DELETE. Re-running this file is harmless.

   What this stores
   ----------------
   One row per problem the user put in the revision list: how far it has got in
   the ladder, when it is next due, and the last confidence the user reported.
   `revision_reviews` is the append-only history - rescheduling or removing a
   problem never erases what was actually reviewed, and completing one keeps its
   whole ladder.

   Dates are plain calendar days (DATE), not timestamps, so no timezone or
   daylight-saving rule can move a review by a day. The day itself is chosen in
   the caller's timezone before it is stored - see db/revision.js.

   Truthfulness
   ------------
   Nothing here claims a solution was accepted. This application cannot judge
   algorithmic correctness, so a revision simply means "come back to this
   problem and try it again".
   ========================================================================== */

/* The schedule itself. `status` leaves the active list when a problem is
   finished; the row is kept so the history stays meaningful. */
CREATE TABLE IF NOT EXISTS revision_items (
  owner_key VARCHAR(64) NOT NULL DEFAULT 'default',
  slug VARCHAR(191) NOT NULL,
  lc_num INT UNSIGNED NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  difficulty ENUM('Easy', 'Medium', 'Hard') NOT NULL DEFAULT 'Medium',
  /* Which rung of the ladder this problem has reached (0 = never reviewed). */
  stage TINYINT UNSIGNED NOT NULL DEFAULT 0,
  /* The interval the current due date came from, so the next step can build
     on it without recomputing the whole ladder. */
  interval_days INT UNSIGNED NOT NULL DEFAULT 1,
  due_date DATE NOT NULL,
  confidence ENUM('again', 'difficult', 'good', 'easy') NULL,
  status ENUM('active', 'completed') NOT NULL DEFAULT 'active',
  review_count INT UNSIGNED NOT NULL DEFAULT 0,
  completed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_key, slug),
  KEY idx_revision_owner_status_due (owner_key, status, due_date),
  KEY idx_revision_owner_updated (owner_key, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Append-only history: one row per completed review. Never rewritten, so a
   reschedule, a removal or a restart cannot lose what really happened. */
CREATE TABLE IF NOT EXISTS revision_reviews (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_key VARCHAR(64) NOT NULL DEFAULT 'default',
  slug VARCHAR(191) NOT NULL,
  confidence ENUM('again', 'difficult', 'good', 'easy') NOT NULL,
  stage_before TINYINT UNSIGNED NOT NULL DEFAULT 0,
  stage_after TINYINT UNSIGNED NOT NULL DEFAULT 0,
  interval_days INT UNSIGNED NOT NULL DEFAULT 1,
  /* The day the user actually answered, in their timezone. */
  review_date DATE NOT NULL,
  next_due_date DATE NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reviews_owner_created (owner_key, created_at),
  KEY idx_reviews_owner_slug (owner_key, slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;