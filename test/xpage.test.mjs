import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// x-page.js runs in x.com's page world. Load it into a stand-in page with a
// fake fetch and XMLHttpRequest, feed it API responses, and read the events
// it hands to the content script.
const SOURCE = readFileSync(new URL('../extension/src/content/x-page.js', import.meta.url), 'utf8');

function page(bodies) {
  const events = [];
  class FakeXHR {
    constructor() {
      this.listeners = [];
      this.responseType = '';
    }
    open(method, url) {
      this.url = url;
    }
    addEventListener(type, fn) {
      if (type === 'load') this.listeners.push(fn);
    }
    respond(text) {
      this.responseText = text;
      for (const fn of this.listeners) fn.call(this);
    }
  }
  const nativeResult = new Map();
  const context = {
    URL,
    JSON,
    location: { href: 'https://x.com/home' },
    document: { dispatchEvent: (ev) => events.push({ type: ev.type, posts: JSON.parse(ev.detail) }) },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    XMLHttpRequest: FakeXHR,
    fetch: (url) => {
      const res = { url, clone: () => ({ text: async () => bodies[url] ?? '' }) };
      const pending = Promise.resolve(res);
      nativeResult.set(url, pending);
      return pending;
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { context, events, nativeResult };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const tweet = (id, userId, handle, { media = false, mark = null, typed = true } = {}) => ({
  ...(typed ? { __typename: 'Tweet' } : {}),
  rest_id: id,
  core: { user_results: { result: { __typename: 'User', rest_id: userId, core: { screen_name: handle } } } },
  ...(mark ? { content_disclosure: { ai_generated_disclosure: mark } } : {}),
  legacy: { full_text: 'text', ...(media ? { extended_entities: { media: [{ type: 'photo' }] } } : {}) },
});

const entry = (result) => ({ content: { itemContent: { tweet_results: { result } } } });

// The shapes seen live on 2026-09-15 (RESEARCH.md section 12), with made-up ids.
const TIMELINE = JSON.stringify({
  data: {
    home: {
      home_timeline_urt: {
        instructions: [
          {
            type: 'TimelineAddEntries',
            entries: [
              entry(tweet('1001', '501', 'LabelledArt', {
                media: true,
                mark: { ai_generated_detection_source: 'C2paClient', can_edit: false, has_ai_generated_media: true },
              })),
              entry({ __typename: 'TweetWithVisibilityResults', tweet: tweet('1002', '502', 'Plain', { media: true, typed: false }) }),
              entry({
                ...tweet('1003', '503', 'Quoter'),
                quoted_status_result: {
                  result: tweet('1004', '504', 'Declared', {
                    media: true,
                    mark: { can_edit: true, has_ai_generated_media: true },
                  }),
                },
              }),
              // The same post again, without its mark: must not unlabel it.
              entry(tweet('1001', '501', 'LabelledArt', { media: true })),
            ],
          },
        ],
      },
    },
  },
});

test('reads every post in a timeline response, however it is nested', async () => {
  const url = 'https://x.com/i/api/graphql/abc/HomeTimeline?variables=%7B%7D';
  const { context, events } = page({ [url]: TIMELINE });
  await context.fetch(url);
  await settle();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'killslop:x-posts');
  const byId = Object.fromEntries(events[0].posts.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(byId).sort(), ['1001', '1002', '1003', '1004']);

  assert.deepEqual(byId['1001'], {
    id: '1001', userId: '501', handle: 'LabelledArt', media: true, ai: true, source: 'C2paClient',
  });
  assert.equal(byId['1002'].ai, false);
  assert.equal(byId['1002'].media, true);
  assert.equal(byId['1003'].media, false);
  // A declared label carries no detection source.
  assert.equal(byId['1004'].ai, true);
  assert.equal(byId['1004'].source, null);
});

test('reads XMLHttpRequest responses too', async () => {
  const { context, events } = page({});
  const xhr = new context.XMLHttpRequest();
  xhr.open('GET', '/i/api/1.1/flow/timeline.json');
  xhr.respond(TIMELINE);
  assert.equal(events.length, 1);
  assert.equal(events[0].posts.length, 4);
});

test('leaves everything else alone', async () => {
  const other = 'https://x.com/i/api/1.1/badge_count.json';
  const offsite = 'https://abs.twimg.com/responsive-web/client-web/main.js';
  const { context, events, nativeResult } = page({ [other]: '{"ntab":1}', [offsite]: TIMELINE });

  const pending = context.fetch(other);
  // The page gets the very promise the real fetch returned.
  assert.equal(pending, nativeResult.get(other));
  await pending;
  await context.fetch(offsite);
  await settle();

  const xhr = new context.XMLHttpRequest();
  xhr.open('GET', 'https://x.com/i/api/graphql/abc/SearchTimeline');
  xhr.respond('not json but mentions "Tweet"');

  assert.equal(events.length, 0);
});
