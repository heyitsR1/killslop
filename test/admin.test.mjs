/** Console sign-in and access control, pasted-link parsing, feedback cleaning. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin, __testing as admin } from '../worker/src/admin.js';
import { cleanFeedback, parseYouTubeInput } from '../worker/src/policy.js';

const { mintSession, checkSession, passwordMatches, parseFeed, COOKIE } = admin;

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://killslop.example';

const env = (extra = {}) => ({
  ADMIN_PASSWORD: PASSWORD,
  ASSETS: { fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`) },
  ...extra,
});

const call = (path, init = {}, e = env()) =>
  handleAdmin(new Request(ORIGIN + path, init), e, new URL(ORIGIN + path));

const signIn = (password, origin = ORIGIN) =>
  call('/admin/login', {
    method: 'POST',
    headers: { origin },
    body: new URLSearchParams({ password }),
  });

test('a session verifies until it expires or the password changes', async () => {
  const e = env();
  const session = await mintSession(e);
  const [exp, sig] = session.split('.');
  assert.equal(await checkSession(e, session), true);
  assert.equal(await checkSession(env({ ADMIN_PASSWORD: 'rotated' }), session), false);
  assert.equal(await checkSession(e, `${Number(exp) + 1}.${sig}`), false, 'a stretched expiry breaks the signature');
  assert.equal(await checkSession(e, session, Number(exp) * 1000 + 1), false, 'expired');
  assert.equal(await checkSession(e, 'garbage'), false);
  assert.equal(await checkSession(e, null), false);
});

test('the password check accepts only the exact secret', async () => {
  const e = env();
  assert.equal(await passwordMatches(e, PASSWORD), true);
  assert.equal(await passwordMatches(e, PASSWORD.slice(0, -1)), false);
  assert.equal(await passwordMatches(e, `${PASSWORD} `), false);
  assert.equal(await passwordMatches(e, ''), false);
  assert.equal(await passwordMatches(e, undefined), false);
  assert.equal(await passwordMatches(env({ ADMIN_PASSWORD: '' }), ''), false);
});

test('the console is off, not open, when no password is configured', async () => {
  assert.equal((await call('/admin', {}, env({ ADMIN_PASSWORD: undefined }))).status, 503);
  assert.equal((await call('/admin/api/overview', {}, env({ ADMIN_PASSWORD: '' }))).status, 503);
});

test('signed out, /admin shows the sign-in page and everything else refuses', async () => {
  assert.equal(await (await call('/admin')).text(), 'asset:/admin/login.html');
  assert.equal(await (await call('/admin/')).text(), 'asset:/admin/login.html');
  assert.equal((await call('/admin/api/overview')).status, 401);
  assert.equal((await call('/admin/api/feedback')).status, 401);
  assert.equal((await call('/admin/app.js')).status, 401, 'the app itself needs a session');
  assert.equal((await call('/admin/index.html')).status, 401, 'no way round the gate by file name');
  assert.equal(await (await call('/admin/app.css')).text(), 'asset:/admin/app.css', 'sign-in page styles are public');
});

test('signing in sets a locked-down session cookie that opens the console', async () => {
  const wrong = await signIn('nope');
  assert.equal(wrong.status, 303);
  assert.match(wrong.headers.get('location'), /error=wrong/);
  assert.equal(wrong.headers.get('set-cookie'), null);

  const ok = await signIn(PASSWORD);
  assert.equal(ok.status, 303);
  const cookie = ok.headers.get('set-cookie');
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(attr), attr);
  assert.ok(cookie.startsWith(`${COOKIE}=`));

  const page = await call('/admin', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(await page.text(), 'asset:/admin/index.html');
});

test('a sign-in posted from another site is refused', async () => {
  const res = await signIn(PASSWORD, 'https://evil.example');
  assert.match(res.headers.get('location'), /error=origin/);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('with no usable Origin, Sec-Fetch-Site decides whether a sign-in is ours', async () => {
  const post = (headers) =>
    call('/admin/login', { method: 'POST', headers, body: new URLSearchParams({ password: PASSWORD }) });
  const ours = await post({ origin: 'null', 'sec-fetch-site': 'same-origin' });
  assert.ok(ours.headers.get('set-cookie'), 'Chrome sends Origin: null under some referrer policies');
  const theirs = await post({ origin: 'null', 'sec-fetch-site': 'cross-site' });
  assert.match(theirs.headers.get('location'), /error=origin/);
  const bare = await post({});
  assert.match(bare.headers.get('location'), /error=origin/, 'no headers at all is not proof');
});

test('cookie-authenticated writes must come from the console itself', async () => {
  const session = await mintSession(env());
  const res = await call('/admin/api/review', {
    method: 'POST',
    headers: { cookie: `${COOKIE}=${session}`, origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 403);
});

test('a bearer token works for scripts; a wrong one does not', async () => {
  const good = await call('/admin/api/nope', { headers: { authorization: `Bearer ${PASSWORD}` } });
  assert.equal(good.status, 404, 'authenticated, then no such route');
  const bad = await call('/admin/api/nope', { headers: { authorization: 'Bearer wrong' } });
  assert.equal(bad.status, 401);
});

test('sign-in and bearer guesses spend the sign-in budget', async () => {
  const spent = env({ RL_LOGIN: { limit: async () => ({ success: false }) } });
  const login = await call(
    '/admin/login',
    { method: 'POST', headers: { origin: ORIGIN }, body: new URLSearchParams({ password: PASSWORD }) },
    spent
  );
  assert.match(login.headers.get('location'), /error=rate/, 'even the right password waits');
  const bearer = await call('/admin/api/overview', { headers: { authorization: `Bearer ${PASSWORD}` } }, spent);
  assert.equal(bearer.status, 429);
});

test('console responses are never cached, framed or indexed', async () => {
  const res = await call('/admin');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
});

test('pasted YouTube links resolve to a video or a channel', () => {
  const video = { id: '9kzE8isXlQY', kind: 'video' };
  const handle = { id: '@chillchilljournal', kind: 'channel' };
  const ucid = { id: 'UCuAXFkgsw1L7xaCfnd5JJOw', kind: 'channel' };
  const cases = [
    ['https://www.youtube.com/watch?v=9kzE8isXlQY&t=30s', video],
    ['youtu.be/9kzE8isXlQY', video],
    ['https://youtu.be/9kzE8isXlQY?si=abc', video],
    ['https://youtube.com/shorts/9kzE8isXlQY', video],
    ['https://m.youtube.com/watch?v=9kzE8isXlQY', video],
    ['9kzE8isXlQY', video],
    ['https://www.youtube.com/@chillchilljournal/videos', handle],
    ['  @chillchilljournal ', handle],
    ['https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw', ucid],
    ['UCuAXFkgsw1L7xaCfnd5JJOw', ucid],
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseYouTubeInput(input), expected, input);

  for (const input of [
    'https://vimeo.com/123',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=short',
    'https://youtube.com.evil.example/watch?v=9kzE8isXlQY',
    'not a link',
    '',
    null,
  ]) {
    assert.equal(parseYouTubeInput(input), null, String(input));
  }
});

test('feedback is trimmed and checked, and the email stays optional', () => {
  assert.deepEqual(cleanFeedback({ message: '  it broke  ', category: 'bug' }), {
    message: 'it broke',
    email: null,
    category: 'bug',
    version: null,
  });
  assert.equal(cleanFeedback({ message: 'x', email: ' a@b.co ' }).email, 'a@b.co');
  assert.equal(cleanFeedback({ message: 'x', email: 'not an email' }).error, 'bad email');
  assert.equal(cleanFeedback({ message: 'x', email: 'a@b.co<script>' }).error, 'bad email');
  assert.equal(cleanFeedback({ message: '   ' }).error, 'empty message');
  assert.equal(cleanFeedback({ message: 'x'.repeat(4001) }).error, 'message too long');
  assert.equal(cleanFeedback({ message: 'x', category: 'spam' }).category, 'other');
  assert.equal(cleanFeedback({ message: 'a\u0000b\nc\td' }).message, 'ab\nc\td');
  assert.equal(cleanFeedback({ message: 'x', version: '0.1.0' }).version, '0.1.0');
  assert.equal(cleanFeedback({ message: 'x', version: '<script>' }).version, null);
  assert.equal(cleanFeedback(null).error, 'bad body');
});

test("a channel's RSS feed yields its name and recent uploads", () => {
  const xml =
    '<?xml version="1.0"?><feed><link rel="self"/><title>Eden &amp; Co | Bible Animation</title>' +
    '<entry><yt:videoId>9kzE8isXlQY</yt:videoId><title>Noah&#39;s Ark &#x2014; Part 1</title>' +
    '<media:group><media:title>ignored</media:title></media:group></entry>' +
    '<entry><yt:videoId>_Ak-mOGI_B4</yt:videoId><title>Part 2</title></entry></feed>';
  assert.deepEqual(parseFeed(xml), {
    title: 'Eden & Co | Bible Animation',
    videos: [
      { id: '9kzE8isXlQY', title: "Noah's Ark — Part 1" },
      { id: '_Ak-mOGI_B4', title: 'Part 2' },
    ],
  });
  assert.deepEqual(parseFeed('<feed></feed>'), { title: null, videos: [] });
});
