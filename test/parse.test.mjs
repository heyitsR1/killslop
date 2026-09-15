import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// parse.js is a plain content script, so load it the way Chrome would.
const context = { globalThis: null };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  readFileSync(new URL('../extension/src/content/parse.js', import.meta.url), 'utf8'),
  context
);
const { videoIdFrom, channelIdFrom } = context.KillSlopParse;

test('videoIdFrom handles every href shape YouTube tiles use', () => {
  assert.equal(videoIdFrom('/watch?v=9kzE8isXlQY'), '9kzE8isXlQY');
  assert.equal(videoIdFrom('/watch?v=9kzE8isXlQY&list=RDabc&index=2'), '9kzE8isXlQY');
  assert.equal(videoIdFrom('https://www.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(videoIdFrom('/shorts/9kzE8isXlQY'), '9kzE8isXlQY');
  assert.equal(videoIdFrom('/embed/9kzE8isXlQY?rel=0'), '9kzE8isXlQY');
  assert.equal(videoIdFrom('/live/9kzE8isXlQY'), '9kzE8isXlQY');
});

test('videoIdFrom rejects non-video hrefs', () => {
  assert.equal(videoIdFrom('/@chillchilljournal'), null);
  assert.equal(videoIdFrom('/results?search_query=lofi'), null);
  assert.equal(videoIdFrom('/playlist?list=PLabc'), null);
  assert.equal(videoIdFrom(''), null);
  assert.equal(videoIdFrom(null), null);
  assert.equal(videoIdFrom(undefined), null);
});

test('videoIdFrom does not accept a wrong-length id', () => {
  assert.equal(videoIdFrom('/watch?v=tooshort'), null);
  assert.equal(videoIdFrom('/watch?v=waaaaaaaaaaytoolong123'), null);
});

test('channelIdFrom reads both handles and UC ids', () => {
  assert.equal(channelIdFrom('/channel/UCuAXFkgsw1L7xaCfnd5JJOw'), 'UCuAXFkgsw1L7xaCfnd5JJOw');
  assert.equal(channelIdFrom('/@chillchilljournal'), '@chillchilljournal');
  assert.equal(channelIdFrom('/@Chill.Chill-Journal/videos'), '@chill.chill-journal');
});

test('channel handles normalise to lower case so tallies agree', () => {
  assert.equal(channelIdFrom('/@Veritasium'), channelIdFrom('/@veritasium'));
});

test('channelIdFrom ignores watch urls', () => {
  assert.equal(channelIdFrom('/watch?v=9kzE8isXlQY'), null);
});
