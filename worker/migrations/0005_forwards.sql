-- 2026-11-21: X posts passed on to levelsio's report queue (src/forward.js).
--
--   npx wrangler d1 execute killslop --remote --file=migrations/0005_forwards.sql
--
-- Additive only: nothing existing is touched. Fresh databases get this from
-- schema.sql and must not run it.
--
-- One row per post we dealt with, so nothing is sent twice. Only the public
-- post, never who marked it.

CREATE TABLE IF NOT EXISTS forwards (
  hash    TEXT PRIMARY KEY,     -- entries.hash of the post
  id      TEXT NOT NULL,        -- 'x:<post id>'
  url     TEXT,                 -- the link sent, or NULL when the post was gone
  -- 'sent' | 'listed' (author already on his list) | 'account-sent' (another
  -- of its replies went already) | 'not-reply' | 'gone'
  -- | 'bad-id' | 'refused:<his error>'
  status  TEXT NOT NULL,
  at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_forwards_at ON forwards (at);
