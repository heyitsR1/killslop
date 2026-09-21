/**
 * Pure policy shared by the public API and the maintainer console: id
 * validation, the serve-or-withhold decision, and input cleaning. No I/O, so
 * all of it is unit-tested in test/policy.test.mjs and test/admin.test.mjs.
 */

export const PREFIX_LEN = 4;
/** Room for a LinkedIn slug whose letters are percent-encoded. */
export const MAX_ID_LEN = 128;

/**
 * Nothing one person does changes what anyone else sees. With review off, a
 * vote-only entry is served once MIN_VOTES more people say "slop" than "not
 * slop" (or the reverse); until then the server only keeps it in mind. A
 * person is a distinct install on a distinct network (see voterKeys).
 */
export const MIN_VOTES = 3;
/** Distinct reporters before a measured channel is served without review. */
export const MIN_TALLIES = 2;
/** The same, for the weaker writing evidence. */
export const MIN_WRITINGS = 2;

export const PLATFORMS = ['youtube', 'x', 'linkedin'];

/**
 * Server-side re-check of each platform's sampling threshold, the same one
 * the extension applies before it shares a tally. YouTube slop farms label
 * nearly every upload (RESEARCH.md section 7); AI accounts on X label 14-68%
 * of their media and ordinary accounts none (section 15). LinkedIn has no
 * label to count (section 22), so it takes no tallies at all.
 */
export const TALLY_RULES = {
  youtube: { minSamples: 5, threshold: 0.6, maxSamples: 500 },
  x: { minSamples: 8, threshold: 0.25, maxSamples: 500 },
};

/**
 * The same shape for the writing check (src/jev.js), which reads the words
 * rather than counting a label the platform published. It covers LinkedIn,
 * where there is no label to count at all and this is the only signal there
 * has ever been.
 *
 * The bar is higher than X's disclosure bar because the evidence is weaker:
 * half an author's checked posts, not a quarter. These are starting points to
 * re-measure, not settled constants; see RESEARCH.md.
 */
export const WRITING_RULES = {
  x: { minSamples: 6, threshold: 0.5, maxSamples: 500 },
  linkedin: { minSamples: 6, threshold: 0.5, maxSamples: 500 },
};

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

/**
 * The list is keyed by sha256(id) alone, so ids from different platforms must
 * never share a spelling: X and LinkedIn ids carry a prefix, YouTube's stay
 * bare because the list already holds them that way. Kinds stay 'video' and
 * 'channel'; on X and LinkedIn they mean a post and its author. The extension
 * mirrors this in extension/src/core/ids.js.
 *
 *   youtube   video   dQw4w9WgXcQ
 *             channel UC... (24) or @handle
 *   x         video   x:<post rest_id>
 *             channel x:u:<user rest_id>, or x:@handle as an alias of it
 *   linkedin  video   li:<base64url(sha256("urn:li:activity:<id>"))>, the hash
 *                     LinkedIn itself puts on the post (RESEARCH.md section 20)
 *             channel li:in:<slug>, li:company:<slug> or li:showcase:<slug>
 */
const ID_SHAPES = {
  youtube: { video: /^[\w-]{11}$/, channel: /^(@[\w.-]{1,48}|UC[\w-]{22})$/ },
  x: { video: /^x:\d{1,20}$/, channel: /^x:(u:\d{1,20}|@[a-z0-9_]{1,15})$/ },
  linkedin: {
    video: /^li:[A-Za-z0-9_-]{43}$/,
    channel: /^li:(in|company|showcase):[a-z0-9%_-]{2,100}$/,
  },
};

export function platformOf(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('x:')) return 'x';
  if (id.startsWith('li:')) return 'linkedin';
  return 'youtube';
}

export function isValidId(id, kind) {
  if (typeof id !== 'string' || !id.length || id.length > MAX_ID_LEN) return false;
  // Own keys only: a kind of 'constructor' must be a 400, not a thrown 500.
  const shapes = ID_SHAPES[platformOf(id)];
  return Object.hasOwn(shapes, kind ?? '') && shapes[kind].test(id);
}

/** A tally claim we are willing to record. Integers, sane, over threshold. */
export function isValidTally(ai, total, platform = 'youtube') {
  const rule = Object.hasOwn(TALLY_RULES, platform ?? '') ? TALLY_RULES[platform] : null;
  if (!rule) return false;
  if (!Number.isInteger(ai) || !Number.isInteger(total)) return false;
  if (total < rule.minSamples || total > rule.maxSamples) return false;
  if (ai < 0 || ai > total) return false;
  return ai / total >= rule.threshold;
}

/** A writing claim we are willing to record. Integers, sane, over threshold. */
export function isValidWriting(ai, total, platform) {
  const rule = Object.hasOwn(WRITING_RULES, platform ?? '') ? WRITING_RULES[platform] : null;
  if (!rule) return false;
  if (!Number.isInteger(ai) || !Number.isInteger(total)) return false;
  if (total < rule.minSamples || total > rule.maxSamples) return false;
  if (ai < 0 || ai > total) return false;
  return ai / total >= rule.threshold;
}

/**
 * What the list says about an entry, or null to keep it in mind unserved.
 * `evidence` tells clients what backs a served entry: 'disclosure' (clients
 * measured the channel's own AI labels), 'writing' (the writing check read
 * this author's posts as AI-written), 'vote' (people's clicks), or 'review'
 * (a maintainer checked it and nothing was measured).
 *
 * The order is the order of strength. A label the platform itself published
 * outranks a model's reading of the words, which outranks a click.
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

  // Weaker than a tally, so it never publishes in 'votes' mode the way a
  // measurement does: only with review off entirely, and only while nobody
  // has pushed back. Absent columns read as zero, so an older caller's SELECT
  // simply never reaches here.
  if (
    (row.writings ?? 0) >= MIN_WRITINGS &&
    isValidWriting(row.writing_ai, row.writing_total, row.platform) &&
    score > -MIN_VOTES
  ) {
    return { slop: true, evidence: 'writing' };
  }

  if (score >= MIN_VOTES) return { slop: true, evidence: 'vote' };
  if (score <= -MIN_VOTES) return { slop: false, evidence: 'vote' };
  return null;
}

/**
 * The public counts behind /api/v1/stats. A channel can be stored twice, as
 * @handle and as UC id (applyToTwins in admin.js, and the crawler), so its
 * rows count once wherever the handle's UC id is known (`ucid`, read from the
 * row's meta). Of two spellings, one with a review stands for both.
 */
export function countStats(rows, mode = 'all') {
  const channels = new Map();
  const others = [];
  for (const r of rows) {
    if (r.kind !== 'channel') {
      others.push(r);
      continue;
    }
    const key = r.id.startsWith('UC') ? r.id : r.ucid || r.id;
    const seen = channels.get(key);
    if (!seen || (seen.review == null && r.review != null)) channels.set(key, r);
  }

  const out = { mode, entries: 0, pending: 0, reviewed: 0, videos: 0, channels: 0, channelsByDisclosure: 0 };
  for (const r of [...others, ...channels.values()]) {
    out.entries += 1;
    if (r.review === 'slop') out.reviewed += 1;
    const d = decide(r, mode);
    // Kept in mind, waiting for review or more people. A rejection is not waiting.
    if (!d && r.review !== 'clean') out.pending += 1;
    if (!d?.slop) continue;
    if (r.kind === 'video') out.videos += 1;
    else {
      out.channels += 1;
      if (d.evidence === 'disclosure') out.channelsByDisclosure += 1;
    }
  }
  return out;
}

/**
 * A pasted YouTube link or bare id, as {id, kind}, or null. Accepts watch,
 * youtu.be, Shorts, embed and live links, /channel/UC... and /@handle.
 */
export function parseYouTubeInput(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 500) return null;
  // 'x:123' is a valid id too, but not a YouTube one.
  const yt = (id, kind) => platformOf(id) === 'youtube' && isValidId(id, kind);
  if (yt(s, 'channel')) return { id: s, kind: 'channel' };
  if (yt(s, 'video')) return { id: s, kind: 'video' };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  const video = (id) => (yt(id, 'video') ? { id, kind: 'video' } : null);

  if (host === 'youtu.be') return video(parts[0]);
  if (host !== 'youtube.com') return null;
  if (parts[0] === 'watch') return video(url.searchParams.get('v'));
  if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) return video(parts[1]);
  if (parts[0] === 'channel') return yt(parts[1], 'channel') ? { id: parts[1], kind: 'channel' } : null;
  if (parts[0]?.startsWith('@')) {
    let handle;
    try {
      handle = decodeURIComponent(parts[0]);
    } catch {
      return null;
    }
    return yt(handle, 'channel') ? { id: handle, kind: 'channel' } : null;
  }
  return null;
}

/**
 * The list id of a LinkedIn post: the same hash LinkedIn puts on the post in
 * the page (RESEARCH.md section 20), so a pasted link and a client agree.
 */
export async function linkedinPostId(activityId) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`urn:li:activity:${activityId}`)
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return `li:${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

const X_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com']);
/** First path segments on x.com that are pages, not handles. */
const X_PAGES = new Set([
  'home', 'explore', 'search', 'i', 'settings', 'notifications', 'messages', 'compose',
  'hashtag', 'login', 'logout', 'signup', 'intent', 'share', 'tos', 'privacy',
]);

function parseXPath(parts) {
  const post = (n) => {
    const id = `x:${n}`;
    return isValidId(id, 'video') ? { id, kind: 'video', platform: 'x' } : null;
  };
  const account = (id) => (isValidId(id, 'channel') ? { id, kind: 'channel', platform: 'x' } : null);
  if (parts[0] === 'i') {
    if (parts[1] === 'status') return post(parts[2]);
    if (parts[1] === 'web' && parts[2] === 'status') return post(parts[3]);
    if (parts[1] === 'user') return account(`x:u:${parts[2]}`);
    return null;
  }
  if (!parts[0] || X_PAGES.has(parts[0].toLowerCase())) return null;
  if (parts[1] === 'status') return post(parts[2]);
  // Handles are case-insensitive on X; one spelling keeps votes together.
  return account(`x:@${parts[0].toLowerCase()}`);
}

async function parseLinkedInPath(parts) {
  if (['in', 'company', 'showcase'].includes(parts[0]) && parts[1]) {
    // The slug stays percent-encoded, as the page's own links carry it.
    const id = `li:${parts[0]}:${parts[1].toLowerCase()}`;
    return isValidId(id, 'channel') ? { id, kind: 'channel', platform: 'linkedin' } : null;
  }
  let activity = null;
  if (parts[0] === 'feed' && parts[1] === 'update' && parts[2]) {
    try {
      activity = /^urn:li:activity:(\d{1,25})$/.exec(decodeURIComponent(parts[2]))?.[1] ?? null;
    } catch {
      return null;
    }
  } else if (parts[0] === 'posts' && parts[1]) {
    activity = /-activity-(\d{1,25})-/.exec(parts[1])?.[1] ?? null;
  }
  return activity ? { id: await linkedinPostId(activity), kind: 'video', platform: 'linkedin' } : null;
}

/**
 * A pasted link or id from any platform, as {id, kind, platform}, or null.
 * YouTube input goes through parseYouTubeInput. Async because a LinkedIn post
 * link has to be hashed into the id clients see.
 */
export async function parseInput(raw) {
  const yt = parseYouTubeInput(raw);
  if (yt) return { ...yt, platform: 'youtube' };
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.length > 500) return null;

  // A bare id in its own spelling. Handles and slugs are case-insensitive.
  if (/^(x:@|li:(in|company|showcase):)/i.test(s)) s = s.toLowerCase();
  if (/^(x|li):/.test(s)) {
    for (const kind of ['video', 'channel']) {
      if (isValidId(s, kind)) return { id: s, kind, platform: platformOf(s) };
    }
    return null;
  }
  const urn = /^urn:li:activity:(\d{1,25})$/.exec(s);
  if (urn) return { id: await linkedinPostId(urn[1]), kind: 'video', platform: 'linkedin' };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  if (X_HOSTS.has(host)) return parseXPath(parts);
  if (/^([a-z]{2}\.)?linkedin\.com$/.test(host)) return parseLinkedInPath(parts);
  return null;
}

/* --------------------------------------------------------------- feedback */

/**
 * 'uninstall' comes from killslop.app/uninstall rather than from the
 * extension, which by then is gone. It shares this endpoint because it is the
 * same shape of message and belongs in the same inbox.
 */
export const FEEDBACK_CATEGORIES = ['bug', 'wrong', 'idea', 'other', 'uninstall'];
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

/* --------------------------------------------------------------- waitlist */

/** Sign-ups one network may make in 24 hours. */
export const WAITLIST_PER_DAY = 10;
/** The ?from=<slug> a launch link of ours may carry, and nothing else. */
const WAITLIST_SOURCE = /^[a-z0-9-]{1,24}$/;

/**
 * A waiting-list sign-up, trimmed and checked, or {error}. Unlike feedback the
 * address is required, since it is the whole row, and it is lowercased so that
 * one person who signs up twice is one row rather than two.
 *
 * `source` is kept only when it matches a slug we could have written into our
 * own launch links. Anything else is dropped rather than refused: a mangled
 * campaign tag is not a reason to lose the sign-up.
 */
export function cleanWaitlist(body) {
  if (!body || typeof body !== 'object') return { error: 'bad body' };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) return { error: 'bad email' };

  const source = typeof body.source === 'string' ? body.source.trim().toLowerCase() : '';
  return { email, source: WAITLIST_SOURCE.test(source) ? source : null };
}
