import test from 'node:test';
import assert from 'node:assert/strict';

import * as ext from '../extension/src/core/ids.js';
import * as worker from '../worker/src/policy.js';
import { __testing as verdictTesting } from '../extension/src/core/verdict.js';
import { DEFAULTS } from '../extension/src/core/settings.js';

const { channelVerdict } = verdictTesting;
const HASH = 'XJFtebY3GQpVQ4lsxfgg33C8aDiYFAYhm253qQ1uE5Q';

// [id, platform, valid kind or null]
const SAMPLES = [
  ['9kzE8isXlQY', 'youtube', 'video'],
  ['@chillchilljournal', 'youtube', 'channel'],
  ['UCuAXFkgsw1L7xaCfnd5JJOw', 'youtube', 'channel'],
  ['x:2098513446715203844', 'x', 'video'],
  ['x:u:1862535163156082688', 'x', 'channel'],
  ['x:@some_account', 'x', 'channel'],
  ['x:@Some_Account', 'x', null], // handles are stored lower-case
  ['x:@way_too_long_handle', 'x', null],
  ['x:123456789012345678901', 'x', null],
  ['x:abc', 'x', null],
  [`li:${HASH}`, 'linkedin', 'video'],
  [`li:${HASH.slice(1)}`, 'linkedin', null],
  ['li:in:some-person-123', 'linkedin', 'channel'],
  ['li:company:acme-corp', 'linkedin', 'channel'],
  ['li:showcase:acme-cloud', 'linkedin', 'channel'],
  ['li:in:jos%c3%a9-garc%c3%ada', 'linkedin', 'channel'],
  ['li:school:some-school', 'linkedin', null],
  ['li:in:x', 'linkedin', null],
  ["x:'; DROP TABLE entries;--", 'x', null],
];

test('the extension and the worker agree on every id', () => {
  for (const [id, , valid] of SAMPLES) {
    for (const kind of ['video', 'channel']) {
      assert.equal(ext.isValidId(id, kind), kind === valid, `extension: ${id} as ${kind}`);
      assert.equal(worker.isValidId(id, kind), kind === valid, `worker: ${id} as ${kind}`);
    }
  }
});

test('every id belongs to exactly one platform, the same on both sides', () => {
  for (const [id, platform] of SAMPLES) {
    assert.equal(ext.platformOf(id), platform, id);
    assert.equal(worker.platformOf(id), platform, id);
  }
});

test('an X or LinkedIn id can never be read as a YouTube one', () => {
  // The list is keyed by sha256(id); a shared spelling would merge two entries.
  for (const [id, platform, valid] of SAMPLES) {
    if (platform === 'youtube' || !valid) continue;
    for (const kind of ['video', 'channel']) {
      assert.equal(/^[\w-]{11}$/.test(id) || /^(@[\w.-]{1,48}|UC[\w-]{22})$/.test(id), false, `${id} as ${kind}`);
    }
  }
});

test('X accounts are inferred at a quarter of at least eight media posts', () => {
  // RESEARCH.md section 15: AI accounts label 14-68% of their media, others 0%.
  assert.equal(channelVerdict({ ai: 2, total: 8 }, DEFAULTS, 'x')?.slop, true);
  assert.equal(channelVerdict({ ai: 1, total: 8 }, DEFAULTS, 'x'), null);
  assert.equal(channelVerdict({ ai: 3, total: 7 }, DEFAULTS, 'x'), null); // too few samples
  assert.equal(channelVerdict({ ai: 0, total: 40 }, DEFAULTS, 'x'), null);
});

test('YouTube keeps its own threshold, and LinkedIn infers nothing', () => {
  assert.equal(channelVerdict({ ai: 2, total: 8 }, DEFAULTS, 'youtube'), null);
  assert.equal(channelVerdict({ ai: 2, total: 8 }, DEFAULTS), null);
  assert.equal(channelVerdict({ ai: 12, total: 12 }, DEFAULTS, 'linkedin'), null);
  assert.equal(channelVerdict({ ai: 2, total: 8 }, { ...DEFAULTS, useChannelInference: false }, 'x'), null);
});
