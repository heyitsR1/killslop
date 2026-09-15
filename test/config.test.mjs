/** The committed example config must not drift from the deploy config. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../worker/${name}`, import.meta.url), 'utf8').catch(() => null);
const withoutDatabaseId = (toml) => toml.replace(/^database_id = .*$/m, 'database_id = <id>');

test('wrangler.example.toml matches wrangler.toml apart from the database id', async (t) => {
  const [example, real] = await Promise.all([read('wrangler.example.toml'), read('wrangler.toml')]);
  assert.ok(example, 'worker/wrangler.example.toml is committed');
  if (!real) {
    t.skip('no local worker/wrangler.toml; contributors copy the example');
    return;
  }
  assert.equal(withoutDatabaseId(real), withoutDatabaseId(example));
});
