-- 2026-09-18: the writing check, a third kind of evidence.
--
--   npx wrangler d1 execute killslop --remote --file=migrations/0003_writing_check.sql
--
-- Additive only: existing entries, votes and feedback are untouched, and every
-- existing entry starts with no writing evidence at all. Fresh databases get
-- all of this from schema.sql and must not run it.

-- The check's cache. The post's text is never stored, only the hash of it and
-- what the model said, so nothing here can be read back into anyone's feed.
-- Two people who saw the same post share one answer, which is what lets a
-- client ask by hash and spend nothing.
CREATE TABLE IF NOT EXISTS texts (
  hash    TEXT PRIMARY KEY,     -- sha256(normalized text), lowercase hex
  prefix  TEXT NOT NULL,        -- first 4 chars, as for entries
  score   REAL NOT NULL,        -- 0 to 4, the model's slop_level
  signal  TEXT,                 -- strongest matching sign, so the card can say why
  conf    REAL,
  model   TEXT NOT NULL,        -- a model change can invalidate cleanly
  created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_texts_prefix ON texts (prefix);
-- The daily spend is counted as rows created in the last day, on every cache
-- miss, so that count must not walk the whole table.
CREATE INDEX IF NOT EXISTS idx_texts_created ON texts (created);

-- Author-level writing evidence, kept in its own columns rather than folded
-- into tallies: a tally is the platform's own label counted, this is a model's
-- opinion of the writing, and the two must not be added together.
ALTER TABLE entries ADD COLUMN writings INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN writing_ai INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN writing_total INTEGER NOT NULL DEFAULT 0;
