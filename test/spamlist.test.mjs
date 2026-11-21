/**
 * The X AI-reply spammer list: the worker merges the sources, the extension
 * matches against it. Real shapes from blockedforaireply.levels.io (2026-11-19).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildList } from '../worker/src/spamlist.js';
import { __testing } from '../extension/src/core/spamlist.js';

const { build, flagsFor, hides } = __testing;

const LEVELS = {
  updated_at: '2026-11-19T14:44:02Z',
  accounts: [
    { id: '781293', username: 'martinvars', levelsio: 'confirmed', ryanvogel: null },
    { id: '1221471', username: 'shashib', levelsio: 'blocked', ryanvogel: null },
    { id: '977517252739125249', username: 'BomHoang4943', levelsio: 'blocked', ryanvogel: { ai_flags: 1 } },
    { id: '2008421182891323400', username: 'moa_builds', levelsio: 'likely', ryanvogel: null },
    { id: '42', username: 'only_clank', levelsio: null, ryanvogel: { ai_flags: 2 } },
    { id: 'not-a-number', username: 'bad handle!', levelsio: 'confirmed' },
  ],
};

test('levelsio statuses and Clankwall flags become one row per account', () => {
  const list = buildList(LEVELS, []);
  const rows = new Map(list.accounts.map((r) => [r[1], r]));
  assert.deepEqual(rows.get('martinvars'), ['781293', 'martinvars', 'c']);
  assert.deepEqual(rows.get('shashib'), ['1221471', 'shashib', 'b']);
  assert.deepEqual(rows.get('bomhoang4943'), ['977517252739125249', 'bomhoang4943', 'bv']);
  assert.deepEqual(rows.get('moa_builds'), ['2008421182891323400', 'moa_builds', 'bn'], "'likely' has no evidence, so it is served as unreviewed");
  assert.deepEqual(rows.get('only_clank'), ['42', 'only_clank', 'v']);
  assert.equal(list.accounts.length, 5, 'an entry with neither a valid id nor handle is dropped');
  assert.equal(list.sources.levelsio.total, 6);
});

test('our own reviewed accounts merge into the same rows', () => {
  const list = buildList(LEVELS, ['x:u:781293', 'x:@fresh_bot', 'x:@MartinVars', 'youtube-id']);
  const rows = new Map(list.accounts.map((r) => [r[1] || r[0], r]));
  assert.equal(rows.get('martinvars')[2], 'ck');
  assert.deepEqual(rows.get('fresh_bot'), ['', 'fresh_bot', 'k']);
  assert.equal(list.sources.killslop.count, 2, 'a malformed id is not counted');
});

test('with levelsio unreachable the list is ours alone', () => {
  const list = buildList(null, ['x:@fresh_bot']);
  assert.equal(list.sources.levelsio, null);
  assert.deepEqual(list.accounts, [['', 'fresh_bot', 'k']]);
});

test('the extension matches by id or by handle', () => {
  const idx = build(buildList(LEVELS, ['x:@fresh_bot']));
  assert.equal(flagsFor(idx, 'x:u:781293'), 'c');
  assert.equal(flagsFor(idx, 'x:@martinvars'), 'c');
  assert.equal(flagsFor(idx, 'x:@fresh_bot'), 'k');
  assert.equal(flagsFor(idx, 'x:@nobody'), null);
  assert.equal(flagsFor(idx, 'UCabc'), null);
  assert.equal(idx.rows.length, 6);
});

test('unreviewed silent blocks hide only when asked for', () => {
  assert.equal(hides('c', {}), true);
  assert.equal(hides('l', {}), true);
  assert.equal(hides('bv', {}), true, 'Clankwall flagged it, so it hides by default');
  assert.equal(hides('k', {}), true);
  assert.equal(hides('b', {}), false);
  assert.equal(hides('bn', {}), false, "levelsio 'likely' alone is opt-in");
  assert.equal(hides('bnv', {}), true, "'likely' plus a Clankwall flag still hides");
  assert.equal(hides('b', { spamListUnreviewed: true }), true);
  assert.equal(hides('bn', { spamListUnreviewed: true }), true);
  assert.equal(hides(null, { spamListUnreviewed: true }), false);
});
