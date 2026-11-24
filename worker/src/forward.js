/**
 * Passing X marks on to levelsio's report queue.
 *
 * blockedforaireply.levels.io takes reports of AI reply bots at
 * api/report.php (a link to the reply, nothing else). His AI reads each one,
 * then he checks the account's other replies before it joins his list, which
 * KillSlop then serves to everyone (see spamlist.js). So a mark made in the
 * extension helps his list as well as ours.
 *
 * It runs here, on a cron, rather than in the extension, for three reasons:
 *
 *   - Nothing about the person who marked it leaves our server. He gets the
 *     public link to the post and no IP, install id or count of who marked it.
 *     The one exception is opt-in: someone who typed their X username into
 *     the dashboard gets it sent as `reporter`, so his Top reporters board
 *     credits them (his API: "Apps can pass their user's username"). The
 *     earliest such mark on the post wins; an Undo deletes it with the vote.
 *   - It waits FORWARD_DELAY_MS first, so an Undo in the extension (which
 *     retracts the vote) stops it from being sent at all.
 *   - It works for every install at once, with no store review.
 *
 * Each post goes at most once (the `forwards` table), and each account once,
 * only if people marked it
 * and the maintainer did not reject it, only if it is a reply, and only if its
 * author is not already on his list.
 *
 * Off unless FORWARD_LEVELS = "on".
 *
 * Signing (from 2026-11-23, levelsio's spec): when the LEVELS_HMAC_KEY
 * secret is set, each report carries
 *
 *   X-Timestamp: unix seconds
 *   X-Signature: hex(HMAC-SHA256(LEVELS_HMAC_KEY, ts + "." + body))
 *
 * where body is the exact JSON string sent. Signed reports skip his
 * Turnstile check; he refuses a ts more than 5 minutes off (401). The key
 * lives only here (a Worker secret) and on his server; never in the
 * extension, whose source is public.
 */

import { getXSpam } from './spamlist.js';

export const REPORT_URL = 'https://blockedforaireply.com/api/report.php';
const LOOKUP_URL = 'https://cdn.syndication.twimg.com/tweet-result';
const UA = 'KillSlop (+https://killslop.app)';

/** Long enough for an Undo to land first. */
export const FORWARD_DELAY_MS = 15 * 60 * 1000;
/** Per cron run: a trickle, not a flood. */
export const FORWARD_BATCH = 20;
const TIMEOUT_MS = 8000;

const POST_ID = /^x:(\d{1,25})$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const withTimeout = () => AbortSignal.timeout?.(TIMEOUT_MS);

/** The posts due a forward, oldest first. */
async function due(env, now) {
  const { results } = await env.DB.prepare(
    `SELECT e.hash, e.id,
            (SELECT v.reporter FROM votes v
              WHERE v.hash = e.hash AND v.source = 'vote' AND v.slop = 1
                AND v.reporter IS NOT NULL
              ORDER BY v.created ASC LIMIT 1) AS reporter
       FROM entries e
      WHERE e.platform = 'x' AND e.kind = 'video'
        AND e.up > e.down
        AND (e.review IS NULL OR e.review = 'slop')
        AND e.created < ?1
        AND NOT EXISTS (SELECT 1 FROM forwards f WHERE f.hash = e.hash)
      ORDER BY e.created ASC LIMIT ?2`
  )
    .bind(now - FORWARD_DELAY_MS, FORWARD_BATCH)
    .all();
  return results || [];
}

/**
 * Who wrote a post and whether it is a reply, from X's public embed data.
 * null = gone (deleted, suspended, protected). Throws when X itself is down,
 * so the post is tried again next run instead of being written off.
 */
export async function lookup(postId, fetchImpl = fetch) {
  const res = await fetchImpl(`${LOOKUP_URL}?id=${postId}&token=0`, {
    headers: { 'user-agent': UA },
    signal: withTimeout(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lookup ${res.status}`);
  const t = await res.json().catch(() => null);
  if (!t || t.__typename !== 'Tweet' || !HANDLE.test(t.user?.screen_name || '')) return null;
  return {
    handle: t.user.screen_name,
    userId: String(t.user.id_str || ''),
    reply: Boolean(t.in_reply_to_status_id_str),
  };
}

/** Every account levelsio already has, by user id and lowercased handle. */
async function listed(env, ctx) {
  const known = new Set();
  try {
    const data = await (await getXSpam(env, ctx)).json();
    for (const [id, handle, flags] of data.accounts || []) {
      if (!/[clb]/.test(flags || '')) continue; // his flags only
      if (id) known.add(`u:${id}`);
      if (handle) known.add(`h:${handle.toLowerCase()}`);
    }
  } catch {
    /* no list: forward anyway, he dedupes on his side */
  }
  return known;
}

/** One report per account is enough: his review looks at all its replies. */
async function alreadySent(env, handle) {
  const row = await env.DB.prepare(
    `SELECT 1 AS hit FROM forwards WHERE status = 'sent' AND url LIKE ?1 LIMIT 1`
  )
    .bind(`https://x.com/${handle}/status/%`)
    .first();
  return Boolean(row);
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** hex(HMAC-SHA256(key, `${ts}.${body}`)). Exported for the tests. */
export async function sign(key, ts, body) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(`${ts}.${body}`)));
}

/**
 * Body string and headers for one report, signed when a key is set.
 * `reporter` is the X username to credit, or null.
 */
export async function reportRequest(url, key, nowMs = Date.now(), reporter = null) {
  const fields = key ? { tweet_url: url } : { tweet_url: url, website: '' };
  if (reporter && HANDLE.test(reporter)) fields.reporter = reporter;
  const body = JSON.stringify(fields);
  const headers = { 'content-type': 'application/json', 'user-agent': UA };
  if (key) {
    const ts = String(Math.floor(nowMs / 1000));
    headers['x-timestamp'] = ts;
    headers['x-signature'] = await sign(key, ts, body);
  }
  return { body, headers };
}

/** One report. Returns the status to record, or null to try again later. */
export async function send(url, fetchImpl = fetch, key = '', reporter = null) {
  let res;
  try {
    const { body, headers } = await reportRequest(url, key, Date.now(), reporter);
    res = await fetchImpl(REPORT_URL, {
      method: 'POST',
      headers,
      body,
      signal: withTimeout(),
    });
  } catch {
    return null;
  }
  if (res.status === 429 || res.status >= 500) return null;
  const j = await res.json().catch(() => null);
  if (res.ok && j?.ok) return 'sent';
  return `refused:${String(j?.error || res.status).slice(0, 80)}`;
}

/**
 * The cron job. Returns what it did, for the log and the tests.
 * `fetchImpl` is only for the tests.
 */
export async function forwardReports(env, ctx, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (env.FORWARD_LEVELS !== 'on') return { off: true };
  const rows = await due(env, now);
  const done = { sent: 0, skipped: 0, retry: 0 };
  if (!rows.length) return done;
  const known = await listed(env, ctx);

  const record = (hash, id, url, status) =>
    env.DB.prepare(
      `INSERT INTO forwards (hash, id, url, status, at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(hash) DO NOTHING`
    )
      .bind(hash, id, url, status, now)
      .run();

  for (const { hash, id, reporter } of rows) {
    const postId = POST_ID.exec(id)?.[1];
    if (!postId) {
      await record(hash, id, null, 'bad-id');
      done.skipped++;
      continue;
    }
    let post;
    try {
      post = await lookup(postId, fetchImpl);
    } catch {
      done.retry++;
      break; // X is struggling; stop this run
    }
    const url = post ? `https://x.com/${post.handle}/status/${postId}` : null;
    let status = null;
    if (!post) status = 'gone';
    else if (!post.reply) status = 'not-reply';
    else if (known.has(`u:${post.userId}`) || known.has(`h:${post.handle.toLowerCase()}`)) status = 'listed';
    else if (await alreadySent(env, post.handle)) status = 'account-sent';
    if (status) {
      await record(hash, id, url, status);
      done.skipped++;
      continue;
    }
    status = await send(url, fetchImpl, env.LEVELS_HMAC_KEY, reporter);
    if (!status) {
      done.retry++;
      break; // his server said slow down, or is down
    }
    await record(hash, id, url, status);
    if (status === 'sent') done.sent++;
    else done.skipped++;
  }
  return done;
}
