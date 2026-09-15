-- 2026-09-12: per-entry voter keys. `voter` becomes the install key and
-- `ipkey` the network key; before this, `voter` was sha256(ip + day + salt),
-- which rotated daily and let one person re-vote on the same entry every day.
--
--   npx wrangler d1 execute killslop --remote --file=migrations/0001_voter_keys.sql
--
-- Fresh databases get this from schema.sql and must not run it.
ALTER TABLE votes ADD COLUMN ipkey TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_ipkey ON votes (hash, source, ipkey);
