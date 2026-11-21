/**
 * The X AI-reply spammer list (worker/src/spamlist.js has the sources and the
 * flags). Downloaded whole and matched here, so looking an account up tells
 * nobody which account it was: the same privacy as the hash buckets, better.
 *
 * Kept in chrome.storage.local so a fresh service worker has it at once, and
 * refreshed in the background every REFRESH_MS. A failed refresh keeps the
 * old copy; an empty or broken download never replaces a good one.
 */

const URL_ = 'https://api.killslop.app/api/v1/x-spam.json';
const KEY = 'xSpamList';
const REFRESH_MS = 6 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000;

/**
 * Flags that hide by default. 'b' (a block with no evidence on record, which
 * since 2026-11-22 includes levelsio's 'likely', served as 'bn') is opt-in.
 * 'l' is no longer served but still read, for lists cached before then.
 */
const DEFAULT_FLAGS = /[clvk]/;

let index = null; // { byId: Map, byHandle: Map, meta }
let loading = null;
let refreshing = null;
let lastAttempt = 0;

function build(data) {
  const byId = new Map();
  const byHandle = new Map();
  const rows = [];
  for (const row of data?.accounts || []) {
    if (!Array.isArray(row)) continue;
    const [id, handle, flags] = row;
    if (typeof flags !== 'string' || !flags || (!id && !handle)) continue;
    if (id) byId.set(String(id), flags);
    if (handle) byHandle.set(String(handle).toLowerCase(), flags);
    rows.push(flags);
  }
  return { byId, byHandle, rows, meta: { generated: data?.generated ?? 0, sources: data?.sources ?? {} } };
}

async function load() {
  if (index) return index;
  loading ??= chrome.storage.local
    .get(KEY)
    .then((r) => {
      index = build(r[KEY]?.data);
      index.fetched = r[KEY]?.fetched ?? 0;
      return index;
    })
    .catch(() => (index = { ...build(null), fetched: 0 }));
  return loading;
}

/** Fetch a fresh copy if ours is old. Never throws; never blocks a lookup. */
export function refresh({ force = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const idx = await load();
    const now = Date.now();
    if (!force && now - (idx.fetched || 0) < REFRESH_MS) return idx;
    if (!force && now - lastAttempt < RETRY_MS) return idx;
    lastAttempt = now;
    try {
      const res = await fetch(URL_, { credentials: 'omit', headers: { accept: 'application/json' } });
      if (!res.ok) return idx;
      const data = await res.json();
      if (!Array.isArray(data?.accounts) || data.accounts.length === 0) return idx;
      index = build(data);
      index.fetched = now;
      await chrome.storage.local.set({ [KEY]: { fetched: now, data } });
      return index;
    } catch {
      return idx;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Flags for one X channel id ('x:u:<id>' or 'x:@handle'), or null. */
function flagsFor(idx, channelId) {
  if (typeof channelId !== 'string') return null;
  if (channelId.startsWith('x:u:')) return idx.byId.get(channelId.slice(4)) ?? null;
  if (channelId.startsWith('x:@')) return idx.byHandle.get(channelId.slice(3)) ?? null;
  return null;
}

/** Whether these flags hide under the user's settings. */
export function hides(flags, settings) {
  if (!flags) return false;
  if (DEFAULT_FLAGS.test(flags)) return true;
  return Boolean(settings?.spamListUnreviewed && flags.includes('b'));
}

/**
 * Match many channel spellings at once. Returns Map(channelId -> flags) for
 * those that hide under `settings`. Starts a background refresh as a side
 * effect, so the list stays current without an alarm permission.
 */
export async function match(channelIds, settings) {
  const idx = await load();
  refresh();
  const out = new Map();
  for (const id of channelIds) {
    const flags = flagsFor(idx, id);
    if (hides(flags, settings)) out.set(id, flags);
  }
  return out;
}

/** For the popup: how many accounts the list would hide now, and its age. */
export async function summary(settings) {
  const idx = await refresh();
  let count = 0;
  let unreviewed = 0;
  for (const flags of idx.rows) {
    if (hides(flags, settings)) count++;
    else if (flags.includes('b')) unreviewed++;
  }
  return { count, unreviewed, fetched: idx.fetched || 0, sources: idx.meta.sources };
}

export const __testing = { build, flagsFor, hides };
