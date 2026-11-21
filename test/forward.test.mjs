/** Passing X marks on to levelsio's report queue (worker/src/forward.js). */

import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardReports, REPORT_URL, FORWARD_DELAY_MS } from '../worker/src/forward.js';

const NOW = 1_800_000_000_000;

/** Just enough D1 for forward.js: one SELECT for due posts, INSERTs recorded. */
function fakeDb(rows) {
  const recorded = [];
  return {
    recorded,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            all: async () => {
              const [before, limit] = args;
              const due = rows.filter(
                (r) =>
                  r.up > r.down &&
                  r.review !== 'clean' &&
                  r.created < before &&
                  !recorded.some((x) => x.hash === r.hash)
              );
              return { results: due.slice(0, limit).map(({ hash, id }) => ({ hash, id })) };
            },
            first: async () => {
              assert.match(sql, /status = 'sent' AND url LIKE/);
              const prefix = args[0].replace('%', '');
              return recorded.some((x) => x.status === 'sent' && x.url?.startsWith(prefix)) ? { hit: 1 } : null;
            },
            run: async () => {
              assert.match(sql, /INSERT INTO forwards/);
              const [hash, id, url, status] = args;
              recorded.push({ hash, id, url, status });
            },
          };
        },
      };
    },
  };
}

const old = NOW - FORWARD_DELAY_MS - 1;
const row = (n, extra = {}) => ({ hash: `h${n}`, id: `x:${n}`, up: 1, down: 0, review: null, created: old, ...extra });

const TWEETS = {
  1: { user: { screen_name: 'growthbot', id_str: '11' }, in_reply_to_status_id_str: '9' },
  2: { user: { screen_name: 'listedbot', id_str: '22' }, in_reply_to_status_id_str: '9' },
  3: { user: { screen_name: 'poster', id_str: '33' } }, // not a reply
  5: { user: { screen_name: 'growthbot', id_str: '11' }, in_reply_to_status_id_str: '8' },
};

function fakeFetch({ report = () => ({ ok: true }), reportStatus = 200 } = {}) {
  const sent = [];
  const impl = async (url, init) => {
    if (String(url).startsWith(REPORT_URL)) {
      const body = JSON.parse(init.body);
      sent.push(body.tweet_url);
      return new Response(JSON.stringify(report(body)), { status: reportStatus });
    }
    const id = new URL(url).searchParams.get('id');
    const t = TWEETS[id];
    if (!t) return new Response('', { status: 404 });
    return Response.json({ __typename: 'Tweet', id_str: id, ...t });
  };
  return { impl, sent };
}

// The spam list, served from cache so no network is touched.
globalThis.caches = {
  default: {
    match: async (req) =>
      String(req.url ?? req).includes('/fresh/')
        ? new Response(JSON.stringify({ accounts: [['22', 'listedbot', 'c'], ['', 'clankonly', 'v']] }))
        : undefined,
    put: async () => {},
  },
};

const ctx = { waitUntil() {} };

test('off unless FORWARD_LEVELS is on', async () => {
  const db = fakeDb([row(1)]);
  assert.deepEqual(await forwardReports({ DB: db }, ctx, { now: NOW }), { off: true });
  assert.equal(db.recorded.length, 0);
});

test('a marked reply is sent once, as a clean x.com link; listed, non-reply, gone and same-account posts are not', async () => {
  const db = fakeDb([row(1), row(2), row(3), row(4), row(5)]);
  const f = fakeFetch();
  const env = { DB: db, FORWARD_LEVELS: 'on' };
  const r = await forwardReports(env, ctx, { now: NOW, fetchImpl: f.impl });
  assert.deepEqual(r, { sent: 1, skipped: 4, retry: 0 });
  assert.deepEqual(f.sent, ['https://x.com/growthbot/status/1']);
  assert.deepEqual(
    Object.fromEntries(db.recorded.map((x) => [x.id, x.status])),
    { 'x:1': 'sent', 'x:2': 'listed', 'x:3': 'not-reply', 'x:4': 'gone', 'x:5': 'account-sent' }
  );
  // A second run finds nothing left to do.
  await forwardReports(env, ctx, { now: NOW, fetchImpl: f.impl });
  assert.equal(f.sent.length, 1);
});

test('recent marks wait (Undo window), and rejected or outvoted posts never go', async () => {
  const db = fakeDb([row(1, { created: NOW - 1000 }), row(1, { hash: 'h1b', review: 'clean' }), row(1, { hash: 'h1c', up: 0 })]);
  const f = fakeFetch();
  await forwardReports({ DB: db, FORWARD_LEVELS: 'on' }, ctx, { now: NOW, fetchImpl: f.impl });
  assert.equal(f.sent.length, 0);
});

test('a busy server stops the run and leaves the post for next time; a refusal is recorded', async () => {
  const db = fakeDb([row(1)]);
  const env = { DB: db, FORWARD_LEVELS: 'on' };
  const busy = fakeFetch({ reportStatus: 429, report: () => ({ ok: false }) });
  assert.equal((await forwardReports(env, ctx, { now: NOW, fetchImpl: busy.impl })).retry, 1);
  assert.equal(db.recorded.length, 0);
  const no = fakeFetch({ reportStatus: 400, report: () => ({ ok: false, error: 'Already reported' }) });
  await forwardReports(env, ctx, { now: NOW, fetchImpl: no.impl });
  assert.equal(db.recorded[0].status, 'refused:Already reported');
});
