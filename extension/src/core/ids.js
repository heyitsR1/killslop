/**
 * Ids across platforms. The list is keyed by sha256(id), so ids from different
 * platforms must never share a spelling: X and LinkedIn ids carry a prefix,
 * YouTube's stay bare because the list already holds them that way. Kinds stay
 * 'video' and 'channel'; on X and LinkedIn they mean a post and its author.
 *
 * Mirrors isValidId() and platformOf() in worker/src/policy.js; keep the two
 * in step (test/ids.test.mjs checks they agree).
 *
 *   youtube   video   dQw4w9WgXcQ
 *             channel UC... (24) or @handle
 *   x         video   x:<post rest_id>
 *             channel x:u:<user rest_id>, or x:@handle as an alias of it
 *   linkedin  video   li:<base64url(sha256("urn:li:activity:<id>"))>, the hash
 *                     LinkedIn itself puts on the post (RESEARCH.md section 20)
 *             channel li:in:<slug>, li:company:<slug> or li:showcase:<slug>
 */

const SHAPES = {
  youtube: { video: /^[\w-]{11}$/, channel: /^(@[\w.-]{1,48}|UC[\w-]{22})$/ },
  x: { video: /^x:\d{1,20}$/, channel: /^x:(u:\d{1,20}|@[a-z0-9_]{1,15})$/ },
  linkedin: {
    video: /^li:[A-Za-z0-9_-]{43}$/,
    channel: /^li:(in|company|showcase):[a-z0-9%_-]{2,100}$/,
  },
};

export const MAX_ID_LEN = 128;

export function platformOf(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith('x:')) return 'x';
  if (id.startsWith('li:')) return 'linkedin';
  return 'youtube';
}

export function isValidId(id, kind) {
  if (typeof id !== 'string' || !id.length || id.length > MAX_ID_LEN) return false;
  // Own keys only: a kind of 'constructor' must fail, not throw.
  const shapes = SHAPES[platformOf(id)];
  return Object.hasOwn(shapes, kind ?? '') && shapes[kind].test(id);
}

/**
 * Channel inference per platform. YouTube's numbers are the user's settings
 * (defaults from RESEARCH.md section 7). X's come from section 15: AI
 * accounts label 14-68% of their media, ordinary ones 0%, so the bar is far
 * lower than YouTube's. LinkedIn has no label to count (section 22).
 */
export const CHANNEL_RULES = {
  x: { minSamples: 8, threshold: 0.25 },
};

export function channelRule(platform, settings) {
  if (platform === 'youtube') {
    return { minSamples: settings.channelMinSamples, threshold: settings.channelThreshold };
  }
  return CHANNEL_RULES[platform] ?? null;
}
