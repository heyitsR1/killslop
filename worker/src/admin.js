/**
 * Maintainer console, everything under /admin: the review queue that decides
 * what enters the final database, and the feedback inbox.
 *
 * One secret guards it, ADMIN_PASSWORD (`npx wrangler secret put
 * ADMIN_PASSWORD`). The browser trades it at /admin/login for a signed,
 * HttpOnly session cookie; scripts may send it as `Authorization: Bearer`.
 * With no secret set the console is switched off, never open.
 *
 * The pages are static files in worker/public/admin. Every request runs this
 * worker first (run_worker_first in wrangler.toml), so the pages are only
 * ever served through the checks below.
 */

import { PREFIX_LEN, decide, parseInput, platformOf, reviewMode, sha256Hex } from './policy.js';
import { overLimit, readJson } from './http.js';
import { VERDICT, probeWith } from '../../extension/src/core/innertube.js';

const COOKIE = '__Host-killslop-admin';
const SESSION_SECONDS = 30 * 24 * 3600;
const PAGE_SIZE = 50;
const META_TTL_MS = 7 * 24 * 3600 * 1000;
/** Recent uploads fetched, and label-checked, per channel. */
const RECENT_UPLOADS = 6;

const HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https://i.ytimg.com; " +
    "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // Not 'no-referrer': under it Chrome sends `Origin: null` on the console's
  // own POSTs, which the same-origin check below would then refuse.
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS },
  });

const redirect = (location, extra = {}) =>
  new Response(null, { status: 303, headers: { location, ...HEADERS, ...extra } });

/* --------------------------------------------------------------- sessions */

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

/** Derived from the password, so changing the password signs everyone out. */
async function sessionKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`killslop-session:${env.ADMIN_PASSWORD}`));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function mintSession(env, now = Date.now()) {
  const exp = Math.floor(now / 1000) + SESSION_SECONDS;
  const sig = await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode(`admin:${exp}`));
  return `${exp}.${hex(sig)}`;
}

async function checkSession(env, value, now = Date.now()) {
  const m = /^(\d{10})\.([0-9a-f]{64})$/.exec(value || '');
  if (!m || Number(m[1]) * 1000 <= now) return false;
  return crypto.subtle.verify('HMAC', await sessionKey(env), unhex(m[2]), enc.encode(`admin:${m[1]}`));
}

/** Compares digests, so neither the length nor the content of a guess leaks. */
async function passwordMatches(env, given) {
  if (typeof given !== 'string' || !given || !env.ADMIN_PASSWORD) return false;
  const [a, b] = await Promise.all(
    [given, env.ADMIN_PASSWORD].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s)))
  );
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function cookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/** 'bearer', 'cookie', or null when the request is not the maintainer's. */
async function authed(request, env) {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (bearer) return (await passwordMatches(env, bearer[1].trim())) ? 'bearer' : null;
  return (await checkSession(env, cookie(request, COOKIE))) ? 'cookie' : null;
}

const sessionCookie = (value, maxAge) =>
  `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`;

/**
 * Whether a POST came from the console's own pages. Origin decides when the
 * browser sends a real one; when it sends `null` or nothing, Sec-Fetch-Site
 * does, and page scripts cannot forge either header.
 */
function fromOurPage(request, url) {
  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') return origin === url.origin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

async function login(request, env, url) {
  if (!fromOurPage(request, url)) return redirect('/admin?error=origin');
  if (await overLimit(env, 'RL_LOGIN', request)) return redirect('/admin?error=rate');
  const form = await request.formData().catch(() => null);
  const password = form?.get('password');
  if (!(await passwordMatches(env, typeof password === 'string' ? password : ''))) {
    return redirect('/admin?error=wrong');
  }
  return redirect('/admin', { 'set-cookie': sessionCookie(await mintSession(env), SESSION_SECONDS) });
}

const logout = () => redirect('/admin', { 'set-cookie': sessionCookie('', 0) });

/* ----------------------------------------------------------------- router */

/** Served to anyone: the sign-in page needs its stylesheet and script. */
const PUBLIC_FILES = new Set(['/admin/app.css', '/admin/login.js', '/admin/favicon.svg']);

async function file(env, request, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  const out = new Response(res.body, res);
  for (const [key, value] of Object.entries(HEADERS)) out.headers.set(key, value);
  return out;
}

export async function handleAdmin(request, env, url) {
  if (!env.ADMIN_PASSWORD) {
    return new Response('The console is not configured on this deployment.\n', {
      status: 503,
      headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const path = url.pathname.replace(/\/+$/, '');
  const { method } = request;

  if (method === 'GET' && PUBLIC_FILES.has(path)) return file(env, request, path);
  if (method === 'POST' && path === '/admin/login') return login(request, env, url);

  // Every bearer request is a password guess, so it spends the sign-in budget.
  if (request.headers.has('authorization') && (await overLimit(env, 'RL_LOGIN', request))) {
    return json({ error: 'rate limited' }, 429);
  }
  const who = await authed(request, env);

  if (method === 'GET' && path === '/admin') {
    return file(env, request, who ? '/admin/index.html' : '/admin/login.html');
  }
  if (!who) return json({ error: 'unauthorized' }, 401);

  // The browser attaches the session cookie to any request it makes, so a
  // cookie-authenticated write must also prove it came from our own page.
  if (method !== 'GET' && who === 'cookie' && !fromOurPage(request, url)) {
    return json({ error: 'bad origin' }, 403);
  }

  if (method === 'GET' && path === '/admin/app.js') return file(env, request, path);
  const route = ROUTES[`${method} ${path}`];
  return route ? route(request, env, url) : json({ error: 'not found' }, 404);
}

/* ---------------------------------------------------------------- entries */

const STATUS_SQL = { queue: 'review IS NULL', slop: "review = 'slop'", clean: "review = 'clean'" };
const SORT_SQL = {
  signal: 'tallies DESC, (up - down) DESC, updated DESC',
  recent: 'updated DESC',
  reviewed: 'reviewed_at DESC, updated DESC',
};
// decide() reads the writing columns too, so the console's "served" state
// depends on them being selected here.
const ENTRY_COLUMNS =
  'hash, id, kind, platform, up, down, tallies, tally_ai, tally_total, ' +
  'writings, writing_ai, writing_total, created, updated, ' +
  'review, reviewed_at, title, meta, meta_at';

const pick = (table, key, fallback) => (Object.hasOwn(table, key ?? '') ? key : fallback);
const offsetOf = (url) =>
  Math.min(Math.max(parseInt(url.searchParams.get('offset'), 10) || 0, 0), 1_000_000);
const isHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

function parseMeta(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function overview(request, env) {
  const [entries, feedback] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COALESCE(review, 'queue') AS status, kind, COUNT(*) AS n FROM entries GROUP BY 1, 2`
    ),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM feedback GROUP BY status`),
  ]);
  const counts = { queue: {}, slop: {}, clean: {} };
  for (const r of entries.results || []) if (counts[r.status]) counts[r.status][r.kind] = r.n;
  const inbox = { new: 0, done: 0 };
  for (const r of feedback.results || []) inbox[r.status] = r.n;
  return json({ mode: reviewMode(env), entries: counts, feedback: inbox });
}

async function listEntries(request, env, url) {
  const q = url.searchParams;
  const status = pick(STATUS_SQL, q.get('status'), 'queue');
  const sort = pick(SORT_SQL, q.get('sort'), status === 'queue' ? 'signal' : 'reviewed');
  const kind = ['channel', 'video'].includes(q.get('kind')) ? q.get('kind') : null;

  // Only fixed fragments are interpolated; the one caller-supplied value is bound.
  const stmt = env.DB.prepare(
    `SELECT ${ENTRY_COLUMNS} FROM entries
      WHERE ${STATUS_SQL[status]}${kind ? ' AND kind = ?1' : ''}
      ORDER BY ${SORT_SQL[sort]} LIMIT ${PAGE_SIZE + 1} OFFSET ${offsetOf(url)}`
  );
  const { results } = await (kind ? stmt.bind(kind) : stmt).all();

  const mode = reviewMode(env);
  const rows = results || [];
  return json({
    entries: rows
      .slice(0, PAGE_SIZE)
      .map((r) => ({ ...r, meta: parseMeta(r.meta), served: decide(r, mode) })),
    more: rows.length > PAGE_SIZE,
  });
}

/**
 * A channel can be listed twice, as @handle and as UC id, because clients
 * report whichever spelling a tile carried. Once the console has resolved a
 * handle's UC id (stored as meta.ucid), a verdict on either spelling is copied
 * to the other, and an approved handle gets its missing UC twin, so a client
 * that only knows one spelling still matches.
 */
async function applyToTwins(env, hashes, review, at) {
  const { results } = await env.DB.prepare(
    `SELECT hash, id, meta FROM entries
      WHERE kind = 'channel' AND hash IN (${hashes.map((_, i) => `?${i + 1}`).join(', ')})`
  )
    .bind(...hashes)
    .all();

  const now = Date.now();
  const statements = [];
  for (const row of results || []) {
    // Only YouTube spells one channel two ways; an X handle's alias is not a twin.
    if (platformOf(row.id) !== 'youtube') continue;
    const ucid = row.id.startsWith('UC') ? row.id : parseMeta(row.meta)?.ucid;
    if (!ucid) continue;
    if (review === 'slop' && ucid !== row.id) {
      const twin = await sha256Hex(ucid);
      statements.push(
        env.DB.prepare(
          `INSERT INTO entries (hash, prefix, id, kind, platform, created, updated)
           VALUES (?1, ?2, ?3, 'channel', 'youtube', ?4, ?4) ON CONFLICT(hash) DO NOTHING`
        ).bind(twin, twin.slice(0, PREFIX_LEN), ucid, now)
      );
    }
    statements.push(
      env.DB.prepare(
        `UPDATE entries SET review = ?3, reviewed_at = ?4
          WHERE kind = 'channel' AND hash != ?1
            AND (id = ?2 OR json_extract(meta, '$.ucid') = ?2)`
      ).bind(row.hash, ucid, review, at)
    );
  }
  if (!statements.length) return 0;
  const done = await env.DB.batch(statements);
  return done.reduce((n, r) => n + (r.meta?.changes || 0), 0);
}

async function setReview(request, env) {
  const body = await readJson(request);
  const hashes = Array.isArray(body?.hashes) ? body.hashes : [body?.hash];
  const review = body?.review ?? null;
  if (!['slop', 'clean', null].includes(review)) return json({ error: 'bad review' }, 400);
  if (!hashes.length || hashes.length > 90 || !hashes.every(isHash)) {
    return json({ error: 'bad hash' }, 400);
  }

  const at = review ? Date.now() : null;
  const done = await env.DB.batch(
    hashes.map((h) =>
      env.DB.prepare(`UPDATE entries SET review = ?2, reviewed_at = ?3 WHERE hash = ?1`).bind(h, review, at)
    )
  );
  const changed = done.reduce((n, r) => n + (r.meta?.changes || 0), 0);
  if (!changed) return json({ error: 'not found' }, 404);
  return json({ ok: true, changed, twins: await applyToTwins(env, hashes, review, at) });
}

/** Put a pasted link straight into the final database. */
async function addEntry(request, env) {
  const body = await readJson(request);
  const parsed = await parseInput(body?.input);
  if (!parsed) return json({ error: 'That is not a YouTube, X or LinkedIn link.' }, 400);

  const hash = await sha256Hex(parsed.id);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO entries (hash, prefix, id, kind, platform, created, updated)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) ON CONFLICT(hash) DO NOTHING`
    ).bind(hash, hash.slice(0, PREFIX_LEN), parsed.id, parsed.kind, parsed.platform, now),
    env.DB.prepare(`UPDATE entries SET review = 'slop', reviewed_at = ?2 WHERE hash = ?1`).bind(hash, now),
  ]);

  // Resolve right away, so a handle's UC twin is found and approved with it.
  let info = null;
  try {
    info = await refreshMeta(env, { hash, ...parsed });
  } catch {
    /* the entry is in; the console can resolve it later */
  }
  const twins = await applyToTwins(env, [hash], 'slop', now);
  return json({ ok: true, hash, ...parsed, title: info?.title ?? null, twins });
}

async function entryMeta(request, env, url) {
  const hash = url.searchParams.get('hash');
  if (!isHash(hash)) return json({ error: 'bad hash' }, 400);
  const row = await env.DB.prepare(`SELECT hash, id, kind, title, meta, meta_at FROM entries WHERE hash = ?1`)
    .bind(hash)
    .first();
  if (!row) return json({ error: 'not found' }, 404);

  const fresh = row.meta_at && Date.now() - row.meta_at < META_TTL_MS;
  if (fresh && !url.searchParams.has('refresh')) {
    return json({ title: row.title, meta: parseMeta(row.meta) });
  }
  const info = await refreshMeta(env, row);
  if (info.transient) return json({ error: 'YouTube did not answer. Try Recheck.' }, 502);
  return json({ title: info.title, meta: info.meta });
}

async function refreshMeta(env, row) {
  // Lookups exist for YouTube only. Elsewhere there is nothing to fetch, which
  // is an answer, not a network failure, so it is neither stored nor retried.
  if (platformOf(row.id) !== 'youtube') return { title: null, meta: null };
  let info;
  try {
    info = row.kind === 'video' ? await videoInfo(row.id) : await channelInfo(row.id);
  } catch {
    info = { transient: true, title: null, meta: null }; // timed out or refused
  }
  // A network hiccup is not a fact about the video: store real answers only.
  if (!info.transient) {
    await env.DB.prepare(`UPDATE entries SET title = ?2, meta = ?3, meta_at = ?4 WHERE hash = ?1`)
      .bind(row.hash, info.title, JSON.stringify(info.meta), Date.now())
      .run();
  }
  return info;
}

/* ---------------------------------------------------------------- YouTube */

const YT = 'https://www.youtube.com';
// English so titles are stable; SOCS skips the EU consent interstitial.
const YT_HEADERS = { 'accept-language': 'en-US,en;q=0.8', cookie: 'SOCS=CAI' };
/** A lookup that has not answered by now is not going to. */
const YT_TIMEOUT_MS = 8000;

const yt = (url) => fetch(url, { headers: YT_HEADERS, signal: AbortSignal.timeout(YT_TIMEOUT_MS) });

/**
 * The same masked InnerTube probe the content script sends. From a worker
 * there is no extension origin for YouTube to refuse (RESEARCH.md section 5),
 * and no cookie jar for `credentials` to leave out.
 */
function ytFetch(path, init = {}) {
  const { credentials, ...rest } = init;
  return fetch(`${YT}${path}`, { ...rest, signal: AbortSignal.timeout(YT_TIMEOUT_MS) });
}

/** true, false, or null when YouTube did not answer. */
async function aiLabel(videoId) {
  const { verdict } = await probeWith(ytFetch, videoId);
  return verdict === VERDICT.UNKNOWN ? null : verdict === VERDICT.AI;
}

async function videoInfo(id) {
  const [res, label] = await Promise.all([
    yt(`${YT}/oembed?format=json&url=${encodeURIComponent(`${YT}/watch?v=${id}`)}`),
    aiLabel(id),
  ]);
  // oEmbed says 404 for deleted and 401 for private or embed-disabled videos.
  if ([400, 401, 403, 404].includes(res.status)) {
    return { title: null, meta: { unavailable: true, aiLabel: label } };
  }
  if (!res.ok) return { transient: true, title: null, meta: null };
  const o = await res.json();
  const handle = /\/(@[\w.-]+)\/?$/.exec(o.author_url || '')?.[1] ?? null;
  return { title: o.title ?? null, meta: { channel: o.author_name ?? null, handle, aiLabel: label } };
}

async function channelInfo(id) {
  let ucid = id.startsWith('UC') ? id : null;
  let title = null;

  if (!ucid) {
    const page = await yt(`${YT}/${id}`);
    if (page.status === 404) return { title: null, meta: { unavailable: true } };
    if (!page.ok) return { transient: true, title: null, meta: null };
    ({ ucid, title } = await channelPageFacts(page));
    if (!ucid) return { transient: true, title, meta: null };
  }

  const feed = await yt(`${YT}/feeds/videos.xml?channel_id=${ucid}`);
  if (feed.status === 404) return { title, meta: { ucid, unavailable: true } };
  if (!feed.ok) return { transient: true, title, meta: { ucid } };

  const parsed = parseFeed(await feed.text());
  const recent = parsed.videos.slice(0, RECENT_UPLOADS);
  const labels = await Promise.all(recent.map((v) => aiLabel(v.id)));
  const checked = labels.filter((l) => l !== null);
  return {
    title: parsed.title || title,
    meta: {
      ucid,
      recent: recent.map((v, i) => ({ ...v, ai: labels[i] })),
      labelled: { ai: checked.filter(Boolean).length, total: checked.length },
    },
  };
}

/** A handle's display name and UC id, streamed out of its channel page. */
async function channelPageFacts(res) {
  const found = { ucid: null, title: null };
  if (typeof HTMLRewriter === 'undefined') return found;
  await new HTMLRewriter()
    .on('meta[property="og:title"]', {
      element(e) {
        found.title ??= e.getAttribute('content');
      },
    })
    .on('link[rel="canonical"]', {
      element(e) {
        found.ucid ??= /\/channel\/(UC[\w-]{22})/.exec(e.getAttribute('href') || '')?.[1] ?? null;
      },
    })
    .transform(res)
    .arrayBuffer();
  return found;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e) => {
    if (e[0] !== '#') return XML_ENTITIES[e] ?? whole;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return whole;
    }
  });
}

/**
 * Channel name and uploads, newest first, from a channel's RSS feed. Also used
 * by scripts/measure-channels.mjs.
 */
export function parseFeed(xml) {
  const head = xml.split('<entry>')[0];
  const title = decodeXml(/<title>([^<]*)<\/title>/.exec(head)?.[1] ?? '') || null;
  const videos = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = /<yt:videoId>([\w-]{11})<\/yt:videoId>/.exec(entry)?.[1];
    if (id) videos.push({ id, title: decodeXml(/<title>([^<]*)<\/title>/.exec(entry)?.[1] ?? '') });
  }
  return { title, videos };
}

/* --------------------------------------------------------------- feedback */

async function listFeedback(request, env, url) {
  const status = ['new', 'done'].includes(url.searchParams.get('status'))
    ? url.searchParams.get('status')
    : null;
  const stmt = env.DB.prepare(
    `SELECT id, created, category, message, email, version, status FROM feedback
      ${status ? 'WHERE status = ?1' : ''}
      ORDER BY created DESC LIMIT ${PAGE_SIZE + 1} OFFSET ${offsetOf(url)}`
  );
  const { results } = await (status ? stmt.bind(status) : stmt).all();
  const rows = results || [];
  return json({ feedback: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE });
}

async function setFeedbackStatus(request, env) {
  const body = await readJson(request);
  if (!Number.isInteger(body?.id) || !['new', 'done'].includes(body?.status)) {
    return json({ error: 'bad request' }, 400);
  }
  await env.DB.prepare(`UPDATE feedback SET status = ?2 WHERE id = ?1`).bind(body.id, body.status).run();
  return json({ ok: true });
}

async function deleteFeedback(request, env) {
  const body = await readJson(request);
  if (!Number.isInteger(body?.id)) return json({ error: 'bad request' }, 400);
  await env.DB.prepare(`DELETE FROM feedback WHERE id = ?1`).bind(body.id).run();
  return json({ ok: true });
}

const ROUTES = {
  'GET /admin/api/overview': overview,
  'GET /admin/api/entries': listEntries,
  'GET /admin/api/meta': entryMeta,
  'POST /admin/api/review': setReview,
  'POST /admin/api/add': addEntry,
  'GET /admin/api/feedback': listFeedback,
  'POST /admin/api/feedback/status': setFeedbackStatus,
  'POST /admin/api/feedback/delete': deleteFeedback,
  'POST /admin/logout': logout,
};

export const __testing = { mintSession, checkSession, passwordMatches, parseFeed, COOKIE };
