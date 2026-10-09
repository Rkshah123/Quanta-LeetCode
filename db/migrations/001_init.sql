/* =============================================================================
   Quanta — migration 001: initial catalog schema
   -----------------------------------------------------------------------------
   Safety rules for this project:
   - Only CREATE TABLE IF NOT EXISTS / ALTER ... IF NOT EXISTS style statements.
   - Never DROP, TRUNCATE or DELETE. Re-running this file is harmless.
   - Existing rows are preserved; later migrations may only add columns/tables.

   Database (created manually, must already exist):
     CREATE DATABASE IF NOT EXISTS `Quanta-Leetcode`
       DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci;
   ========================================================================== */

/* Problem catalog: stable numeric IDs shared by desktop and mobile, because
   every client reads them from this database instead of inventing its own.
   lc_num is NULL for problems that do not exist on LeetCode (custom entries). */
CREATE TABLE IF NOT EXISTS problems (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  lc_num INT UNSIGNED NULL,
  slug VARCHAR(191) NOT NULL,
  title VARCHAR(255) NOT NULL,
  difficulty ENUM('Easy', 'Medium', 'Hard') NOT NULL DEFAULT 'Medium',
  url VARCHAR(512) NOT NULL,
  description_html MEDIUMTEXT NULL,
  topics JSON NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'leetcode',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_problems_slug (slug),
  UNIQUE KEY uq_problems_lc_num (lc_num),
  KEY idx_problems_title (title),
  KEY idx_problems_difficulty (difficulty),
  KEY idx_problems_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Worked examples belonging to a problem (input / output / explanation). */
CREATE TABLE IF NOT EXISTS problem_examples (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  problem_id INT UNSIGNED NOT NULL,
  position SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  input_text TEXT NULL,
  output_text TEXT NULL,
  explanation_text TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_example_position (problem_id, position),
  KEY idx_examples_problem (problem_id),
  CONSTRAINT fk_examples_problem
    FOREIGN KEY (problem_id) REFERENCES problems (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Topic / pattern categories (Array, Binary Search, …). */
CREATE TABLE IF NOT EXISTS categories (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug VARCHAR(191) NOT NULL,
  name VARCHAR(120) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_slug (slug),
  KEY idx_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Which problems belong to which category. */
CREATE TABLE IF NOT EXISTS problem_categories (
  problem_id INT UNSIGNED NOT NULL,
  category_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (problem_id, category_id),
  KEY idx_problem_categories_category (category_id),
  CONSTRAINT fk_problem_categories_problem
    FOREIGN KEY (problem_id) REFERENCES problems (id) ON DELETE CASCADE,
  CONSTRAINT fk_problem_categories_category
    FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
