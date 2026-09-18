/** The public counts on the website, from countStats() in worker/src/policy.js. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { countStats } from '../worker/src/policy.js';

const UC = `UC${'a'.repeat(22)}`;
const UC2 = `UC${'b'.repeat(22)}`;
const row = (over) => ({ kind: 'channel', id: UC, up: 0, down: 0, tallies: 0, review: null, ucid: null, ...over });

test('a channel stored as handle and as UC id counts once', () => {
  const stats = countStats([
    row({ id: UC, review: 'slop', tallies: 1 }),
    row({ id: '@farm', ucid: UC, review: 'slop', tallies: 1 }),
  ]);
  assert.equal(stats.entries, 1);
  assert.equal(stats.channels, 1);
  assert.equal(stats.channelsByDisclosure, 1);
});

test('a handle whose UC id is unknown counts as its own channel', () => {
  const stats = countStats([row({ id: UC, review: 'slop' }), row({ id: '@other', review: 'slop' })]);
  assert.equal(stats.channels, 2);
  assert.equal(stats.channelsByDisclosure, 0);
});

test('of two spellings, the reviewed one stands for both', () => {
  const stats = countStats([row({ id: '@farm', ucid: UC }), row({ id: UC, review: 'slop' })]);
  assert.equal(stats.channels, 1);
  assert.equal(stats.pending, 0);
});

test('a rejected entry is not waiting for review', () => {
  const stats = countStats([row({ review: 'clean' }), row({ id: UC2 }), row({ kind: 'video', id: 'dQw4w9WgXcQ' })]);
  assert.equal(stats.pending, 2);
  assert.equal(stats.channels, 0);
});

test('approved videos are counted apart from channels', () => {
  const stats = countStats([row({ kind: 'video', id: 'dQw4w9WgXcQ', review: 'slop' }), row({ review: 'slop' })]);
  assert.equal(stats.videos, 1);
  assert.equal(stats.channels, 1);
  assert.equal(stats.reviewed, 2);
});
