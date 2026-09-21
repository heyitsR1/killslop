/**
 * Build the Chrome Web Store upload: extension/ -> killslop-<version>.zip.
 *
 * The zip is built from the working tree, not from git, because the version
 * that matters is the one on disk that was just tested. It is named from
 * manifest.json so the file on disk can never disagree with the version the
 * store reads out of it.
 *
 * -X drops the resource forks and other macOS extended attributes that would
 * otherwise ride along as __MACOSX entries and show up as junk files in the
 * uploaded bundle. .DS_Store is excluded for the same reason.
 *
 * Usage: npm run package
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(root, 'extension');

const { version, name } = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
const out = join(root, `killslop-${version}.zip`);

// zip appends to an existing archive, so a stale file would quietly keep files
// that have since been deleted from the source tree.
rmSync(out, { force: true });

execFileSync('zip', ['-r', '-X', '-q', out, '.', '-x', '.DS_Store', '-x', '*/.DS_Store'], {
  cwd: extension,
  stdio: 'inherit',
});

const files = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' })
  .split('\n')
  .filter((line) => line && !line.endsWith('/'));

console.log(`${out}`);
console.log(`  ${name} ${version}`);
console.log(`  ${files.length} files, ${(statSync(out).size / 1024).toFixed(0)} KB`);
