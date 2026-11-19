/**
 * Local verdict cache (IndexedDB).
 *
 * A video's AI disclosure never changes in practice, so cached verdicts are
 * effectively permanent — that is what makes per-video probing affordable at
 * all. Channel tallies accumulate as we sample a channel's uploads.
 *
 * Stores:
 *   videos   { id, verdict, source, header, ts }
 *   channels { id, ai, total, ts }            — running tally for inference
 *   overrides{ id, kind:'video'|'channel', slop:boolean, ts, meta:{title, channel} }
 *                                             — the user's own word. Always wins.
 *                                               meta is for the "Your marks" list.
 *   aliases  { id:'@handle', ucid:'UC…', ts } — a handle seen on a tile mapped to
 *                                             the UC id the probe reported, so
 *                                             tallies keyed either way agree.
 */

const DB_NAME = 'killslop';
const DB_VERSION = 2;
const STORES = ['videos', 'channels', 'overrides', 'aliases'];
/**
 * The database's name before the project was renamed. A fresh install finds
 * nothing under it; an install that predates the rename has the user's marks
 * there, so they move over once and the old database is deleted.
 */
const LEGACY_DB_NAME = 'deslop';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let created = false;
    req.onupgradeneeded = (ev) => {
      created = ev.oldVersion === 0;
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(created ? adoptLegacy(req.result) : req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Copies the pre-rename database into a newly created one, then deletes it. */
async function adoptLegacy(db) {
  try {
    const known = await indexedDB.databases();
    if (!known.some((d) => d.name === LEGACY_DB_NAME)) return db;
    const old = await asPromise(indexedDB.open(LEGACY_DB_NAME));
    const names = STORES.filter((name) => old.objectStoreNames.contains(name));
    const rows = await Promise.all(
      names.map((name) => asPromise(old.transaction(name, 'readonly').objectStore(name).getAll()))
    );
    old.close();
    if (names.length) {
      await new Promise((resolve, reject) => {
        const t = db.transaction(names, 'readwrite');
        names.forEach((name, i) => {
          const store = t.objectStore(name);
          for (const row of rows[i]) store.put(row);
        });
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    }
    indexedDB.deleteDatabase(LEGACY_DB_NAME);
  } catch {
    // A failed copy costs some re-probing, never a wrong verdict: carry on.
  }
  return db;
}

function tx(storeName, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

const asPromise = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function getVideo(id) {
  return tx('videos', 'readonly', (s) => s.get(id));
}

export async function getVideos(ids) {
  const db = await open();
  const t = db.transaction('videos', 'readonly');
  const s = t.objectStore('videos');
  const rows = await Promise.all(ids.map((id) => asPromise(s.get(id))));
  const out = new Map();
  rows.forEach((row, i) => {
    if (row) out.set(ids[i], row);
  });
  return out;
}

export async function putVideo(id, verdict, source, header = null) {
  return tx('videos', 'readwrite', (s) => s.put({ id, verdict, source, header, ts: Date.now() }));
}

export async function getChannel(id) {
  return tx('channels', 'readonly', (s) => s.get(id));
}

export async function getChannels(ids) {
  const db = await open();
  const t = db.transaction('channels', 'readonly');
  const s = t.objectStore('channels');
  const rows = await Promise.all(ids.map((id) => asPromise(s.get(id))));
  const out = new Map();
  rows.forEach((row, i) => {
    if (row) out.set(ids[i], row);
  });
  return out;
}

/**
 * Fold one sampled video into a channel's tally.
 * Returns the updated record.
 */
export async function tallyChannel(channelId, isAI) {
  const db = await open();
  const t = db.transaction('channels', 'readwrite');
  const s = t.objectStore('channels');
  const existing = (await asPromise(s.get(channelId))) || { id: channelId, ai: 0, total: 0 };
  existing.ai += isAI ? 1 : 0;
  existing.total += 1;
  existing.ts = Date.now();
  s.put(existing);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(existing);
    t.onerror = () => reject(t.error);
  });
}

/** Remember that we already shared this channel's measurement. */
export async function markChannelShared(channelId) {
  const db = await open();
  const t = db.transaction('channels', 'readwrite');
  const s = t.objectStore('channels');
  const row = await asPromise(s.get(channelId));
  if (row) s.put({ ...row, shared: true });
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** Force a channel verdict wholesale (e.g. from the community list). */
export async function setChannelTally(channelId, ai, total, { fromCommunity = false } = {}) {
  return tx('channels', 'readwrite', (s) =>
    // A verdict learned from the list is not our measurement; never re-share it.
    s.put({ id: channelId, ai, total, ts: Date.now(), shared: fromCommunity || undefined })
  );
}

export async function getOverride(id) {
  return tx('overrides', 'readonly', (s) => s.get(id));
}

export async function getOverrides(ids) {
  const db = await open();
  const t = db.transaction('overrides', 'readonly');
  const s = t.objectStore('overrides');
  const rows = await Promise.all(ids.map((id) => asPromise(s.get(id))));
  const out = new Map();
  rows.forEach((row, i) => {
    if (row) out.set(ids[i], row);
  });
  return out;
}

export async function setOverride(id, kind, slop, meta = null) {
  return tx('overrides', 'readwrite', (s) => s.put({ id, kind, slop, ts: Date.now(), meta }));
}

/** Every override, newest first. */
export async function listOverrides() {
  const rows = await tx('overrides', 'readonly', (s) => s.getAll());
  return rows.sort((a, b) => b.ts - a.ts);
}

export async function clearOverride(id) {
  return tx('overrides', 'readwrite', (s) => s.delete(id));
}

/** Map handle -> ucid for every handle we have an alias for. */
export async function getAliases(handles) {
  const out = new Map();
  if (!handles.length) return out;
  const db = await open();
  const s = db.transaction('aliases', 'readonly').objectStore('aliases');
  const rows = await Promise.all(handles.map((h) => asPromise(s.get(h))));
  rows.forEach((row, i) => {
    if (row?.ucid) out.set(handles[i], row.ucid);
  });
  return out;
}

export async function setAlias(handle, ucid) {
  if (!handle || !ucid) return;
  return tx('aliases', 'readwrite', (s) => s.put({ id: handle, ucid, ts: Date.now() }));
}

export async function stats() {
  const db = await open();
  const count = (name) =>
    new Promise((resolve, reject) => {
      const req = db.transaction(name, 'readonly').objectStore(name).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const [videos, channels, overrides] = await Promise.all([
    count('videos'),
    count('channels'),
    count('overrides'),
  ]);
  return { videos, channels, overrides };
}

export async function clearAll() {
  const db = await open();
  await Promise.all(
    ['videos', 'channels', 'overrides', 'aliases'].map(
      (name) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(name, 'readwrite');
          t.objectStore(name).clear();
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        })
    )
  );
}
