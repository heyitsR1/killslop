/** Channel-inference thresholds and community-API input validation. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing as verdictTesting } from '../extension/src/core/verdict.js';
import { __testing as workerTesting } from '../worker/src/index.js';
import { DEFAULTS } from '../extension/src/core/settings.js';
import { createHash } from 'node:crypto';
import worker from '../worker/src/index.js';
import {
  PLATFORMS,
  REVIEW_MODES,
  linkedinPostId,
  parseInput,
  platformOf,
  reviewMode,
} from '../worker/src/policy.js';

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

/* ------------------------------------------------------ X and LinkedIn ids */

const LI_ACTIVITY = '7000000000000000001';
const LI_POST = `li:${createHash('sha256').update(`urn:li:activity:${LI_ACTIVITY}`).digest('base64url')}`;

test('every platform has its own id shapes, and none passes for another', () => {
  const ok = [
    ['9kzE8isXlQY', 'video'],
    ['UCuAXFkgsw1L7xaCfnd5JJOw', 'channel'],
    ['@chillchilljournal', 'channel'],
    ['x:2000000000000000001', 'video'],
    ['x:u:1000000000000000001', 'channel'],
    ['x:@some_one_123', 'channel'],
    [LI_POST, 'video'],
    ['li:in:jane-doe', 'channel'],
    ['li:company:examplecorp', 'channel'],
    ['li:showcase:examplecloud', 'channel'],
    ['li:in:jos%c3%a9-garcia', 'channel'],
  ];
  for (const [id, kind] of ok) assert.ok(isValidId(id, kind), `${id} as ${kind}`);

  const bad = [
    ['x:2000000000000000001', 'channel', 'a post is not an account'],
    ['x:u:1000000000000000001', 'video', 'an account is not a post'],
    ['x:@Some_One_123', 'channel', 'handles are stored lower case'],
    ['x:@a_handle_far_too_long', 'channel', 'X handles stop at 15'],
    ['x:123456789012345678901', 'video', 'over 20 digits'],
    ['x:abc', 'video', 'X ids are numeric'],
    ['li:tooshort', 'video', 'a LinkedIn post id is a 43-character hash'],
    ['li:in:Jane-Doe', 'channel', 'slugs are stored lower case'],
    ['li:school:mit', 'channel', 'people and companies only'],
    ['@x:123', 'channel', 'not a YouTube handle either'],
    ['9kzE8isXlQY', 'constructor', 'a prototype key is not a kind'],
    ['x:123', '__proto__', 'a prototype key is not a kind'],
  ];
  for (const [id, kind, why] of bad) assert.equal(isValidId(id, kind), false, `${id} as ${kind}: ${why}`);
});

test('an id names its own platform', () => {
  assert.deepEqual(PLATFORMS, ['youtube', 'x', 'linkedin']);
  assert.equal(platformOf('9kzE8isXlQY'), 'youtube');
  assert.equal(platformOf('@chillchilljournal'), 'youtube');
  assert.equal(platformOf('x:2000000000000000001'), 'x');
  assert.equal(platformOf('li:in:jane-doe'), 'linkedin');
  assert.equal(platformOf(null), null);
});

test('a tally is checked against its own platform, and LinkedIn takes none', () => {
  const { isValidTally } = workerTesting;
  // The shapes measured in RESEARCH.md section 15.
  assert.ok(isValidTally(7, 20, 'x'), 'an AI account labelling 35% of its media');
  assert.ok(isValidTally(2, 8, 'x'), 'exactly 25% of the floor');
  assert.equal(isValidTally(3, 21, 'x'), false, '14% stays under the bar');
  assert.equal(isValidTally(0, 21, 'x'), false, 'an ordinary account');
  assert.equal(isValidTally(7, 7, 'x'), false, 'X needs 8 media posts');
  assert.equal(isValidTally(2, 8, 'youtube'), false, "X's bar is not YouTube's");
  assert.ok(isValidTally(3, 5), 'YouTube stays the default');
  assert.equal(isValidTally(8, 8, 'linkedin'), false, 'LinkedIn has no label to tally');
  assert.equal(isValidTally(12, 12, 'nonsense'), false);
  assert.equal(isValidTally(12, 12, '__proto__'), false);
});

test('pasted X and LinkedIn links resolve to a post or an author', async () => {
  const xPost = { id: 'x:2000000000000000001', kind: 'video', platform: 'x' };
  const xHandle = { id: 'x:@some_one_123', kind: 'channel', platform: 'x' };
  const liPost = { id: LI_POST, kind: 'video', platform: 'linkedin' };
  const cases = [
    ['https://x.com/Some_One_123/status/2000000000000000001', xPost],
    ['https://twitter.com/Some_One_123/status/2000000000000000001/photo/1', xPost],
    ['x.com/i/status/2000000000000000001', xPost],
    ['https://mobile.x.com/i/web/status/2000000000000000001', xPost],
    ['x:2000000000000000001', xPost],
    ['https://x.com/Some_One_123', xHandle],
    ['https://www.x.com/Some_One_123/media', xHandle],
    ['  x:@Some_One_123 ', xHandle],
    ['https://x.com/i/user/1000000000000000001', { id: 'x:u:1000000000000000001', kind: 'channel', platform: 'x' }],
    ['https://www.linkedin.com/in/Jane-Doe/', { id: 'li:in:jane-doe', kind: 'channel', platform: 'linkedin' }],
    ['linkedin.com/company/examplecorp/posts/', { id: 'li:company:examplecorp', kind: 'channel', platform: 'linkedin' }],
    ['https://www.linkedin.com/showcase/ExampleCloud/', { id: 'li:showcase:examplecloud', kind: 'channel', platform: 'linkedin' }],
    [`https://www.linkedin.com/feed/update/urn:li:activity:${LI_ACTIVITY}/`, liPost],
    [`https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${LI_ACTIVITY}`, liPost],
    [`https://www.linkedin.com/posts/jane-doe_a-title-activity-${LI_ACTIVITY}-AbCd?utm_source=share`, liPost],
    [`urn:li:activity:${LI_ACTIVITY}`, liPost],
    [LI_POST, liPost],
    ['https://www.youtube.com/watch?v=9kzE8isXlQY', { id: '9kzE8isXlQY', kind: 'video', platform: 'youtube' }],
    ['@chillchilljournal', { id: '@chillchilljournal', kind: 'channel', platform: 'youtube' }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(await parseInput(input), expected, input);

  for (const input of [
    'https://x.com/',
    'https://x.com/home',
    'https://x.com/explore',
    'https://x.com/search?q=slop',
    'https://x.com/i/bookmarks',
    'https://x.com.evil.example/Some_One_123/status/2000000000000000001',
    'https://www.linkedin.com/feed/',
    'https://www.linkedin.com/feed/update/urn:li:ugcPost:123/',
    'https://linkedin.com.evil.example/in/jane-doe',
    'x:not-an-id',
    'li:in:J',
    '',
    null,
  ]) {
    assert.equal(await parseInput(input), null, String(input));
  }
  assert.equal(await linkedinPostId(LI_ACTIVITY), LI_POST, 'Web Crypto and node:crypto agree');
});

test('a report or tally whose platform disagrees with its id is refused before it is stored', async () => {
  // No DB binding: a request that reached the database would throw, so a 400
  // here proves the refusal came first.
  const post = (path, body) =>
    worker.fetch(
      new Request(`https://api.killslop.app${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      {}
    );
  const mismatched = [
    ['/api/v1/report', { id: 'x:2000000000000000001', kind: 'video', slop: true }],
    ['/api/v1/report', { id: '9kzE8isXlQY', kind: 'video', slop: true, platform: 'x' }],
    ['/api/v1/report', { id: 'li:in:jane-doe', kind: 'channel', slop: true, platform: 'myspace' }],
    ['/api/v1/tally', { id: 'x:u:1000000000000000001', ai: 8, total: 8 }],
  ];
  for (const [path, body] of mismatched) {
    const res = await post(path, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error, 'bad platform', JSON.stringify(body));
  }
  const li = await post('/api/v1/tally', { id: 'li:in:jane-doe', ai: 8, total: 8, platform: 'linkedin' });
  assert.equal((await li.json()).error, 'bad tally', 'LinkedIn takes no tallies');
  const low = await post('/api/v1/tally', { id: 'x:u:1000000000000000001', ai: 1, total: 8, platform: 'x' });
  assert.equal((await low.json()).error, 'bad tally', 'under the X bar');
});
