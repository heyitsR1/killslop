/**
 * The X AI-reply spammer list: one file the extension downloads whole and
 * matches locally, so asking about an account never tells us which account.
 *
 * Three sources, merged:
 *
 *   levelsio   blockedforaireply.levels.io, the accounts @levelsio blocked for
 *              AI replies. Each carries his own status: 'confirmed' (a public
 *              "Blocked for AI reply" with the reply as evidence), 'likely'
 *              (created 2023+, blocked without interaction) or 'blocked' (an
 *              older silent block he has not reviewed).
 *   clankwall  clankwall.vogel.dev, @ryanvogel's AI flags. levelsio's file
 *              already folds these in (its `ryanvogel` field), so they arrive
 *              with it rather than by a second fetch.
 *   killslop   our own X accounts, after a maintainer approved them. Same rows
 *              the public export serves.
 *
 * Each account is [userId, handle, flags]. Either id may be empty. Flags:
 *
 *   c  levelsio confirmed, with evidence
 *   b  levelsio block with no evidence on record: a silent block he has not
 *      reviewed, or (with n) one he rates 'likely'
 *   n  levelsio 'likely' (account created 2023+); always comes with b
 *   v  flagged on Clankwall                    k  on KillSlop's own reviewed list
 *
 * By default clients hide c, v and k. An account with only b (with or without
 * n) has nothing on record but the block, so it hides only on opt-in. The old
 * 'l' flag is no longer served (clients still read it, so old caches work).
 *
 * The client decides what to act on (settings.spamListUnreviewed covers `b`).
 */

import { decide, reviewMode } from './policy.js';

export const LEVELS_URL = 'https://blockedforaireply.levels.io/api/accounts.json';
export const LEVELS_PAGE = 'https://blockedforaireply.levels.io';
export const CLANKWALL_PAGE = 'https://clankwall.vogel.dev';

/** How long a built list is served before it is rebuilt from the sources. */
const FRESH_SECONDS = 1800;
/** How long the last good build is kept, for when a source is down. */
const STALE_SECONDS = 7 * 24 * 3600;
const UPSTREAM_TIMEOUT_MS = 10_000;

const CACHE_FRESH = 'https://cache.killslop.internal/x-spam/fresh/v2';
const CACHE_STALE = 'https://cache.killslop.internal/x-spam/stale/v2';

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const USER_ID = /^\d{1,20}$/;

/**
 * Merge the sources into the served shape. Pure, so the tests can feed it.
 *
 * @param {object|null} levels   levelsio's accounts.json, or null if unreachable
 * @param {string[]} ours        our own reviewed X ids: 'x:u:<id>' or 'x:@handle'
 * @param {string[]} cleared     X ids the maintainer marked Clean (an appeal
 *                               upheld, see appeal.js): left out whatever any
 *                               source says
 */
export function buildList(levels, ours = [], cleared = []) {
  const byKey = new Map(); // 'u:<id>' or 'h:<handle>' -> row
  const rows = [];

  function upsert(id, handle, flag) {
    id = USER_ID.test(id ?? '') ? id : '';
    handle = HANDLE.test(handle ?? '') ? handle.toLowerCase() : '';
    if (!id && !handle) return;
    let row = (id && byKey.get(`u:${id}`)) || (handle && byKey.get(`h:${handle}`));
    if (!row) {
      row = [id, handle, ''];
      rows.push(row);
    }
    if (id && !row[0]) row[0] = id;
    if (handle && !row[1]) row[1] = handle;
    if (row[0]) byKey.set(`u:${row[0]}`, row);
    if (row[1]) byKey.set(`h:${row[1]}`, row);
    if (!row[2].includes(flag)) row[2] += flag;
  }

  let levelsMeta = null;
  if (levels && Array.isArray(levels.accounts)) {
    for (const a of levels.accounts) {
      const status = a?.levelsio;
      if (status === 'confirmed') upsert(a.id, a.username, 'c');
      // 'likely' is a block plus a new account, with no reply on record. Served
      // as unreviewed ('b'), so it hides only for people who opt in, with 'n'
      // kept so a client can still tell it apart. Since 2026-11-22; before
      // that it was 'l' and hid by default.
      else if (status === 'likely') upsert(a.id, a.username, 'b'), upsert(a.id, a.username, 'n');
      else if (status === 'blocked') upsert(a.id, a.username, 'b');
      if (a?.ryanvogel) upsert(a.id, a.username, 'v');
    }
    levelsMeta = {
      page: LEVELS_PAGE,
      updated: typeof levels.updated_at === 'string' ? levels.updated_at : null,
      total: levels.accounts.length,
    };
  }

  let mine = 0;
  for (const id of ours) {
    const m = /^x:(?:u:(\d{1,20})|@([a-z0-9_]{1,15}))$/.exec(id);
    if (!m) continue;
    upsert(m[1] || '', m[2] || '', 'k');
    mine++;
  }

  const gone = new Set();
  for (const id of cleared) {
    const m = /^x:(?:u:(\d{1,20})|@([a-z0-9_]{1,15}))$/.exec(String(id).toLowerCase());
    if (m?.[1]) gone.add(`u:${m[1]}`);
    if (m?.[2]) gone.add(`h:${m[2]}`);
  }
  const kept = gone.size ? rows.filter((r) => !gone.has(`u:${r[0]}`) && !gone.has(`h:${r[1]}`)) : rows;

  return {
    version: 1,
    generated: Date.now(),
    sources: {
      levelsio: levelsMeta,
      clankwall: levelsMeta ? { page: CLANKWALL_PAGE, via: 'levelsio' } : null,
      killslop: { page: 'https://killslop.app', count: mine },
    },
    note: 'Flags are judgment calls by each source, not proof. Evidence for levelsio entries: ' + LEVELS_PAGE,
    accounts: kept,
  };
}

export async function fetchLevels() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(LEVELS_URL, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'KillSlop list mirror (+https://killslop.app)' },
      cf: { cacheTtl: 600, cacheEverything: true },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body?.accounts) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOurs(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, platform, up, down, tallies, tally_ai, tally_total,
            writings, writing_ai, writing_total, review, updated
       FROM entries
      WHERE kind = 'channel' AND platform = 'x'
      LIMIT 50000`
  ).all();
  const mode = reviewMode(env);
  const rows = results || [];
  return {
    ours: rows.filter((r) => decide(r, mode)?.slop).map((r) => r.id),
    cleared: rows.filter((r) => r.review === 'clean').map((r) => r.id),
  };
}

const respond = (body, extra = {}) =>
  new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': `public, max-age=${FRESH_SECONDS}`,
      ...extra,
    },
  });

/** GET /api/v1/x-spam.json */
export async function getXSpam(env, ctx) {
  const cache = globalThis.caches?.default;
  const fresh = cache && (await cache.match(CACHE_FRESH));
  if (fresh) return respond(await fresh.text(), { 'x-killslop-cache': 'hit' });

  const [levels, { ours, cleared }] = await Promise.all([
    fetchLevels(),
    fetchOurs(env).catch(() => ({ ours: [], cleared: [] })),
  ]);

  // A source being down must not shrink everyone's list: serve the last good
  // build until it is back, rather than one without levelsio in it.
  if (!levels && cache) {
    const stale = await cache.match(CACHE_STALE);
    if (stale) return respond(await stale.text(), { 'x-killslop-cache': 'stale' });
  }

  const body = JSON.stringify(buildList(levels, ours, cleared));
  if (cache && levels) {
    const put = Promise.all([
      cache.put(CACHE_FRESH, respond(body, { 'cache-control': `public, max-age=${FRESH_SECONDS}` })),
      cache.put(CACHE_STALE, respond(body, { 'cache-control': `public, max-age=${STALE_SECONDS}` })),
    ]).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return respond(body, { 'x-killslop-cache': 'miss' });
}
