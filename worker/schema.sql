-- KillSlop community list. For a fresh database; an existing one is brought up
-- to date by the files in migrations/, in order.
--
-- We store the sha256 of the id as the primary key and index on its 4-char
-- prefix, because the read path never receives a full id: clients ask for a
-- bucket and filter locally. The plaintext id is kept alongside for review,
-- for rebuilding buckets and for the channel export; it is never returned by
-- the bucket endpoint.
--
-- Two kinds of evidence live on one row and are never mixed:
--
--   up / down   human opinion: "this is slop" / "this is not slop" clicks.
--   tallies     objective measurement: how many distinct reporters saw this
--               channel cross its platform's disclosure-sampling threshold
--               (YouTube: >=60% of >=5 uploads carry YouTube's own AI label;
--               X: >=25% of >=8 media posts carry X's AI disclosure; see
--               TALLY_RULES in src/policy.js). tally_ai and tally_total are
--               the summed samples behind them, for the record.
--
-- A third column, review, is the maintainer's call from the console at /admin.
-- It outranks both (see decide() in src/policy.js).
--
-- Ids never share a spelling across platforms, because the hash is of the id
-- alone: YouTube's are bare (the list began with them), X's start 'x:' and
-- LinkedIn's 'li:'. The kinds stay 'video' and 'channel'; on X and LinkedIn
-- they mean a post and its author.

CREATE TABLE IF NOT EXISTS entries (
  hash        TEXT PRIMARY KEY,     -- sha256(id), lowercase hex
  prefix      TEXT NOT NULL,        -- first 4 chars of hash
  id          TEXT NOT NULL,        -- 'dQw4w9WgXcQ', '@handle', 'UC...', 'x:<post>', 'x:u:<user>', 'x:@handle', 'li:<hash>', 'li:in:<slug>'
  kind        TEXT NOT NULL,        -- 'video' | 'channel' (post | author on X and LinkedIn)
  platform    TEXT NOT NULL DEFAULT 'youtube', -- 'youtube' | 'x' | 'linkedin'
  up          INTEGER NOT NULL DEFAULT 0,
  down        INTEGER NOT NULL DEFAULT 0,
  tallies     INTEGER NOT NULL DEFAULT 0,
  tally_ai    INTEGER NOT NULL DEFAULT 0,
  tally_total INTEGER NOT NULL DEFAULT 0,
  created     INTEGER NOT NULL,
  updated     INTEGER NOT NULL,
  review      TEXT,                 -- NULL waiting | 'slop' approved | 'clean' rejected
  reviewed_at INTEGER,
  title       TEXT,                 -- display name the console resolved; never served
  meta        TEXT,                 -- JSON the console resolved (owner, recent uploads)
  meta_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_entries_prefix ON entries (prefix);
CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries (kind, platform);
CREATE INDEX IF NOT EXISTS idx_entries_review ON entries (review, kind);

-- One row per person per entry per source. A person is two keys, each
-- sha256(... + entry hash + secret salt), so one person's rows on different
-- entries cannot be linked: `voter` is the install (a random id the extension
-- generates) and `ipkey` the network (IPv4 address, or IPv6 /64). Either key
-- matching counts as the same person, so voting twice on one entry needs a new
-- install AND a new network. `source` is 'vote' (a click) or 'tally' (a
-- measurement).
CREATE TABLE IF NOT EXISTS votes (
  voter   TEXT NOT NULL,
  hash    TEXT NOT NULL,
  source  TEXT NOT NULL DEFAULT 'vote',
  slop    INTEGER NOT NULL,
  created INTEGER NOT NULL,
  ipkey   TEXT,
  PRIMARY KEY (voter, hash, source)
);

CREATE INDEX IF NOT EXISTS idx_votes_hash ON votes (hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_ipkey ON votes (hash, source, ipkey);

-- Messages sent from the extension's feedback page, read in the console.
-- `netkey` is sha256('feedback:' + network + salt): enough to cap one
-- network's volume per day, not enough to say who sent what.
CREATE TABLE IF NOT EXISTS feedback (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  created  INTEGER NOT NULL,
  category TEXT NOT NULL,           -- 'bug' | 'wrong' | 'idea' | 'other'
  message  TEXT NOT NULL,
  email    TEXT,                    -- optional, for a reply; never published
  version  TEXT,                    -- extension version
  netkey   TEXT NOT NULL,
  status   TEXT NOT NULL DEFAULT 'new'  -- 'new' | 'done'
);

CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status, created);
CREATE INDEX IF NOT EXISTS idx_feedback_netkey ON feedback (netkey, created);
