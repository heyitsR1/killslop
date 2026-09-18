import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// parse.js is a plain content script, so load it the way Chrome would.
const context = { URL };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  readFileSync(new URL('../extension/src/content/parse.js', import.meta.url), 'utf8'),
  context
);
const { xPostIdFrom, xHandleFrom, linkedinPostIdFrom, linkedinAuthorFrom } = context.KillSlopParse;

const HASH = 'XJFtebY3GQpVQ4lsxfgg33C8aDiYFAYhm253qQ1uE5Q';

test('xPostIdFrom reads every permalink shape X uses', () => {
  assert.equal(xPostIdFrom('/SomeAccount/status/2098513446715203844'), 'x:2098513446715203844');
  assert.equal(xPostIdFrom('/SomeAccount/status/2098513446715203844/photo/1'), 'x:2098513446715203844');
  assert.equal(xPostIdFrom('/SomeAccount/status/2098513446715203844/analytics'), 'x:2098513446715203844');
  assert.equal(xPostIdFrom('https://x.com/i/status/123?s=20'), 'x:123');
  assert.equal(xPostIdFrom('https://twitter.com/i/web/status/123'), 'x:123');
});

test('xPostIdFrom rejects anything that is not a post', () => {
  assert.equal(xPostIdFrom('/SomeAccount'), null);
  assert.equal(xPostIdFrom('/search?q=status'), null);
  assert.equal(xPostIdFrom('/SomeAccount/status/abc'), null);
  assert.equal(xPostIdFrom('https://example.com/a/status/123'), null);
  assert.equal(xPostIdFrom(''), null);
  assert.equal(xPostIdFrom(null), null);
});

test('xHandleFrom reads profile links and normalises case', () => {
  assert.equal(xHandleFrom('/SomeAccount'), 'x:@someaccount');
  assert.equal(xHandleFrom('/SomeAccount/'), 'x:@someaccount');
  assert.equal(xHandleFrom('https://x.com/NASA'), 'x:@nasa');
  assert.equal(xHandleFrom('/SomeAccount'), xHandleFrom('/someaccount'));
});

test("xHandleFrom ignores X's own pages and deeper paths", () => {
  for (const href of ['/home', '/explore', '/i', '/notifications', '/hashtag', '/settings']) {
    assert.equal(xHandleFrom(href), null, href);
  }
  assert.equal(xHandleFrom('/SomeAccount/status/1'), null);
  assert.equal(xHandleFrom('/i/status/1'), null);
  assert.equal(xHandleFrom('/way_too_long_for_a_handle'), null);
});

test('linkedinPostIdFrom takes the URN hash out of a post componentkey', () => {
  assert.equal(linkedinPostIdFrom(`expanded${HASH}FeedType_MAIN_FEED_RELEVANCE`), `li:${HASH}`);
  assert.equal(linkedinPostIdFrom(`expanded${HASH}FeedType_FLAGSHIP_SEARCH`), `li:${HASH}`);
});

test('linkedinPostIdFrom ignores every other componentkey', () => {
  assert.equal(linkedinPostIdFrom(HASH), null);
  assert.equal(linkedinPostIdFrom('3ee44cc1-f633-42cd-808c-e91b7d026fa4'), null);
  assert.equal(linkedinPostIdFrom('replaceableComment_urn:li:comment:(activity:1,2)'), null);
  assert.equal(linkedinPostIdFrom(`expanded${HASH.slice(1)}FeedType_MAIN_FEED_RELEVANCE`), null);
  assert.equal(linkedinPostIdFrom(null), null);
});

test('linkedinAuthorFrom reads people and companies', () => {
  assert.equal(
    linkedinAuthorFrom('https://www.linkedin.com/in/Some-Person-123/?miniProfileUrn=abc'),
    'li:in:some-person-123'
  );
  assert.equal(linkedinAuthorFrom('/company/acme-corp/posts/'), 'li:company:acme-corp');
  assert.equal(linkedinAuthorFrom('/showcase/acme-cloud/'), 'li:showcase:acme-cloud');
  // A non-Latin vanity name comes out percent-encoded, the same every time.
  assert.equal(linkedinAuthorFrom('https://www.linkedin.com/in/josé-garcía/'), 'li:in:jos%c3%a9-garc%c3%ada');
  assert.equal(linkedinAuthorFrom('/in/jos%C3%A9-garc%C3%ADa'), 'li:in:jos%c3%a9-garc%c3%ada');
});

test('linkedinAuthorFrom ignores links that are not an author', () => {
  assert.equal(linkedinAuthorFrom('/feed/'), null);
  assert.equal(linkedinAuthorFrom('/in/'), null);
  assert.equal(linkedinAuthorFrom('/school/some-school/'), null);
  assert.equal(linkedinAuthorFrom('https://www.linkedin.com/safety/go/?url=x'), null);
  assert.equal(linkedinAuthorFrom(null), null);
});
