/** Removing KillSlop: where Chrome is sent, and what that link may carry. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../worker/src/index.js';
import { cleanFeedback } from '../worker/src/policy.js';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const FILES = new Set(['/site/uninstall.html', '/site/uninstall.js', '/site/404.html']);
const env = {
  ASSETS: {
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      return FILES.has(path) ? new Response(`asset:${path}`) : new Response('missing', { status: 404 });
    },
  },
};

const body = async (url) => (await worker.fetch(new Request(url), env)).text();

test('the uninstall page is served, with its script', async () => {
  const page = await worker.fetch(new Request('https://killslop.app/uninstall'), env);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'asset:/site/uninstall.html');

  // Chrome appends the query the extension registered, and a trailing slash
  // is as likely as not; neither may change which file answers.
  assert.equal(await body('https://killslop.app/uninstall?v=1.0.0'), 'asset:/site/uninstall.html');
  assert.equal(await body('https://killslop.app/uninstall/'), 'asset:/site/uninstall.html');
  assert.equal(await body('https://killslop.app/site/uninstall.js'), 'asset:/site/uninstall.js');
});

test('the uninstall URL carries the version and nothing that identifies anyone', async () => {
  const source = await read('extension/src/background/service-worker.js');
  const call = source.match(/setUninstallURL\(([\s\S]*?)\);/);
  assert.ok(call, 'the service worker no longer registers an uninstall URL');

  assert.match(call[1], /killslop\.app\/uninstall/);
  assert.match(call[1], /getManifest\(\)\.version/, 'which build someone left on is the point of it');

  // The privacy policy promises two votes from one install cannot be linked to
  // each other. An id on this URL would join an uninstall to the votes made
  // from that browser, so none of these may appear in the call.
  for (const forbidden of [/voterId/, /installId/, /storage\.local/, /randomUUID/]) {
    assert.doesNotMatch(call[1], forbidden, `the uninstall URL must carry no identifier (${forbidden})`);
  }
});

test('the uninstall page reports under its own category and mints no id', async () => {
  const page = await read('worker/public/site/uninstall.js');
  assert.match(page, /\/api\/v1\/feedback/, 'it rides on the feedback endpoint');
  assert.match(page, /category: 'uninstall'/);

  for (const forbidden of [/voterId/, /installId/, /randomUUID/, /localStorage/, /document\.cookie/]) {
    assert.doesNotMatch(page, forbidden, `the uninstall page must not mint or send an id (${forbidden})`);
  }
});

test("'uninstall' is a category the feedback endpoint keeps, and near misses are not", () => {
  assert.equal(cleanFeedback({ message: 'x', category: 'uninstall' }).category, 'uninstall');
  for (const category of ['uninstalled', 'uninstall ', 'Uninstall', 'removal']) {
    assert.equal(cleanFeedback({ message: 'x', category }).category, 'other', category);
  }
});

test('the version the page forwards is one the endpoint would keep', async () => {
  // Two independent checks guard the same field: the page drops a mangled ?v=
  // rather than sending it, and the endpoint revalidates whatever arrives. If
  // one pattern is loosened without the other, this is where it shows up.
  const page = await read('worker/public/site/uninstall.js');
  const pattern = page.match(/\/\^\[\\w\.\+-\]\{1,32\}\$\//);
  assert.ok(pattern, 'the page no longer screens ?v= with the endpoint\'s own pattern');

  assert.equal(cleanFeedback({ message: 'x', version: '1.0.0' }).version, '1.0.0');
  assert.equal(cleanFeedback({ message: 'x', version: '<script>' }).version, null);
});
