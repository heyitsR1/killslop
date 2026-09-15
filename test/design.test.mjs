/** The extension and the worker ship one design system, and no emojis. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root));

test('the extension and the worker carry identical base.css and fonts', async () => {
  const pairs = [
    ['extension/src/ui/base.css', 'worker/public/ui/base.css'],
    ['extension/src/fonts/Geist-Variable.woff2', 'worker/public/fonts/Geist-Variable.woff2'],
    ['extension/src/fonts/GeistMono-Variable.woff2', 'worker/public/fonts/GeistMono-Variable.woff2'],
    ['extension/src/fonts/OFL.txt', 'worker/public/fonts/OFL.txt'],
  ];
  for (const [a, b] of pairs) {
    const [x, y] = await Promise.all([read(a), read(b)]);
    assert.ok(x.equals(y), `${a} and ${b} have drifted apart; copy one over the other`);
  }
});

// Pictographs, minus the three legal signs a footer may need.
const EMOJI = /(?![©®™])[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;

test('no emojis in code, UI or docs', async () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root })
    .toString()
    .split('\n')
    // Fixtures are captured YouTube responses; creators' titles are theirs.
    .filter((f) => /\.(js|mjs|css|html|md|json|yml|toml|sql|svg|txt)$/.test(f) && !f.startsWith('test/fixtures/'));
  for (const file of files) {
    const text = await read(file).then(String, () => '');
    const hit = text.split('\n').findIndex((line) => EMOJI.test(line));
    assert.equal(hit, -1, `${file}:${hit + 1} contains an emoji`);
  }
});
