/**
 * Writing check client.
 *
 * Same privacy model as the community list, one step further. A post's text is
 * looked up by the first 4 hex characters of sha256(text): the server returns
 * every answer in that bucket and we find our own locally, so a post anyone
 * has had checked before is answered with no text sent at all.
 *
 * Only on a miss, and only for a post the local gate already found suspicious
 * (content/slopsigns.js), is the text itself sent to be checked. The server
 * stores the hash and the answer and drops the text (worker/schema.sql), so
 * there is nothing there to read back into anyone's feed.
 *
 * Off unless the user turns it on. Nothing in this file runs otherwise.
 */

import { sha256Hex } from './community.js';

const API_BASE = 'https://api.killslop.app';
const PREFIX_LEN = 4;

/**
 * What the model's 0-4 score has to reach before a post is hidden.
 *
 * Measured 2026-09-18 over 50 labelled posts, 15 slop and 35 human, 18 of the
 * human half written to be hard: non-native English in several registers,
 * polished technical prose, genuine announcements, and human writing that uses
 * the same contrast structure the rubric looks for (RESEARCH.md section 23).
 *
 * The two classes separate cleanly, which is what picks the number:
 *
 *   highest human   1.75
 *   lowest slop     2.97
 *
 * 2.5 sits in that gap, with 0.75 of headroom above the worst human case, and
 * scores 1.000 precision and 1.000 recall on the set. A higher bar is not a
 * safer one: 3.0 falls inside the bottom of the slop cluster and loses the
 * LinkedIn humblebrag and announcement, which are the commonest shapes there.
 * 2.0 also scores perfectly but leaves only 0.25 of headroom, which is too
 * little to carry off this corpus.
 *
 * Precision is the number that protects people, so if this is ever moved,
 * move it up. Recall costs a post nobody reads; precision costs a person.
 *
 * Author-level writing evidence is not gathered here. It comes from the
 * crawler's own measurement (scripts/), so that deciding a person writes with
 * a machine never rests on what happened to cross one user's feed.
 */
export const HIDE_AT = 2.5;

/** Answers already fetched this session: prefix -> Map(hash -> answer) */
const bucketCache = new Map();

async function fetchBucket(prefix) {
  if (bucketCache.has(prefix)) return bucketCache.get(prefix);
  const pending = (async () => {
    const res = await fetch(`${API_BASE}/api/v1/text/${prefix}`, {
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`text ${prefix}: ${res.status}`);
    const body = await res.json();
    const map = new Map();
    for (const entry of body.entries || []) map.set(entry.hash, entry);
    return map;
  })();
  bucketCache.set(prefix, pending);
  try {
    const map = await pending;
    bucketCache.set(prefix, map);
    return map;
  } catch (err) {
    bucketCache.delete(prefix);
    throw err;
  }
}

/**
 * Answers for texts already known to the server. Texts sharing a prefix cost
 * one request between them, and no text is sent.
 *
 * @param {string[]} texts  normalized by KillSlopSigns.normalizeText
 * @returns {Promise<Map<string, {score:number, signal:string|null}>>} keyed by text
 */
export async function lookupTexts(texts) {
  const out = new Map();
  if (!texts.length) return out;

  const hashes = await Promise.all(texts.map(sha256Hex));
  const byPrefix = new Map();
  hashes.forEach((hash, i) => {
    const prefix = hash.slice(0, PREFIX_LEN);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push({ text: texts[i], hash });
  });

  await Promise.all(
    [...byPrefix.entries()].map(async ([prefix, members]) => {
      let bucket;
      try {
        bucket = await fetchBucket(prefix);
      } catch {
        return; // offline or API down: the post is simply left undecided
      }
      for (const { text, hash } of members) {
        const entry = bucket.get(hash);
        if (entry) out.set(text, { score: entry.score, signal: entry.signal ?? null });
      }
    })
  );
  return out;
}

/**
 * Have one post checked. Only reached for a post the local gate found
 * suspicious and that nobody has had checked before.
 *
 * Returns null on anything that is not a clean answer: the check is the last
 * tier, so a failure leaves the post undecided rather than accused.
 */
export async function classifyText(text, platform) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/writing`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, platform }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (typeof body?.score !== 'number') return null;
    // Our own answer joins the bucket we may already hold.
    const hash = await sha256Hex(text);
    bucketCache.get(hash.slice(0, PREFIX_LEN))?.set?.(hash, body);
    return { score: body.score, signal: body.signal ?? null };
  } catch {
    return null;
  }
}

export function clearTextCache() {
  bucketCache.clear();
}

export const __testing = { PREFIX_LEN, API_BASE };
