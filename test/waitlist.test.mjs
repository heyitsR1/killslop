/** The Chrome Web Store waiting list: what it accepts, and what it stores. */

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { WAITLIST_PER_DAY, cleanWaitlist } from '../worker/src/policy.js';

const ORIGIN = 'https://api.killslop.example';

/**
 * Just enough D1 for this endpoint: the per-network count and the insert.
 * `rows` is the table, so a test can seed it and then read what happened.
 */
function fakeDb(rows = []) {
  return {
    rows,
    prepare(sql) {
      const stmt = {
        args: [],
        bind(...args) {
          stmt.args = args;
          return stmt;
        },
        async first() {
          const [netkey, since] = stmt.args;
          return { n: rows.filter((r) => r.netkey === netkey && r.created > since).length };
        },
        async run() {
          const [email, created, source, netkey] = stmt.args;
          // ON CONFLICT(email) DO NOTHING: the address is the primary key.
          if (!/INSERT INTO waitlist/.test(sql)) throw new Error(`unexpected statement: ${sql}`);
          if (!rows.some((r) => r.email === email)) rows.push({ email, created, source, netkey });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
}

const signUp = (body, env, headers = {}) =>
  worker.fetch(
    new Request(`${ORIGIN}/api/v1/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env
  );

/* ------------------------------------------------------------- validation */

test('an address is trimmed and lowercased, so one person is one row', () => {
  assert.deepEqual(cleanWaitlist({ email: '  Someone@Example.COM ' }), {
    email: 'someone@example.com',
    source: null,
  });
});

test('the address is required, unlike the one on feedback', () => {
  for (const email of [undefined, null, '', '   ', 42, 'not an email', 'a@b', 'a@b.co<script>']) {
    assert.equal(cleanWaitlist({ email }).error, 'bad email', String(email));
  }
  assert.equal(cleanWaitlist({ email: `${'x'.repeat(250)}@example.com` }).error, 'bad email', 'too long');
  assert.equal(cleanWaitlist(null).error, 'bad body');
});

test('a launch link may name itself, and anything else is dropped not refused', () => {
  assert.equal(cleanWaitlist({ email: 'a@b.co', source: 'launch-x' }).source, 'launch-x');
  assert.equal(cleanWaitlist({ email: 'a@b.co', source: ' YouTube ' }).source, 'youtube');
  for (const source of ['a b', 'x'.repeat(25), '<script>', 42, null, '']) {
    const clean = cleanWaitlist({ email: 'a@b.co', source });
    assert.equal(clean.source, null, String(source));
    assert.equal(clean.email, 'a@b.co', 'a mangled tag still keeps the sign-up');
  }
});

/* --------------------------------------------------------------- endpoint */

test('a sign-up is stored once, however many times it is sent', async () => {
  const db = fakeDb();
  const env = { DB: db };

  const first = await signUp({ email: 'Reader@Example.com', source: 'x' }, env);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true });

  // Same answer the second time: this must not become a way to ask whether an
  // address is already on the list.
  const again = await signUp({ email: 'reader@example.com' }, env);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true });

  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].email, 'reader@example.com');
  assert.equal(db.rows[0].source, 'x');
  assert.match(db.rows[0].netkey, /^[0-9a-f]{64}$/, 'the network is hashed, never stored in the clear');
});

test('a bad address is refused before the database is touched', async () => {
  const db = fakeDb();
  for (const body of [{ email: 'nope' }, { email: '' }, {}, 'not json']) {
    const res = await signUp(body, { DB: db });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(db.rows.length, 0);
});

test('one network cannot fill the list on its own', async () => {
  const db = fakeDb();
  const env = { DB: db };
  const from = { 'cf-connecting-ip': '203.0.113.9' };

  for (let i = 0; i < WAITLIST_PER_DAY; i++) {
    const res = await signUp({ email: `person${i}@example.com` }, env, from);
    assert.equal(res.status, 200, `sign-up ${i}`);
  }
  const over = await signUp({ email: 'one-too-many@example.com' }, env, from);
  assert.equal(over.status, 429);
  assert.equal(over.headers.get('retry-after'), '3600');
  assert.equal(db.rows.length, WAITLIST_PER_DAY);

  // A different network has its own budget.
  const elsewhere = await signUp({ email: 'elsewhere@example.com' }, env, {
    'cf-connecting-ip': '198.51.100.7',
  });
  assert.equal(elsewhere.status, 200);
});

test('the limiter is spent before the address is even read', async () => {
  const env = { DB: fakeDb(), RL_WAITLIST: { limit: async () => ({ success: false }) } };
  const res = await signUp({ email: 'reader@example.com' }, env);
  assert.equal(res.status, 429);
  assert.equal(env.DB.rows.length, 0);
});

test('the list is write-only from outside: there is no way to read it back', async () => {
  const env = { DB: fakeDb([{ email: 'reader@example.com', created: 1, source: null, netkey: 'k' }]) };
  for (const path of ['/api/v1/waitlist', '/api/v1/waitlist/export', '/api/v1/export/waitlist.json']) {
    const res = await worker.fetch(new Request(ORIGIN + path), env);
    assert.equal(res.status, 404, path);
    const body = await res.text();
    assert.ok(!body.includes('reader@example.com'), path);
  }
});
