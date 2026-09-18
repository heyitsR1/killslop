import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// slopsigns.js is a plain content script, so load it the way Chrome would.
const context = {};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  readFileSync(new URL('../extension/src/content/slopsigns.js', import.meta.url), 'utf8'),
  context
);
const { normalizeText, prefilter, MIN_CHARS } = context.KillSlopSigns;

const sends = (text) => prefilter(text).suspicious;
// Copied into this realm: an array built inside the vm has a different
// Array prototype, which deepEqual reports as "not reference-equal".
const hits = (text) => [...prefilter(text).hits];

/* ------------------------------------------------------------- normalizing */

test('normalizeText squeezes blank space but keeps the lines', () => {
  assert.equal(normalizeText('a   b\t\tc'), 'a b c');
  assert.equal(normalizeText('  padded  '), 'padded');
  assert.equal(normalizeText('a\r\nb'), 'a\nb');
  // A listicle's shape is itself a sign, so lines must survive.
  assert.equal(normalizeText('one\n\n\n\ntwo'), 'one\n\ntwo');
  assert.equal(normalizeText('-> a\n-> b'), '-> a\n-> b');
});

test('normalizeText gives two spellings of one post the same text', () => {
  // Same post, different whitespace: one cached verdict must serve both.
  assert.equal(normalizeText('It is not X.  It is Y.'), normalizeText('It is not X. It is Y.'));
  assert.equal(normalizeText(' a \n\n\n b '), normalizeText('a\n\nb'));
});

test('normalizeText survives what a page can hand it', () => {
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(42), '');
});

/* ----------------------------------------------------------------- the gate */

test('a post too short to read anything off is never sent', () => {
  assert.equal(sends('It is not X. It is Y.'), false);
  assert.ok('It is not X. It is Y.'.length < MIN_CHARS);
});

test('one strong structural tell is enough on its own', () => {
  assert.ok(
    sends("Most people think AI is about automation.\n\nIt's not.\n\nIt's about leverage, really.")
  );
  assert.deepEqual(hits('Here is the whole thing in short, and it is worth reading:\n-> one\n-> two\n-> three'), [
    'listicle_formatting',
    'stacked_lines',
  ]);
});

test('a single soft tell is not enough, but two are', () => {
  // One AI-vocabulary word is ordinary English and must not spend a request.
  const one = 'This is a crucial change and I am glad we finally found the time for it.';
  assert.equal(hits(one).length, 0, 'one vocabulary word is not yet a signal');
  assert.equal(sends(one), false);

  const soft = 'Honestly a real game-changer for how we work, and everyone will feel it soon.';
  assert.deepEqual(hits(soft), ['significance_puffery']);
  assert.equal(sends(soft), false, 'one soft tell alone must not spend a request');

  assert.ok(sends('A crucial, pivotal moment that will redefine the landscape of our whole industry.'));
});

test('the tightest negative parallelism is caught', () => {
  // No arrows, no vocabulary: the contrast is the only thing to go on.
  assert.ok(hits("Most people think it is about the tools.\n\nIt's not.\n\nIt's about the taste.").includes('negative_parallelism'));
});

/* --------------------------------------------------------------- fairness */

/**
 * The gate must not read unusual English as machine English. These are human
 * posts, one of them taken off a real timeline, and holding them back would
 * mean the writing check never even gets the chance to clear them.
 */
test('non-native English is not a sign of AI', () => {
  const human = [
    'Without surgery, without even a single incision,\nthe doctor sir removed the kidney stones from the stomach..!!\n\nThe country just needs talent like this',
    'Respected sir, kindly do the needful and revert back at the earliest. Same is very much urgent from our side. Thanking you in advance for your kind cooperation.',
    'Today I am go to market for buy the vegetable and the price is very much high compare to last month, what to do only.',
  ];
  for (const text of human) {
    assert.equal(sends(text), false, `held back a human post: ${text.slice(0, 40)}`);
  }
});

test('ordinary human posts are not sent', () => {
  const human = [
    "I just wanted to give her a surprise, but it turned into a scare instead. I bet she'll never forget to lock the door when she comes home from now on, huh?",
    'We shipped dark mode today. It took way longer than it should have because our design tokens were a mess. Changelog in the replies if you want the gory details.',
    'The thing nobody tells you about maintaining a popular open source library is that the code is maybe 20% of it. The rest is triage and saying no kindly.',
    'A brief note on yesterday: a schema migration locked a hot table for 90 seconds at peak. We have added a pre-flight check and moved migrations to a window.',
  ];
  for (const text of human) {
    assert.equal(sends(text), false, `held back a human post: ${text.slice(0, 40)}`);
  }
});

/* ------------------------------------------------------------------- slop */

test('the shapes the check exists for all get sent', () => {
  const slop = [
    // The LinkedIn announcement: no arrows and no AI vocabulary at all.
    "I'm beyond thrilled to announce that I've joined Acme as Senior Product Lead! This journey has been nothing short of transformative. Grateful to everyone who believed in me. Onwards and upwards!",
    "In today's rapidly evolving digital landscape, leaders must delve into the intricate dynamics of change.\n\nHere are 3 crucial lessons:\n\n1. Adaptability is key\n2. Culture eats strategy\n3. Vulnerability is strength\n\nWhich one resonates most?",
    "Most people think AI is about automation.\n\nIt's not.\n\nIt's about leverage.\n\nHere's what nobody tells you:\n\n-> Leverage compounds\n-> Automation doesn't\n-> The difference is everything\n\nWhich one are you?",
    'This marks a pivotal shift in how we think about work. Industry reports underscore that the best operators are not just adapting, but fundamentally reimagining the landscape.',
  ];
  for (const text of slop) {
    assert.ok(sends(text), `would never be checked: ${text.slice(0, 40)}`);
  }
});

test('prefilter hands back the text it judged, ready to hash', () => {
  const { text } = prefilter('  It is not X.   It is Y, and that is the whole point of it all.  ');
  assert.equal(text, 'It is not X. It is Y, and that is the whole point of it all.');
});
