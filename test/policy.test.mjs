/** Channel-inference thresholds and community-API input validation. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing as verdictTesting } from '../extension/src/core/verdict.js';
import { __testing as workerTesting } from '../worker/src/index.js';
import { DEFAULTS } from '../extension/src/core/settings.js';
import { REVIEW_MODES, reviewMode } from '../worker/src/policy.js';

const { channelVerdict } = verdictTesting;
const { isValidId } = workerTesting;

test('a channel below the sample floor is never condemned', () => {
  // 4 for 4 is 100% AI but too small a sample to act on.
  assert.equal(channelVerdict({ ai: 4, total: 4 }, DEFAULTS), null);
});

test('a channel at the sample floor and above threshold is flagged', () => {
  // The measured shape of a slop farm: essentially every upload disclosed.
  assert.deepEqual(channelVerdict({ ai: 12, total: 12 }, DEFAULTS)?.slop, true);
  assert.deepEqual(channelVerdict({ ai: 9, total: 10 }, DEFAULTS)?.slop, true);
});

test('a real channel is never flagged', () => {
  // National Geographic and Veritasium both measured 0/12.
  assert.equal(channelVerdict({ ai: 0, total: 12 }, DEFAULTS), null);
  // Motiversity: heavily auto-dubbed, zero AI. Must survive.
  assert.equal(channelVerdict({ ai: 0, total: 12 }, DEFAULTS), null);
});

test('a mixed channel below threshold is left alone', () => {
  assert.equal(channelVerdict({ ai: 2, total: 10 }, DEFAULTS), null); // 20%
  assert.equal(channelVerdict({ ai: 5, total: 10 }, DEFAULTS), null); // 50%, under 60%
});

test('channel inference can be switched off entirely', () => {
  const off = { ...DEFAULTS, useChannelInference: false };
  assert.equal(channelVerdict({ ai: 12, total: 12 }, off), null);
});

test('worker accepts well-formed ids only', () => {
  assert.ok(isValidId('9kzE8isXlQY', 'video'));
  assert.ok(isValidId('@chillchilljournal', 'channel'));
  assert.ok(isValidId('UCuAXFkgsw1L7xaCfnd5JJOw', 'channel'));
});

test('worker rejects malformed or hostile ids', () => {
  assert.equal(isValidId('short', 'video'), false);
  assert.equal(isValidId('9kzE8isXlQY', 'channel'), false);
  assert.equal(isValidId('@bad handle', 'channel'), false);
  assert.equal(isValidId("'; DROP TABLE entries;--", 'video'), false);
  assert.equal(isValidId('x'.repeat(500), 'channel'), false);
  assert.equal(isValidId(null, 'video'), false);
  assert.equal(isValidId('9kzE8isXlQY', 'nonsense'), false);
});

test('worker only records tallies that clear the sampling threshold', () => {
  const { isValidTally } = workerTesting;
  assert.ok(isValidTally(12, 12));
  assert.ok(isValidTally(3, 5));   // exactly 60% of the floor
  assert.equal(isValidTally(4, 4), false, 'below the sample floor');
  assert.equal(isValidTally(2, 5), false, 'below the threshold');
  assert.equal(isValidTally(6, 5), false, 'more AI than samples');
  assert.equal(isValidTally(1.5, 5), false, 'non-integer');
  assert.equal(isValidTally(9999, 9999), false, 'implausibly large sample');
  assert.equal(isValidTally('5', '5'), false);
});

test('with review off, one person can never hide something for everyone', () => {
  const { decide } = workerTesting;
  assert.equal(decide({ up: 1, down: 0, tallies: 0 }, 'off'), null, 'one vote is kept in mind, not served');
  assert.equal(decide({ up: 2, down: 0, tallies: 0 }, 'off'), null);
  assert.equal(decide({ up: 0, down: 0, tallies: 1 }, 'off'), null, 'one measurement is not enough either');
  assert.deepEqual(decide({ up: 3, down: 0, tallies: 0 }, 'off'), { slop: true, evidence: 'vote' });
  assert.equal(decide({ up: 3, down: 1, tallies: 0 }, 'off'), null, 'net agreement is what counts');
  assert.deepEqual(decide({ up: 0, down: 3, tallies: 0 }, 'off'), { slop: false, evidence: 'vote' });
});

test('with review off, measured evidence outranks a few opinions, but not enough of them', () => {
  const { decide } = workerTesting;
  assert.deepEqual(decide({ up: 0, down: 0, tallies: 2 }, 'off'), { slop: true, evidence: 'disclosure' });
  assert.deepEqual(decide({ up: 0, down: 2, tallies: 2 }, 'off'), { slop: true, evidence: 'disclosure' });
  assert.deepEqual(decide({ up: 0, down: 3, tallies: 2 }, 'off'), { slop: false, evidence: 'vote' });
});

test('while review is on, nothing reaches clients until a maintainer approves it', () => {
  const { decide } = workerTesting;
  assert.equal(decide({ up: 50, down: 0, tallies: 9 }, 'all'), null, 'however strong the signal');
  assert.equal(decide({ up: 50, down: 0, tallies: 9 }), null, "'all' is the default");
  assert.deepEqual(decide({ up: 0, down: 0, tallies: 0, review: 'slop' }, 'all'), { slop: true, evidence: 'review' });
  assert.deepEqual(decide({ up: 1, down: 0, tallies: 1, review: 'slop' }, 'all'), { slop: true, evidence: 'disclosure' });
});

test('a rejection is final in every mode', () => {
  const { decide } = workerTesting;
  for (const mode of REVIEW_MODES) {
    assert.equal(decide({ up: 50, down: 0, tallies: 9, review: 'clean' }, mode), null, mode);
  }
});

test('votes mode publishes measurement on its own and holds opinion for review', () => {
  const { decide } = workerTesting;
  assert.deepEqual(decide({ up: 0, down: 0, tallies: 2 }, 'votes'), { slop: true, evidence: 'disclosure' });
  assert.equal(decide({ up: 9, down: 0, tallies: 0 }, 'votes'), null);
  assert.equal(decide({ up: 0, down: 9, tallies: 0 }, 'votes'), null);
});

test('an unknown review mode fails closed', () => {
  assert.equal(reviewMode({ REVIEW_MODE: 'of' }), 'all');
  assert.equal(reviewMode({}), 'all');
  assert.equal(reviewMode(undefined), 'all');
  assert.equal(reviewMode({ REVIEW_MODE: 'off' }), 'off');
});

test('an IPv6 address counts as its /64, so one household is one network', () => {
  const { networkOf } = workerTesting;
  assert.equal(networkOf('203.0.113.7'), '203.0.113.7');
  assert.equal(networkOf('2001:db8:85a3:1:aaaa:bbbb:cccc:1'), '2001:db8:85a3:1::/64');
  assert.equal(networkOf('2001:db8:85a3:1::2'), '2001:db8:85a3:1::/64');
  assert.equal(networkOf('2001:DB8::1'), '2001:db8:0:0::/64');
});
