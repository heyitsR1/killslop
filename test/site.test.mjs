/** Which host gets what: the website, the API, the console, the shared files. */

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';

const FILES = new Set([
  '/site/index.html',
  '/site/privacy.html',
  '/site/support.html',
  '/site/waitlist.html',
  '/site/waitlist.js',
  '/site/uninstall.html',
  '/site/uninstall.js',
  '/site/404.html',
  '/site/site.css',
  '/ui/base.css',
  '/fonts/Geist-Variable.woff2',
  '/admin/login.html',
]);

const env = {
  ADMIN_PASSWORD: 'pw',
  ASSETS: {
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      return FILES.has(path) ? new Response(`asset:${path}`) : new Response('missing', { status: 404 });
    },
  },
};

const get = (url, init) => worker.fetch(new Request(url, init), env);
const body = async (url) => (await get(url)).text();

test('killslop.app serves the website', async () => {
  const home = await get('https://killslop.app/');
  assert.equal(home.status, 200);
  assert.equal(await home.text(), 'asset:/site/index.html');
  assert.match(home.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(await body('https://killslop.app/privacy'), 'asset:/site/privacy.html');
  assert.equal(await body('https://killslop.app/privacy/'), 'asset:/site/privacy.html');
  assert.equal(await body('https://killslop.app/site/site.css'), 'asset:/site/site.css');
});

test('the waiting list is a page of its own, with its script', async () => {
  assert.equal(await body('https://killslop.app/waitlist'), 'asset:/site/waitlist.html');
  assert.equal(await body('https://killslop.app/waitlist/'), 'asset:/site/waitlist.html');
  assert.equal(await body('https://killslop.app/site/waitlist.js'), 'asset:/site/waitlist.js');
});

test('the support page is served on the site, not a redirect off it', async () => {
  const res = await get('https://killslop.app/support');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'asset:/site/support.html');
  assert.equal(await body('https://killslop.app/support/'), 'asset:/site/support.html');
});

test('/get sends people to wherever the extension is installed from', async () => {
  const res = await get('https://killslop.app/get');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^https:\/\//);
});

test('an unknown page on the site gets the 404 page', async () => {
  const res = await get('https://killslop.app/no-such-page');
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'asset:/site/404.html');
});

test('the console and the API are not reachable on the site host', async () => {
  for (const path of ['/admin', '/admin/', '/admin/login.html', '/admin/app.js', '/api/v1/stats']) {
    const res = await get(`https://killslop.app${path}`);
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), 'asset:/site/404.html', path);
  }
  const post = await get('https://killslop.app/api/v1/report', { method: 'POST', body: '{}' });
  assert.equal(post.status, 405);
});

test('www redirects to the apex and keeps the path', async () => {
  const res = await get('https://www.killslop.app/privacy?from=store');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://killslop.app/privacy?from=store');
});

test('the API host sends its bare root to the website', async () => {
  const res = await get('https://api.killslop.app/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://killslop.app/');
});

test('the shared stylesheet and fonts are served on every host, and nothing else is', async () => {
  for (const host of ['killslop.app', 'api.killslop.app']) {
    const css = await get(`https://${host}/ui/base.css`);
    assert.equal(css.status, 200, host);
    assert.match(css.headers.get('cache-control'), /max-age=3600/);
    const font = await get(`https://${host}/fonts/Geist-Variable.woff2`);
    assert.equal(font.status, 200, host);
    assert.match(font.headers.get('cache-control'), /immutable/);
  }
  assert.equal((await get('https://api.killslop.app/ui/other.css')).status, 404);
  assert.notEqual((await get('https://api.killslop.app/fonts/../admin/index.html')).status, 200);
});
