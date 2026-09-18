/**
 * Community list client.
 *
 * Privacy model, lifted from SponsorBlock because it is the right one:
 * we never send the server a video id we are asking about. We send the first
 * 4 hex characters of sha256(id) and the server returns every entry in that
 * bucket; the client picks its own out of the pile locally.
 *
 * 4 hex chars = 65,536 buckets. A bucket hit tells the server "this user looked
 * at one of ~N videos", never which. Reports (write path) do send the full id —
 * they have to — but those are the handful of things the user deliberately
 * clicked, not their browsing history.
 */

import { platformOf } from './ids.js';

const API_BASE = 'https://api.killslop.app';
const PREFIX_LEN = 4;

/** Buckets we've already fetched this session: prefix -> Map(hash -> entry) */
const bucketCache = new Map();

let installIdPromise = null;

/**
 * A random id for this install, sent with every vote so the server can count
 * distinct people. The server only ever stores it hashed together with the
 * entry being voted on, so it cannot link your votes on different videos.
 */
function installId() {
  installIdPromise ??= (async () => {
    const { voterId } = await chrome.storage.local.get('voterId');
    if (voterId) return voterId;
    const fresh = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    await chrome.storage.local.set({ voterId: fresh });
    return fresh;
  })();
  return installIdPromise;
}

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchBucket(prefix) {
  if (bucketCache.has(prefix)) return bucketCache.get(prefix);
  const pending = (async () => {
    const res = await fetch(`${API_BASE}/api/v1/bucket/${prefix}`, {
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`bucket ${prefix}: ${res.status}`);
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
 * Look up many ids at once. Returns Map(id -> {slop:boolean, score:number}).
 * Ids sharing a prefix cost one request between them.
 */
export async function lookup(ids) {
  const out = new Map();
  if (!ids.length) return out;

  const hashes = await Promise.all(ids.map(sha256Hex));
  const byPrefix = new Map();
  hashes.forEach((hash, i) => {
    const prefix = hash.slice(0, PREFIX_LEN);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push({ id: ids[i], hash });
  });

  await Promise.all(
    [...byPrefix.entries()].map(async ([prefix, members]) => {
      let bucket;
      try {
        bucket = await fetchBucket(prefix);
      } catch {
        return; // offline or API down — silently fall through to local tiers
      }
      for (const { id, hash } of members) {
        const entry = bucket.get(hash);
        if (entry) {
          out.set(id, {
            slop: entry.slop,
            score: entry.score,
            kind: entry.kind,
            // 'disclosure' = other clients measured this channel's own AI labels;
            // 'vote' = human opinion. Older servers omit it: treat as opinion.
            evidence: entry.evidence === 'disclosure' ? 'disclosure' : 'vote',
          });
        }
      }
    })
  );
  return out;
}

/**
 * Submit a report. `kind` is 'video' or 'channel', `slop` is the user's claim.
 * Fire-and-forget: a failed report must never block the UI.
 */
export async function report({ id, kind, slop, platform = platformOf(id), evidence = null }) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/report`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, kind, slop, platform, evidence, voter: await installId() }),
    });
    if (!res.ok) return { ok: false, status: res.status };
    // Our own vote invalidates any cached bucket containing it.
    const hash = await sha256Hex(id);
    bucketCache.delete(hash.slice(0, PREFIX_LEN));
    return { ok: true };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Take back our vote on `id`: the other half of an undo button. Fire-and-forget. */
export async function retract({ id, kind }) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/retract`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, kind, voter: await installId() }),
    });
    if (!res.ok) return { ok: false, status: res.status };
    bucketCache.delete((await sha256Hex(id)).slice(0, PREFIX_LEN));
    return { ok: true };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * Share a measurement: this channel crossed the disclosure-sampling threshold
 * in our own cache. Sent once per spelling (UC id and handle) so a tile that
 * only shows a handle still finds it. Fire-and-forget.
 */
export async function tally({ ids, ai, total, platform = 'youtube' }) {
  const results = [];
  for (const id of ids) {
    try {
      const res = await fetch(`${API_BASE}/api/v1/tally`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, ai, total, platform, voter: await installId() }),
      });
      results.push(res.ok);
      if (res.ok) bucketCache.delete((await sha256Hex(id)).slice(0, PREFIX_LEN));
    } catch {
      results.push(false);
    }
  }
  return { ok: results.some(Boolean) };
}

/**
 * A message for the maintainer, with an optional email for a reply. Not
 * fire-and-forget like reports: the feedback page shows whether it arrived,
 * so the user can try again without losing what they wrote.
 */
export async function feedback({ category, message, email, version }) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/feedback`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category, message, email, version }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, error: body.error || null };
  } catch {
    return { ok: false, status: 0, error: 'offline' };
  }
}

export function clearBucketCache() {
  bucketCache.clear();
}

export const __testing = { PREFIX_LEN, API_BASE };
