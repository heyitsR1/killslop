/** Appeals (worker/src/appeal.js): the lookup and what a post writes. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getAppeal, postAppeal } from '../worker/src/appeal.js';

const SERVED = { accounts: [['1974078572697620480', 'aayanships', 'bn'], ['781293', 'martinvars', 'c']] };
const LEVELS = {
  accounts: [
    { id: '1974078572697620480', username: 'AayanShips', levelsio: 'likely', account_created: '2025-10', evidence: [] },
    { id: '781293', username: 'MartinVars', levelsio: 'confirmed', evidence: [{ date: '2026-11-01', their_reply: 'Great insight!' }] },
  ],
};

globalThis.caches = {
  default: {
    match: async (key) => (String(key).includes('/fresh/') ? new Response(JSON.stringify(SERVED)) : undefined),
    put: async () => {},
  },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) =>
  String(url).includes('blockedforaireply') ? Response.json(LEVELS) : realFetch(url, init);

function fakeDb({ clean = [] } = {}) {
  const writes = [];
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a),
    first: async () => ({ n: 0 }),
    all: async () => ({ results: [] }),
  });
  return {
    writes,
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      if (/^SELECT review/.test(list[0].sql)) {
        return list.map(() => ({ results: clean.length ? [{ review: 'clean' }] : [] }));
      }
      writes.push(...list);
      return [];
    },
  };
}

const ctx = { waitUntil() {} };
const get = (handle, env) =>
  getAppeal(new Request('https://api.example/api/v1/appeal'), env, ctx, new URL(`https://x/?handle=${handle}`));
const post = (body, env) =>
  postAppeal(new Request('https://api.example/api/v1/appeal', { method: 'POST', body: JSON.stringify(body) }), env, ctx);

test('the lookup says what each list holds and whether KillSlop hides it', async () => {
  const a = await (await get('@AayanShips', { DB: fakeDb() })).json();
  assert.equal(a.listed, true);
  assert.equal(a.levelsio.status, 'likely');
  assert.equal(a.levelsio.appeal, 'https://blockedforaireply.levels.io/#u-1974078572697620480');
  assert.equal(a.hiddenByDefault, false);
  assert.equal(a.optInOnly, true);

  const m = await (await get('martinvars', { DB: fakeDb() })).json();
  assert.equal(m.hiddenByDefault, true);
  assert.equal(m.levelsio.evidence[0].text, 'Great insight!');

  const n = await (await get('nobody_here', { DB: fakeDb() })).json();
  assert.equal(n.listed, false);
  assert.equal((await get('not a handle!', { DB: fakeDb() })).status, 400);
});

test('an appeal queues the account by user id and leaves a note in the inbox', async () => {
  const db = fakeDb();
  const res = await (await post({ handle: 'MartinVars', note: 'I write my own replies', email: 'm@example.com' }, { DB: db })).json();
  assert.equal(res.ok, true);
  assert.equal(res.levelsio, 'https://blockedforaireply.levels.io/#u-781293');
  const [entry, inbox] = db.writes;
  assert.match(entry.sql, /INSERT INTO entries/);
  assert.equal(entry.args[2], 'x:u:781293');
  assert.match(inbox.sql, /'appeal'/);
  assert.match(inbox.args[1], /x:u:781293/);
  assert.match(inbox.args[1], /I write my own replies/);
  assert.equal(inbox.args[2], 'm@example.com');
});

test('nothing is written for an account no list holds, or one already cleared', async () => {
  const db = fakeDb();
  assert.deepEqual(await (await post({ handle: 'nobody_here' }, { DB: db })).json(), { ok: true, listed: false });
  const cleared = fakeDb({ clean: ['x'] });
  assert.equal((await (await post({ handle: 'martinvars' }, { DB: cleared })).json()).cleared, true);
  assert.equal(db.writes.length + cleared.writes.length, 0);
  assert.equal((await post({ handle: 'martinvars', email: 'nope' }, { DB: db })).status, 400);
});
