-- 2026-11-24: optional credit on levelsio's Top reporters board.
--
--   npx wrangler d1 execute killslop --remote --file=migrations/0006_vote_reporter.sql
--
-- Additive only. Fresh databases get this from schema.sql and must not run it.
--
-- The X username a person chose to be credited under, kept on their own vote
-- row and only for an X "slop" mark. Unset unless they typed one in the
-- dashboard. An Undo deletes the row, so the name goes with it. forward.js
-- passes the earliest one on as `reporter` when it reports the reply.

ALTER TABLE votes ADD COLUMN reporter TEXT;
