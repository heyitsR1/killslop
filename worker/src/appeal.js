/**
 * Appeals, behind killslop.app/appeal.
 *
 *   GET  /api/v1/appeal?handle=<x handle>   what each list says about an account
 *   POST /api/v1/appeal {handle, note, email?}
 *
 * An appeal asks KillSlop to stop hiding an account. It lands in two places:
 * an entry for the account in the review queue (counted as one "not slop"),
 * and a message in the console's inbox with what the lists said and the note.
 * When the maintainer marks the entry Clean, spamlist.js leaves the account
 * out of the list every client downloads, whatever the sources say.
 *
 * It cannot be passed on to levelsio. His appeal form needs a Cloudflare human
 * check that only works on his own site, and he asks the account to post an
 * oath from itself, which only the person can do. So the lookup returns a link
 * straight to his appeal form for that account, and the page sends people
 * there as the second step.
 */

import { clientNetwork, readJson } from './http.js';
import { FEEDBACK_PER_DAY, isValidEmail, sha256Hex } from './policy.js';
import { LEVELS_PAGE, getXSpam, fetchLevels } from './spamlist.js';

const HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
const NOTE_MAX = 1000;
const DAY_MS = 24 * 3600 * 1000;
const PREFIX_LEN = 4;

const DEFAULT_HIDES = /[clvk]/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });

/** The served row for a handle: [userId, handle, flags], or null. */
async function servedRow(env, ctx, handle) {
  try {
    const data = await (await getXSpam(env, ctx)).json();
    const h = handle.toLowerCase();
    return (data.accounts || []).find((r) => r[1] === h) || null;
  } catch {
    return null;
  }
}

/** levelsio's own entry, for the reason and the evidence. */
async function levelsEntry(handle) {
  const levels = await fetchLevels();
  const h = handle.toLowerCase();
  return levels?.accounts?.find((a) => (a.username || '').toLowerCase() === h) || null;
}

/** Has the maintainer already cleared this account? */
async function cleared(env, ids) {
  const hashes = await Promise.all(ids.map((id) => sha256Hex(id)));
  const rows = await env.DB.batch(
    hashes.map((h) => env.DB.prepare(`SELECT review FROM entries WHERE hash = ?1`).bind(h))
  );
  return rows.some((r) => r.results?.[0]?.review === 'clean');
}

/** What every list says about one account, in words the page can show. */
export async function describe(env, ctx, handle) {
  const [row, lv] = await Promise.all([servedRow(env, ctx, handle), levelsEntry(handle)]);
  const userId = row?.[0] || lv?.id || '';
  const flags = row?.[2] || '';
  const ids = [`x:@${handle.toLowerCase()}`, ...(userId ? [`x:u:${userId}`] : [])];
  const isCleared = await cleared(env, ids).catch(() => false);

  const levelsio = lv?.levelsio
    ? {
        status: lv.levelsio, // confirmed | likely | blocked
        created: lv.account_created || null,
        evidence: (lv.evidence || []).slice(0, 5).map((e) => ({
          date: e.date || null,
          text: typeof e.their_reply === 'string' ? e.their_reply.slice(0, 400) : null,
        })),
        appeal: `${LEVELS_PAGE}/#u-${lv.id}`,
      }
    : null;

  return {
    handle: lv?.username || row?.[1] || handle,
    userId: userId || null,
    listed: Boolean(row || lv),
    levelsio,
    clankwall: flags.includes('v'),
    killslop: flags.includes('k'),
    hiddenByDefault: !isCleared && DEFAULT_HIDES.test(flags),
    optInOnly: !isCleared && Boolean(flags) && !DEFAULT_HIDES.test(flags),
    cleared: isCleared,
  };
}

/** GET /api/v1/appeal?handle= */
export async function getAppeal(request, env, ctx, url) {
  const m = HANDLE.exec((url.searchParams.get('handle') || '').trim());
  if (!m) return json({ error: 'Enter an X username, like @username.' }, 400);
  return json(await describe(env, ctx, m[1]));
}

/** POST /api/v1/appeal */
export async function postAppeal(request, env, ctx) {
  const body = await readJson(request);
  const m = HANDLE.exec(typeof body?.handle === 'string' ? body.handle.trim() : '');
  if (!m) return json({ error: 'Enter an X username, like @username.' }, 400);
  const note =
    typeof body.note === 'string'
      ? body.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
      : '';
  if (note.length > NOTE_MAX) return json({ error: `Keep the note under ${NOTE_MAX} characters.` }, 400);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email && !isValidEmail(email)) return json({ error: 'That email address does not look right.' }, 400);

  // Appeals share feedback's daily allowance per network.
  const netkey = await sha256Hex(`feedback:${clientNetwork(request)}:${env.VOTER_SALT || 'dev-salt'}`);
  const now = Date.now();
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM feedback WHERE netkey = ?1 AND created > ?2`)
    .bind(netkey, now - DAY_MS)
    .first();
  if ((recent?.n ?? 0) >= FEEDBACK_PER_DAY) return json({ error: 'Too many messages from this network today.' }, 429);

  const d = await describe(env, ctx, m[1]);
  if (!d.listed) return json({ ok: true, listed: false });
  if (d.cleared) return json({ ok: true, listed: true, cleared: true });

  // The entry the maintainer clears. The user id is the stable spelling.
  const id = d.userId ? `x:u:${d.userId}` : `x:@${d.handle.toLowerCase()}`;
  const hash = await sha256Hex(id);
  const sources = [
    d.levelsio && `levelsio: ${d.levelsio.status} (${d.levelsio.evidence.length} replies on record)`,
    d.clankwall && 'Clankwall flag',
    d.killslop && 'KillSlop reviewed list',
  ].filter(Boolean);
  const message = [
    `Appeal from @${d.handle} (${id}).`,
    `Listed by: ${sources.join('; ') || 'nothing now'}. ${d.hiddenByDefault ? 'Hidden by default.' : 'Opt-in only.'}`,
    d.levelsio ? `levelsio page: ${d.levelsio.appeal}` : null,
    `To clear it: Entries, Queue, ${id}, Clean.`,
    '',
    note ? `Their note: ${note}` : 'No note.',
  ]
    .filter((l) => l !== null)
    .join('\n');

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO entries (hash, prefix, id, kind, platform, down, created, updated)
       VALUES (?1, ?2, ?3, 'channel', 'x', 1, ?4, ?4)
       ON CONFLICT(hash) DO UPDATE SET down = down + 1, updated = ?4`
    ).bind(hash, hash.slice(0, PREFIX_LEN), id, now),
    env.DB.prepare(
      `INSERT INTO feedback (created, category, message, email, version, netkey)
       VALUES (?1, 'appeal', ?2, ?3, NULL, ?4)`
    ).bind(now, message, email || null, netkey),
  ]);
  return json({ ok: true, listed: true, levelsio: d.levelsio?.appeal || null });
}
