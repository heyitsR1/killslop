-- 2026-09-13: maintainer review, console metadata, and user feedback.
--
--   npx wrangler d1 execute killslop --remote --file=migrations/0002_review_feedback.sql
--
-- Additive only: existing entries and votes are untouched, and every existing
-- entry starts in the review queue. Fresh databases get all of this from
-- schema.sql and must not run it.

-- NULL = waiting for review, 'slop' = in the final database, 'clean' = rejected.
ALTER TABLE entries ADD COLUMN review TEXT;
ALTER TABLE entries ADD COLUMN reviewed_at INTEGER;
-- What the console resolved about an entry. Display only, never served.
ALTER TABLE entries ADD COLUMN title TEXT;
ALTER TABLE entries ADD COLUMN meta TEXT;
ALTER TABLE entries ADD COLUMN meta_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_entries_review ON entries (review, kind);

CREATE TABLE IF NOT EXISTS feedback (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  created  INTEGER NOT NULL,
  category TEXT NOT NULL,
  message  TEXT NOT NULL,
  email    TEXT,
  version  TEXT,
  netkey   TEXT NOT NULL,
  status   TEXT NOT NULL DEFAULT 'new'
);

CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status, created);
CREATE INDEX IF NOT EXISTS idx_feedback_netkey ON feedback (netkey, created);
