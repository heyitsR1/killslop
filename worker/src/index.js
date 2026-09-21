/**
 * KillSlop community list API.
 *
 * Read path is deliberately blind: clients ask for a hash bucket, never for a
 * specific id, so this service cannot reconstruct anyone's watch history. The
 * write paths necessarily see the id being reported, but a report is one
 * deliberate click, or one channel-level fact, not a browsing trail.
 *
 * Two kinds of evidence, kept apart end to end:
 *
 *   vote   a human said "slop" / "not slop" about a video or channel.
 *   tally  a client's disclosure sampler saw a channel cross its platform's
 *          threshold (TALLY_RULES in policy.js): on YouTube >= 60% of >= 5
 *          uploads carry YouTube's own AI label, on X >= 25% of >= 8 media
 *          posts carry X's. Objective, needs no moderator, and cannot be
 *          gamed without also gaming the platform's own labelling. LinkedIn
 *          shows no label, so it only has votes.
 *
 * The bucket endpoint returns both, and says which is which, so the client
 * can let the user choose how much opinion they want on top of measurement.
 *
 * What gets served at all is gated by review (REVIEW_MODE, see policy.js).
 * While the list is young a maintainer confirms every entry in the console at
 * /admin (admin.js) before any client sees it; votes and tallies order that
 * queue.
 */

import {
  FEEDBACK_PER_DAY,
  MIN_TALLIES,
  MIN_VOTES,
  PLATFORMS,
  PREFIX_LEN,
  WAITLIST_PER_DAY,
  cleanFeedback,
  cleanWaitlist,
  countStats,
  decide,
  isValidId,
  isValidInstallId,
  isValidTally,
  networkOf,
  platformOf,
  reviewMode,
  sha256Hex,
} from './policy.js';
import { MAX_TEXT_CHARS, askJev } from './jev.js';
import { clientNetwork, overLimit, readJson } from './http.js';
import { handleAdmin } from './admin.js';
import { SITE_HOST, handleShared, handleSite, isSiteHost } from './site.js';

const DAY_MS = 24 * 3600 * 1000;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

const tooMany = (seconds = 60) =>
  json({ error: 'rate limited' }, 429, { 'retry-after': String(seconds) });

/**
 * Who is voting, as two keys scoped to one entry: the install (`userkey`,
 * from a random id the extension generates) and the network (`ipkey`). Either
 * one matching an existing row makes it the same person, so a second vote
 * needs a new install AND a new network. Both are hashed with the entry, so
 * one person's votes on different videos cannot be linked to each other.
 */
async function voterKeys(request, env, hash, installId) {
  const salt = env.VOTER_SALT || 'dev-salt';
  const ipkey = await sha256Hex(`net:${clientNetwork(request)}:${hash}:${salt}`);
  const userkey = isValidInstallId(installId)
    ? await sha256Hex(`install:${installId}:${hash}:${salt}`)
    : ipkey;
  return { userkey, ipkey };
}

/** This person's existing row for an entry, matched on either key. */
function findVote(env, hash, source, { userkey, ipkey }) {
  return env.DB.prepare(
    `SELECT voter, slop FROM votes
      WHERE hash = ?1 AND source = ?2 AND (voter = ?3 OR ipkey = ?4) LIMIT 1`
  )
    .bind(hash, source, userkey, ipkey)
    .first();
}

/** A concurrent insert beat ours to the unique index: it's a repeat vote. */
const isDuplicate = (err) => /UNIQUE constraint failed/i.test(String(err?.message || err));

/* ------------------------------------------------------------------- read */

async function getBucket(env, prefix) {
  if (!/^[0-9a-f]{4}$/.test(prefix)) return json({ error: 'bad prefix' }, 400);

  const { results } = await env.DB.prepare(
    `SELECT hash, kind, platform, up, down, tallies,
            writings, writing_ai, writing_total, review
       FROM entries WHERE prefix = ?1`
  )
    .bind(prefix)
    .all();

  const mode = reviewMode(env);
  const entries = [];
  for (const r of results || []) {
    const d = decide(r, mode);
    if (!d) continue;
    entries.push({
      hash: r.hash,
      kind: r.kind,
      slop: d.slop,
      evidence: d.evidence,
      reviewed: r.review === 'slop',
      score: r.up - r.down,
      tallies: r.tallies,
    });
  }

  return json(
    { prefix, entries },
    200,
    // Buckets change slowly; let the edge absorb the traffic.
    { 'cache-control': 'public, max-age=300' }
  );
}

/**
 * The decided account list in the clear, for consumers that cannot do a
 * bucket lookup (uBlock lists, ReVanced-style patches, researchers).
 *
 * Accounts only, on every platform. A channel, an X account and a LinkedIn
 * author are public entities; the videos and posts they made are not exported,
 * and a LinkedIn post's id is a one-way hash that would mean nothing anyway.
 */
const EXPORTS = {
  '/api/v1/export/youtube-channels.json': { platform: 'youtube', key: 'channels' },
  '/api/v1/export/x-accounts.json': { platform: 'x', key: 'accounts' },
  '/api/v1/export/linkedin-authors.json': { platform: 'linkedin', key: 'authors' },
};

async function getExport(env, { platform, key }) {
  const { results } = await env.DB.prepare(
    `SELECT id, platform, up, down, tallies, tally_ai, tally_total,
            writings, writing_ai, writing_total, review, updated
       FROM entries
      WHERE kind = 'channel' AND platform = ?1
      ORDER BY updated DESC LIMIT 50000`
  )
    .bind(platform)
    .all();

  const mode = reviewMode(env);
  const rows = [];
  for (const r of results || []) {
    const d = decide(r, mode);
    if (!d || !d.slop) continue;
    rows.push({
      id: r.id,
      evidence: d.evidence,
      reviewed: r.review === 'slop',
      score: r.up - r.down,
      tallies: r.tallies,
      sampled: r.tally_total ? { ai: r.tally_ai, total: r.tally_total } : null,
      // What the writing check read, when that is what put it here.
      read: r.writing_total ? { ai: r.writing_ai, total: r.writing_total } : null,
      updated: r.updated,
    });
  }
  return json(
    {
      license: 'CC-BY-SA-4.0',
      attribution: 'KillSlop (https://killslop.app)',
      generated: Date.now(),
      [key]: rows,
    },
    200,
    { 'cache-control': 'public, max-age=3600' }
  );
}

/* ------------------------------------------------------------------ write */

async function ensureEntry(env, { hash, prefix, id, kind, platform, now }) {
  return env.DB.prepare(
    `INSERT INTO entries (hash, prefix, id, kind, platform, created, updated)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(hash) DO NOTHING`
  ).bind(hash, prefix, id, kind, platform, now);
}

async function postReport(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'bad json' }, 400);

  const { id, kind, slop, platform = 'youtube', voter } = body;
  if (!isValidId(id, kind)) return json({ error: 'bad id' }, 400);
  if (typeof slop !== 'boolean') return json({ error: 'bad slop' }, 400);
  // The id's spelling names its platform; a body that disagrees is confused.
  if (!PLATFORMS.includes(platform) || platform !== platformOf(id)) {
    return json({ error: 'bad platform' }, 400);
  }

  const hash = await sha256Hex(id);
  const prefix = hash.slice(0, PREFIX_LEN);
  const keys = await voterKeys(request, env, hash, voter);
  const now = Date.now();

  const prior = await findVote(env, hash, 'vote', keys);
  if (prior && Boolean(prior.slop) === slop) return json({ ok: true, unchanged: true });

  const statements = [await ensureEntry(env, { hash, prefix, id, kind, platform, now })];
  if (prior) {
    // Changing your mind moves two counters and keeps you one voter.
    statements.push(
      env.DB.prepare(
        `UPDATE votes SET slop = ?3, created = ?4 WHERE voter = ?1 AND hash = ?2 AND source = 'vote'`
      ).bind(prior.voter, hash, slop ? 1 : 0, now),
      env.DB.prepare(
        `UPDATE entries SET up = MAX(0, up + ?2), down = MAX(0, down + ?3), updated = ?4
          WHERE hash = ?1`
      ).bind(hash, slop ? 1 : -1, slop ? -1 : 1, now)
    );
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO votes (voter, ipkey, hash, source, slop, created)
         VALUES (?1, ?2, ?3, 'vote', ?4, ?5)`
      ).bind(keys.userkey, keys.ipkey, hash, slop ? 1 : 0, now),
      env.DB.prepare(
        `UPDATE entries SET up = up + ?2, down = down + ?3, updated = ?4 WHERE hash = ?1`
      ).bind(hash, slop ? 1 : 0, slop ? 0 : 1, now)
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (isDuplicate(err)) return json({ ok: true, unchanged: true });
    throw err;
  }
  return json({ ok: true });
}

/**
 * A client's sampler saw a channel cross the disclosure threshold. Channels
 * only; one tally per person per channel, ever. We record the claim's
 * numbers but re-check them, and never let a tally lower a count.
 */
async function postTally(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'bad json' }, 400);

  const { id, ai, total, platform = 'youtube', voter } = body;
  if (!isValidId(id, 'channel')) return json({ error: 'bad id' }, 400);
  if (!PLATFORMS.includes(platform) || platform !== platformOf(id)) {
    return json({ error: 'bad platform' }, 400);
  }
  // Each platform's own bar; LinkedIn has no label to count, so none passes.
  if (!isValidTally(ai, total, platform)) return json({ error: 'bad tally' }, 400);

  const hash = await sha256Hex(id);
  const prefix = hash.slice(0, PREFIX_LEN);
  const keys = await voterKeys(request, env, hash, voter);
  const now = Date.now();

  if (await findVote(env, hash, 'tally', keys)) return json({ ok: true, unchanged: true });

  try {
    await env.DB.batch([
      await ensureEntry(env, { hash, prefix, id, kind: 'channel', platform, now }),
      env.DB.prepare(
        `INSERT INTO votes (voter, ipkey, hash, source, slop, created)
         VALUES (?1, ?2, ?3, 'tally', 1, ?4)`
      ).bind(keys.userkey, keys.ipkey, hash, now),
      env.DB.prepare(
        `UPDATE entries SET tallies = tallies + 1, tally_ai = tally_ai + ?2,
                tally_total = tally_total + ?3, updated = ?4 WHERE hash = ?1`
      ).bind(hash, ai, total, now),
    ]);
  } catch (err) {
    if (isDuplicate(err)) return json({ ok: true, unchanged: true });
    throw err;
  }
  return json({ ok: true });
}

/** Take back your vote on an entry: the other half of an undo button. */
async function postRetract(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'bad json' }, 400);

  const { id, kind, voter } = body;
  if (!isValidId(id, kind)) return json({ error: 'bad id' }, 400);

  const hash = await sha256Hex(id);
  const prior = await findVote(env, hash, 'vote', await voterKeys(request, env, hash, voter));
  if (!prior) return json({ ok: true, unchanged: true });

  const slop = Boolean(prior.slop);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM votes WHERE voter = ?1 AND hash = ?2 AND source = 'vote'`
    ).bind(prior.voter, hash),
    env.DB.prepare(
      `UPDATE entries SET up = MAX(0, up - ?2), down = MAX(0, down - ?3), updated = ?4
        WHERE hash = ?1`
    ).bind(hash, slop ? 1 : 0, slop ? 0 : 1, Date.now()),
  ]);
  return json({ ok: true });
}

/**
 * A message for the maintainer, with an optional email for a reply. Stored
 * for the console's inbox; never served back out. The network is kept only
 * as a salted hash, to cap how much one network can send in a day.
 */
async function postFeedback(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'bad json' }, 400);
  const fb = cleanFeedback(body);
  if (fb.error) return json({ error: fb.error }, 400);

  const netkey = await sha256Hex(`feedback:${clientNetwork(request)}:${env.VOTER_SALT || 'dev-salt'}`);
  const now = Date.now();
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feedback WHERE netkey = ?1 AND created > ?2`
  )
    .bind(netkey, now - DAY_MS)
    .first();
  if ((recent?.n ?? 0) >= FEEDBACK_PER_DAY) return tooMany(3600);

  await env.DB.prepare(
    `INSERT INTO feedback (created, category, message, email, version, netkey)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(now, fb.category, fb.message, fb.email, fb.version, netkey)
    .run();
  return json({ ok: true });
}

/**
 * An address for the Chrome Web Store launch list, from killslop.app/waitlist.
 * It is kept to be mailed once and is never published, never served back out,
 * and never joined to a vote or a lookup: nothing else here knows an address.
 *
 * Signing up twice answers exactly as signing up once does, so this endpoint
 * cannot be asked whether a given address is already on the list.
 */
async function postWaitlist(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'bad json' }, 400);
  const entry = cleanWaitlist(body);
  if (entry.error) return json({ error: entry.error }, 400);

  const netkey = await sha256Hex(`waitlist:${clientNetwork(request)}:${env.VOTER_SALT || 'dev-salt'}`);
  const now = Date.now();
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM waitlist WHERE netkey = ?1 AND created > ?2`
  )
    .bind(netkey, now - DAY_MS)
    .first();
  if ((recent?.n ?? 0) >= WAITLIST_PER_DAY) return tooMany(3600);

  await env.DB.prepare(
    `INSERT INTO waitlist (email, created, source, netkey) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(email) DO NOTHING`
  )
    .bind(entry.email, now, entry.source, netkey)
    .run();
  return json({ ok: true });
}

/* ------------------------------------------------------------------ stats */

async function getStats(env) {
  const { results } = await env.DB.prepare(
    `SELECT kind, id, platform, up, down, tallies, writings, writing_ai, writing_total,
            review, json_extract(meta, '$.ucid') AS ucid
       FROM entries`
  ).all();
  return json(countStats(results || [], reviewMode(env)), 200, { 'cache-control': 'public, max-age=60' });
}

/* --------------------------------------------------------- writing check */

/**
 * A bucket of writing-check answers, keyed by the hash of the post's text
 * rather than by an id. Same blindness as the entry buckets: the client sends
 * four hex characters and finds its own answer in what comes back, so a post
 * anyone has had checked before costs no text at all.
 */
async function getTextBucket(env, prefix) {
  if (!/^[0-9a-f]{4}$/.test(prefix)) return json({ error: 'bad prefix' }, 400);

  const { results } = await env.DB.prepare(
    `SELECT hash, score, signal, conf, model FROM texts WHERE prefix = ?1`
  )
    .bind(prefix)
    .all();

  return json({ prefix, entries: results || [] }, 200, {
    'cache-control': 'public, max-age=300',
  });
}

/**
 * Model calls made in the last day. Every call inserts exactly one row and a
 * cache hit inserts none, so the table counts itself and needs no meter.
 */
async function writingSpentToday(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM texts WHERE created > ?1`)
    .bind(Date.now() - DAY_MS)
    .first();
  return row?.n ?? 0;
}

/**
 * Check one post's writing, and remember the answer for everyone.
 *
 * The text arrives already normalized by the client (KillSlopSigns in
 * content/slopsigns.js) because the hash has to be the same on both sides.
 * It is hashed, asked about, and dropped: only the hash and the answer are
 * stored, so this table can never be read back into anyone's feed.
 *
 * This is the one endpoint that spends money, and it is unauthenticated, so
 * it is bounded four ways: the platform allow-list, the length cap, the
 * per-network limiter, and a hard daily ceiling across everyone.
 */
async function postWriting(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'bad json' }, 400);

  const { text, platform } = body;
  // YouTube is deliberately absent: guessing from titles was rejected in
  // RESEARCH.md section 7, and that has not changed.
  if (platform !== 'x' && platform !== 'linkedin') return json({ error: 'bad platform' }, 400);
  if (typeof text !== 'string' || !text.trim()) return json({ error: 'bad text' }, 400);
  if (text.length > MAX_TEXT_CHARS) return json({ error: 'text too long' }, 400);

  const hash = await sha256Hex(text);
  const cached = await env.DB.prepare(
    `SELECT hash, score, signal, conf, model FROM texts WHERE hash = ?1`
  )
    .bind(hash)
    .first();
  if (cached) return json({ ...cached, cached: true });

  if (!env.TYPESAFE_API_KEY) return json({ error: 'writing check is off' }, 503);

  const budget = Number(env.WRITING_BUDGET_PER_DAY) || 0;
  if (budget > 0 && (await writingSpentToday(env)) >= budget) {
    return json({ error: 'budget spent' }, 429, { 'retry-after': '3600' });
  }

  const answer = await askJev(text, env);
  // The check is the last tier, so no answer simply means undecided.
  if (!answer) return json({ error: 'no answer' }, 502);

  await env.DB.prepare(
    `INSERT INTO texts (hash, prefix, score, signal, conf, model, created)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(hash) DO NOTHING`
  )
    .bind(hash, hash.slice(0, PREFIX_LEN), answer.score, answer.signal, answer.conf, answer.model, Date.now())
    .run();

  return json({
    hash,
    score: answer.score,
    signal: answer.signal,
    conf: answer.conf,
    model: answer.model,
    cached: false,
  });
}

/* ----------------------------------------------------------------- router */

const WRITES = {
  '/api/v1/report': postReport,
  '/api/v1/tally': postTally,
  '/api/v1/retract': postRetract,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (isSiteHost(url)) return handleSite(request, env, url);
    const shared = await handleShared(request, env, url);
    if (shared) return shared;

    if (path === '/admin' || path.startsWith('/admin/')) return handleAdmin(request, env, url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (path === '/health') return json({ ok: true });

    if (request.method === 'GET') {
      // The API host has no home page of its own; people typing it want the site.
      if (path === '/') return Response.redirect(`https://${SITE_HOST}/`, 302);
      if (await overLimit(env, 'RL_READ', request)) return tooMany();
      const bucket = path.match(/^\/api\/v1\/bucket\/([0-9a-f]{1,8})$/);
      if (bucket) return getBucket(env, bucket[1]);
      const text = path.match(/^\/api\/v1\/text\/([0-9a-f]{1,8})$/);
      if (text) return getTextBucket(env, text[1]);
      if (Object.hasOwn(EXPORTS, path)) return getExport(env, EXPORTS[path]);
      if (path === '/api/v1/stats') return getStats(env);
    }

    if (request.method === 'POST') {
      if (path === '/api/v1/feedback') {
        if (await overLimit(env, 'RL_FEEDBACK', request)) return tooMany();
        return postFeedback(request, env);
      }
      if (path === '/api/v1/writing') {
        if (await overLimit(env, 'RL_WRITING', request)) return tooMany();
        return postWriting(request, env);
      }
      if (path === '/api/v1/waitlist') {
        if (await overLimit(env, 'RL_WAITLIST', request)) return tooMany();
        return postWaitlist(request, env);
      }
      const write = Object.hasOwn(WRITES, path) ? WRITES[path] : null;
      if (write) {
        if (await overLimit(env, 'RL_WRITE', request)) return tooMany();
        return write(request, env);
      }
    }

    return json({ error: 'not found' }, 404);
  },
};

export const __testing = { sha256Hex, isValidId, isValidTally, decide, networkOf, MIN_VOTES, MIN_TALLIES, PREFIX_LEN };
