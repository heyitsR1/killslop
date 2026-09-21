-- 2026-09-19: the Chrome Web Store waiting list behind killslop.app/waitlist.
--
--   npx wrangler d1 execute killslop --remote --file=migrations/0004_waitlist.sql
--
-- Additive only: nothing existing is touched. Fresh databases get this from
-- schema.sql and must not run it.
--
-- The address is stored in the clear, because the whole point is to send one
-- email to it. It is the primary key, lowercased, so signing up twice is a
-- no-op rather than a duplicate, and the endpoint can answer the same way
-- either time without telling a stranger whether an address is already here.

CREATE TABLE IF NOT EXISTS waitlist (
  email   TEXT PRIMARY KEY,     -- lowercased, trimmed
  created INTEGER NOT NULL,
  -- Which launch post this came from: the ?from=<slug> on the link, or NULL.
  -- Our own slug, never anything about the person.
  source  TEXT,
  -- sha256('waitlist:' + network + salt): enough to cap one network's
  -- sign-ups per day, not enough to say who signed up.
  netkey  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_waitlist_created ON waitlist (created);
CREATE INDEX IF NOT EXISTS idx_waitlist_netkey ON waitlist (netkey, created);
