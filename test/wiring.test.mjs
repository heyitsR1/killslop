/**
 * The message router must forward everything the verdict engine hands it.
 *
 * This exists because it did not. `resolveBatch` returns three fields, and the
 * `resolve` handler in the service worker destructured and returned only two:
 * `check` was dropped, so tier 4 never reached the page (content/feed.js acts
 * on `res.check`). Every X and LinkedIn post stayed 'pending' for ever, nothing
 * was ever sent to the writing check, and nothing errored. On LinkedIn, where
 * the writing check is the only hiding tier there is, the platform hid nothing
 * at all.
 *
 * A unit test of the handler would need verdict.js, which reaches store.js
 * (IndexedDB) and settings.js (chrome.storage), neither of which exists in
 * node. So this is a source-level invariant, in the style of design.test.mjs.
 *
 * Note for anyone editing this: `resolveBatch` has an early-exit return that
 * carries only a subset of the fields, so reading one return statement is not
 * enough. Take the union of every return in the function, which is the set of
 * fields it can emit and therefore the set the handler must be able to pass on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

/** The text of one function, from `start` up to `end` (or end of file). */
function span(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `could not find ${start}`);
  const rest = source.slice(from + start.length);
  const to = end ? rest.indexOf(end) : -1;
  return to === -1 ? rest : rest.slice(0, to);
}

/** Every key returned by any `return { ... }` in `body`, unioned. */
function returnedKeys(body) {
  const keys = new Set();
  for (const m of body.matchAll(/return\s*\{([^{}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim();
      if (key) keys.add(key);
    }
  }
  assert.ok(keys.size, 'no object return found');
  return keys;
}

test('resolveBatch still returns the three tiers it is documented to', async () => {
  const verdict = await read('extension/src/core/verdict.js');
  const keys = returnedKeys(span(verdict, 'export async function resolveBatch', '\nexport '));
  for (const key of ['verdicts', 'probe', 'check']) {
    assert.ok(keys.has(key), `resolveBatch no longer returns ${key}; found ${[...keys].join(', ')}`);
  }
});

test('the resolve handler forwards every field resolveBatch returns', async () => {
  const [verdict, worker] = await Promise.all([
    read('extension/src/core/verdict.js'),
    read('extension/src/background/service-worker.js'),
  ]);
  const produced = returnedKeys(span(verdict, 'export async function resolveBatch', '\nexport '));
  const forwarded = returnedKeys(span(worker, 'async resolve(', '\n  async '));

  // Guard the guard: if the span ever stops covering the real return, this
  // test would silently pass on anything. `check` is the field that was lost.
  assert.ok(produced.has('check'), 'the resolveBatch span no longer covers its full return');

  for (const key of produced) {
    assert.ok(
      forwarded.has(key),
      `the resolve handler drops "${key}". content/feed.js reads res.check, and a ` +
        'dropped field fails silently: the page simply never acts on that tier.'
    );
  }
});

test('the page still acts on res.check, so forwarding it matters', async () => {
  const feed = await read('extension/src/content/feed.js');
  assert.match(
    feed,
    /res\?\.check/,
    'feed.js no longer reads res.check; if tier 4 moved, update this test and the handler together'
  );
});
