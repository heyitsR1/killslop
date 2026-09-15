/**
 * Pure policy shared by the public API and the maintainer console: id
 * validation, the serve-or-withhold decision, and input cleaning. No I/O, so
 * all of it is unit-tested in test/policy.test.mjs and test/admin.test.mjs.
 */

export const PREFIX_LEN = 4;
export const MAX_ID_LEN = 64;

/**
 * Nothing one person does changes what anyone else sees. With review off, a
 * vote-only entry is served once MIN_VOTES more people say "slop" than "not
 * slop" (or the reverse); until then the server only keeps it in mind. A
 * person is a distinct install on a distinct network (see voterKeys).
 */
export const MIN_VOTES = 3;
/** Distinct reporters before a measured channel is served without review. */
export const MIN_TALLIES = 2;
/** Server-side re-check of the client's sampling threshold. */
export const TALLY_MIN_SAMPLES = 5;
export const TALLY_THRESHOLD = 0.6;
export const TALLY_MAX_SAMPLES = 500;

/**
 * How much a maintainer has to approve before the list serves it. Set by the
 * REVIEW_MODE var in wrangler.toml. Anything unrecognised means 'all', so a
 * typo fails closed.
 *
 *   all    every entry waits for review; votes and measurements only order
 *          the queue. Right while the list is young and the queue is small.
 *   votes  channels measured by >= MIN_TALLIES reporters publish on their
 *          own; opinion still waits for review.
 *   off    the automatic thresholds alone decide.
 *
 * In every mode a maintainer's call wins: 'slop' is served, 'clean' never is.
 */
export const REVIEW_MODES = ['all', 'votes', 'off'];
export const reviewMode = (env) =>
  REVIEW_MODES.includes(env?.REVIEW_MODE) ? env.REVIEW_MODE : 'all';

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * An ISP hands each IPv6 customer a whole /64, so an IPv6 address is not a
 * network. Collapse it to the /64; IPv4 is used as is.
 */
export function networkOf(ip) {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

export const isValidInstallId = (id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);

export function isValidId(id, kind) {
  if (typeof id !== 'string' || !id.length || id.length > MAX_ID_LEN) return false;
  if (kind === 'video') return /^[\w-]{11}$/.test(id);
  if (kind === 'channel') return /^(@[\w.-]{1,48}|UC[\w-]{22})$/.test(id);
  return false;
}

/** A tally claim we are willing to record. Integers, sane, over threshold. */
export function isValidTally(ai, total) {
  if (!Number.isInteger(ai) || !Number.isInteger(total)) return false;
  if (total < TALLY_MIN_SAMPLES || total > TALLY_MAX_SAMPLES) return false;
  if (ai < 0 || ai > total) return false;
  return ai / total >= TALLY_THRESHOLD;
}

/**
 * What the list says about an entry, or null to keep it in mind unserved.
 * `evidence` tells clients what backs a served entry: 'disclosure' (clients
 * measured the channel's own AI labels), 'vote' (people's clicks), or
 * 'review' (a maintainer checked it and nothing was measured).
 */
export function decide(row, mode = 'all') {
  if (row.review === 'clean') return null;
  if (row.review === 'slop') {
    return { slop: true, evidence: row.tallies > 0 ? 'disclosure' : 'review' };
  }
  if (mode === 'all') return null;

  const score = row.up - row.down;
  // Measurement stands unless enough people push back.
  if (row.tallies >= MIN_TALLIES && score > -MIN_VOTES) return { slop: true, evidence: 'disclosure' };
  if (mode === 'votes') return null;

  if (score >= MIN_VOTES) return { slop: true, evidence: 'vote' };
  if (score <= -MIN_VOTES) return { slop: false, evidence: 'vote' };
  return null;
}

/**
 * A pasted YouTube link or bare id, as {id, kind}, or null. Accepts watch,
 * youtu.be, Shorts, embed and live links, /channel/UC... and /@handle.
 */
export function parseYouTubeInput(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 500) return null;
  if (isValidId(s, 'channel')) return { id: s, kind: 'channel' };
  if (isValidId(s, 'video')) return { id: s, kind: 'video' };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  const video = (id) => (isValidId(id, 'video') ? { id, kind: 'video' } : null);

  if (host === 'youtu.be') return video(parts[0]);
  if (host !== 'youtube.com') return null;
  if (parts[0] === 'watch') return video(url.searchParams.get('v'));
  if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) return video(parts[1]);
  if (parts[0] === 'channel') return isValidId(parts[1], 'channel') ? { id: parts[1], kind: 'channel' } : null;
  if (parts[0]?.startsWith('@')) {
    let handle;
    try {
      handle = decodeURIComponent(parts[0]);
    } catch {
      return null;
    }
    return isValidId(handle, 'channel') ? { id: handle, kind: 'channel' } : null;
  }
  return null;
}

/* --------------------------------------------------------------- feedback */

export const FEEDBACK_CATEGORIES = ['bug', 'wrong', 'idea', 'other'];
export const FEEDBACK_MAX_CHARS = 4000;
/** Messages one network may send in 24 hours. */
export const FEEDBACK_PER_DAY = 20;

export const isValidEmail = (s) =>
  typeof s === 'string' && s.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(s);

/**
 * A feedback submission, trimmed and checked, or {error}. Email is optional;
 * control characters other than newline and tab are dropped from the message.
 */
export function cleanFeedback(body) {
  if (!body || typeof body !== 'object') return { error: 'bad body' };
  const message =
    typeof body.message === 'string'
      ? body.message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
      : '';
  if (!message) return { error: 'empty message' };
  if (message.length > FEEDBACK_MAX_CHARS) return { error: 'message too long' };

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email && !isValidEmail(email)) return { error: 'bad email' };

  return {
    message,
    email: email || null,
    category: FEEDBACK_CATEGORIES.includes(body.category) ? body.category : 'other',
    version:
      typeof body.version === 'string' && /^[\w.+-]{1,32}$/.test(body.version) ? body.version : null,
  };
}
