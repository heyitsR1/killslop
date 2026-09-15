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
 *   tally  a client's disclosure sampler saw a channel cross the threshold:
 *          >= 60% of >= 5 sampled uploads carry YouTube's own AI label.
 *          Objective, needs no moderator, and cannot be gamed without also
 *          gaming YouTube's own labelling.
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
  PREFIX_LEN,
  cleanFeedback,
  decide,
  isValidId,
  isValidInstallId,
  isValidTally,
  networkOf,
  reviewMode,
  sha256Hex,
} from './policy.js';
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
    `SELECT hash, kind, up, down, tallies, review FROM entries WHERE prefix = ?1`
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
 * The decided channel list in the clear, for consumers that cannot do a
 * bucket lookup (uBlock lists, ReVanced-style patches, researchers).
 * Channels are public entities; videos are not exported.
 */
async function getExport(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, up, down, tallies, tally_ai, tally_total, review, updated FROM entries
      WHERE kind = 'channel' AND platform = 'youtube'
      ORDER BY updated DESC LIMIT 50000`
  ).all();

  const mode = reviewMode(env);
  const channels = [];
  for (const r of results || []) {
    const d = decide(r, mode);
    if (!d || !d.slop) continue;
    channels.push({
      id: r.id,
      evidence: d.evidence,
      reviewed: r.review === 'slop',
      score: r.up - r.down,
      tallies: r.tallies,
      sampled: r.tally_total ? { ai: r.tally_ai, total: r.tally_total } : null,
      updated: r.updated,
    });
  }
  return json(
    { license: 'CC0-1.0', generated: Date.now(), channels },
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
  if (!['youtube'].includes(platform)) return json({ error: 'bad platform' }, 400);

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
  if (!isValidTally(ai, total)) return json({ error: 'bad tally' }, 400);
  if (!['youtube'].includes(platform)) return json({ error: 'bad platform' }, 400);

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

/* ------------------------------------------------------------------ stats */

async function getStats(env) {
  const { results } = await env.DB.prepare(
    `SELECT kind, up, down, tallies, review FROM entries`
  ).all();
  const mode = reviewMode(env);
  const out = { mode, entries: 0, pending: 0, reviewed: 0, videos: 0, channels: 0, channelsByDisclosure: 0 };
  for (const r of results || []) {
    out.entries += 1;
    if (r.review === 'slop') out.reviewed += 1;
    const d = decide(r, mode);
    if (!d) out.pending += 1; // kept in mind, waiting for review or more people
    if (!d?.slop) continue;
    if (r.kind === 'video') out.videos += 1;
    if (r.kind === 'channel') {
      out.channels += 1;
      if (d.evidence === 'disclosure') out.channelsByDisclosure += 1;
    }
  }
  return json(out, 200, { 'cache-control': 'public, max-age=60' });
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
      if (path === '/api/v1/export/youtube-channels.json') return getExport(env);
      if (path === '/api/v1/stats') return getStats(env);
    }

    if (request.method === 'POST') {
      if (path === '/api/v1/feedback') {
        if (await overLimit(env, 'RL_FEEDBACK', request)) return tooMany();
        return postFeedback(request, env);
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
