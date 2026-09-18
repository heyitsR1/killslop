/** The writing check: its evidence rank, its input validation, and its model call. */

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { askJev, __testing as jev } from '../worker/src/jev.js';
import { MIN_WRITINGS, WRITING_RULES, decide, isValidWriting } from '../worker/src/policy.js';

const ORIGIN = 'https://api.killslop.example';
// No DB binding: every assertion below must be answered before D1 is touched,
// which is the point. A route that reached the database would throw here.
const call = (path, init) => worker.fetch(new Request(ORIGIN + path, init), {});
const post = (path, body) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** An author whose checked posts read as AI-written, by two reporters. */
const read = (extra = {}) => ({
  up: 0,
  down: 0,
  tallies: 0,
  writings: MIN_WRITINGS,
  writing_ai: 4,
  writing_total: 6,
  platform: 'x',
  ...extra,
});

/* ------------------------------------------------------------ the evidence */

test('writing evidence is weaker than a measurement', () => {
  // A tally publishes in 'votes' mode; a model reading the words does not.
  assert.equal(decide(read(), 'votes'), null, "'votes' mode publishes measurements only");
  assert.deepEqual(decide(read(), 'off'), { slop: true, evidence: 'writing' });
});

test('writing evidence still waits for review while review is on', () => {
  assert.equal(decide(read(), 'all'), null);
  assert.equal(decide(read()), null, "'all' is the default");
});

test('one reporter is never enough, however the posts read', () => {
  assert.equal(decide(read({ writings: 1 }), 'off'), null);
  assert.equal(decide(read({ writings: 0 }), 'off'), null);
});

test('people pushing back outrank the writing check', () => {
  // Two disagreements are not enough to unseat it.
  assert.deepEqual(decide(read({ down: 2 }), 'off'), { slop: true, evidence: 'writing' });
  // Three are, and they do more than veto: the list then says "not slop" out
  // loud, so the author is cleared rather than merely left undecided.
  assert.deepEqual(decide(read({ down: 3 }), 'off'), { slop: false, evidence: 'vote' });
});

test("a maintainer's rejection outranks it in every mode", () => {
  for (const mode of ['all', 'votes', 'off']) {
    assert.equal(decide(read({ review: 'clean' }), mode), null, mode);
  }
});

test('the writing check never applies to YouTube', () => {
  // Guessing from titles and thumbnails was rejected in RESEARCH.md section 7.
  assert.equal(decide(read({ platform: 'youtube' }), 'off'), null);
  assert.equal(isValidWriting(6, 6, 'youtube'), false);
  assert.ok(!Object.hasOwn(WRITING_RULES, 'youtube'));
});

test('LinkedIn has writing evidence, which is the only signal it has', () => {
  assert.deepEqual(decide(read({ platform: 'linkedin', writing_ai: 3 }), 'off'), {
    slop: true,
    evidence: 'writing',
  });
});

test('a row from a caller that did not select the columns is simply undecided', () => {
  // decide() is called with several different SELECTs; a short one must not throw.
  assert.equal(decide({ up: 0, down: 0, tallies: 0 }, 'off'), null);
});

test('only writing claims that clear the bar are recorded', () => {
  assert.ok(isValidWriting(3, 6, 'x'), 'exactly half of the floor');
  assert.equal(isValidWriting(2, 6, 'x'), false, 'below the threshold');
  assert.equal(isValidWriting(4, 4, 'x'), false, 'below the sample floor');
  assert.equal(isValidWriting(7, 6, 'x'), false, 'more AI than samples');
  assert.equal(isValidWriting(1.5, 6, 'x'), false, 'non-integer');
  assert.equal(isValidWriting(9999, 9999, 'x'), false, 'implausibly large sample');
  assert.equal(isValidWriting(3, 6, '__proto__'), false, 'own keys only');
  assert.equal(isValidWriting(3, 6, undefined), false);
});

/* ----------------------------------------------------------- the endpoints */

test('the check refuses anything but X and LinkedIn', async () => {
  for (const platform of ['youtube', 'reddit', '', null, '__proto__']) {
    const res = await post('/api/v1/writing', { platform, text: 'x'.repeat(100) });
    assert.equal(res.status, 400, String(platform));
  }
});

test('the check refuses text it should not spend money on', async () => {
  const bad = [undefined, null, '', '   ', 42, 'x'.repeat(2001)];
  for (const text of bad) {
    const res = await post('/api/v1/writing', { platform: 'x', text });
    assert.equal(res.status, 400, JSON.stringify(text)?.slice(0, 20));
  }
  assert.equal((await call('/api/v1/writing', { method: 'POST', body: 'not json' })).status, 400);
});

test('the text bucket takes a 4-character prefix and nothing else', async () => {
  for (const prefix of ['abc', 'abcde', 'ABCD']) {
    const res = await call(`/api/v1/text/${prefix}`);
    assert.notEqual(res.status, 200, prefix);
  }
});

test('every platform has its own export, and nothing else does', async () => {
  // With no DB binding a routed export reaches for env.DB and throws, which is
  // how we tell "routed" from "not a route" without standing up a database.
  for (const path of [
    '/api/v1/export/youtube-channels.json',
    '/api/v1/export/x-accounts.json',
    '/api/v1/export/linkedin-authors.json',
  ]) {
    await assert.rejects(() => call(path), `${path} is not routed`);
  }
  // An unknown export is answered, not attempted.
  assert.equal((await call('/api/v1/export/reddit-users.json')).status, 404);
});

/* -------------------------------------------------------------- the model */

const withFetch = async (impl, run) => {
  const native = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = native;
  }
};

const answer = (score, choice = 'negative_parallelism') => ({
  model: 'jev-1.13.0',
  answers: {
    slop_level: { type: 'score', score, confidence: 0.9 },
    top_signal: { type: 'choice', choice, confidence: 0.6 },
  },
  usage: { input_tokens: 835 },
});

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

test('a clean answer becomes a score, a signal and a model', async () => {
  const got = await withFetch(
    async () => ok(answer(3.68)),
    () => askJev('some post', { TYPESAFE_API_KEY: 'k' })
  );
  assert.deepEqual(got, {
    score: 3.68,
    conf: 0.9,
    signal: 'negative_parallelism',
    model: 'jev-1.13.0',
    tokens: 835,
  });
});

test('the check is off without a key, and costs nothing', async () => {
  let called = false;
  const got = await withFetch(
    async () => {
      called = true;
      return ok(answer(4));
    },
    () => askJev('some post', {})
  );
  assert.equal(got, null);
  assert.equal(called, false, 'no key must mean no request');
});

test('an answer that is not a score is refused rather than trusted', async () => {
  const bad = [
    { model: 'jev-1.13.0', answers: {} },
    { model: 'jev-1.13.0', answers: { slop_level: { type: 'score', score: 9 } } },
    { model: 'jev-1.13.0', answers: { slop_level: { type: 'score', score: -1 } } },
    { model: 'jev-1.13.0', answers: { slop_level: { type: 'noul', noul: 0.9 } } },
    { model: 'jev-1.13.0', answers: { slop_level: { type: 'score', score: 'high' } } },
  ];
  for (const body of bad) {
    const got = await withFetch(
      async () => ok(body),
      () => askJev('some post', { TYPESAFE_API_KEY: 'k' })
    );
    assert.equal(got, null, JSON.stringify(body).slice(0, 50));
  }
});

test('a refusal is retried once, and only for the two codes worth retrying', async () => {
  let calls = 0;
  const got = await withFetch(
    async () => {
      calls += 1;
      return calls === 1 ? new Response('busy', { status: 429 }) : ok(answer(2.5));
    },
    () => askJev('some post', { TYPESAFE_API_KEY: 'k' })
  );
  assert.equal(calls, 2);
  assert.equal(got?.score, 2.5);

  let serverCalls = 0;
  const gave = await withFetch(
    async () => {
      serverCalls += 1;
      return new Response('nope', { status: 500 });
    },
    () => askJev('some post', { TYPESAFE_API_KEY: 'k' })
  );
  assert.equal(serverCalls, 1, '500 is broken, not busy: retrying it only costs');
  assert.equal(gave, null);
});

test('the model is never asked about text over the cap', async () => {
  let called = false;
  const got = await withFetch(
    async () => {
      called = true;
      return ok(answer(4));
    },
    () => askJev('x'.repeat(2001), { TYPESAFE_API_KEY: 'k' })
  );
  assert.equal(got, null);
  assert.equal(called, false);
});

/* ------------------------------------------------------------- the rubric */

test('the instructions keep the sentence that protects non-native writers', () => {
  const { instructions } = jev.QUESTIONS.slop_level;
  assert.match(
    instructions,
    /Non-native English, awkward grammar, translation artefacts, typos, and unusual phrasing are signs of a HUMAN writer, not of AI\./,
    'removing this sentence makes the check flag people for writing in a second language'
  );
});

test('the rubric offers a way to say nothing matched', () => {
  assert.ok(Object.hasOwn(jev.QUESTIONS.top_signal.criteria, 'none'));
  assert.equal(jev.QUESTIONS.slop_level.criteria.length, 5, 'scores 0 to 4');
});
