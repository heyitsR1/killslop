/**
 * Classifier tests, run against fixtures captured from live InnerTube
 * (regenerate with `npm run fixtures`).
 *
 * The auto-dub cases are the point of this file. Treating every
 * `howThisWasMadeSectionViewModel` as an AI verdict flagged National Geographic
 * in a 208-video sample; these tests exist so that never ships again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  trimNext,
  ownerOf,
  classify,
  nextRequest,
  classifyCheap,
  classifyStructural,
  VERDICT,
  HEADER_AI,
  HEADER_NOT_AI,
} from '../extension/src/core/innertube.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/next.json', import.meta.url)));
const cheap = (name) => classifyCheap(trimNext(fx[name]));
const structural = (name) => classifyStructural(trimNext(fx[name]));

test('cheap path: AI disclosure is detected on TVHTML5', () => {
  assert.equal(trimNext(fx['ai-tv']).header, 'Made with AI');
  assert.equal(cheap('ai-tv'), VERDICT.AI);
});

test('cheap path: auto-dubbed is NOT treated as AI', () => {
  assert.equal(trimNext(fx['autodub-tv']).header, 'Auto-dubbed');
  assert.equal(cheap('autodub-tv'), VERDICT.CLEAN);
});

test('cheap path: an ordinary video has no disclosure section at all', () => {
  assert.equal(trimNext(fx['clean-tv']).hasSection, false);
  assert.equal(cheap('clean-tv'), VERDICT.CLEAN);
});

test('structural path: AI video carries an INFO/SIMPLE badge', () => {
  assert.equal(structural('ai-web'), VERDICT.AI);
});

test('structural path: auto-dubbed carries a section but no badge', () => {
  const trimmed = trimNext(fx['autodub-web']);
  assert.equal(trimmed.hasSection, true);
  assert.deepEqual(trimmed.badges, []);
  assert.equal(structural('autodub-web'), VERDICT.CLEAN);
});

test('structural path: ordinary video is clean', () => {
  assert.equal(structural('clean-web'), VERDICT.CLEAN);
});

test('structural path survives a non-English locale', () => {
  // Header text is localised and therefore useless; the badge shape is not.
  const trimmed = trimNext(fx['ai-web-nepali']);
  assert.notEqual(trimmed.header, 'Made with AI', 'fixture should be localised');
  assert.equal(classifyCheap(trimmed), 'escalate', 'localised text must not be graded directly');
  assert.equal(structural('ai-web-nepali'), VERDICT.AI);
});

test('unrecognised header escalates rather than guessing', () => {
  assert.equal(
    classifyCheap({ hasSection: true, header: 'Some New Disclosure Type' }),
    'escalate'
  );
});

test('a badge alone, with no disclosure section, is not an AI verdict', () => {
  // e.g. "Unlisted" or "Members only" on a video with no disclosure.
  assert.equal(
    classifyStructural({
      hasSection: false,
      badges: [{ style: 'BADGE_STYLE_TYPE_SIMPLE', icon: 'INFO' }],
    }),
    VERDICT.CLEAN
  );
});

test('a disclosure section with an unrelated badge shape is not AI', () => {
  assert.equal(
    classifyStructural({
      hasSection: true,
      badges: [{ style: 'BADGE_STYLE_TYPE_LIVE_NOW', icon: 'LIVE' }],
    }),
    VERDICT.CLEAN
  );
});

/**
 * probe.js re-declares these constants because content scripts can't import
 * modules. If the two copies drift, the extension and its tests disagree about
 * what counts as AI — so assert they are identical.
 */
test('content-script probe constants have not drifted from core', () => {
  const context = { globalThis: null };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    readFileSync(new URL('../extension/src/content/probe.js', import.meta.url), 'utf8'),
    context
  );

  const src = readFileSync(new URL('../extension/src/content/probe.js', import.meta.url), 'utf8');
  const setOf = (name) => {
    const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`));
    return new Set(
      m[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
    );
  };
  assert.deepEqual(setOf('HEADER_AI'), HEADER_AI);
  assert.deepEqual(setOf('HEADER_NOT_AI'), HEADER_NOT_AI);
  assert.ok(context.KillSlopProbe, 'probe.js should publish KillSlopProbe');
});

test('ownerOf reads the UC id and handle from videoOwnerRenderer', () => {
  const response = {
    contents: {
      results: [
        {
          videoOwnerRenderer: {
            navigationEndpoint: {
              browseEndpoint: { browseId: 'UCiC2wfbkgr8DU5uOQFz9OrQ', canonicalBaseUrl: '/@ChillChillJournal' },
            },
          },
        },
      ],
    },
  };
  assert.deepEqual(ownerOf(response), { ucid: 'UCiC2wfbkgr8DU5uOQFz9OrQ', handle: '@chillchilljournal' });
  assert.equal(trimNext(response).owner.ucid, 'UCiC2wfbkgr8DU5uOQFz9OrQ');
});

test('ownerOf tolerates a missing or malformed owner', () => {
  assert.equal(ownerOf({}), null);
  assert.deepEqual(
    ownerOf({ videoOwnerRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'nope' } } } }),
    { ucid: null, handle: null }
  );
});

test('classify: masked WEB response grades structurally when primary info is present', () => {
  assert.equal(classify(trimNext(fx['ai-web'])), VERDICT.AI);
  assert.equal(classify(trimNext(fx['autodub-web'])), VERDICT.CLEAN);
  assert.equal(classify(trimNext(fx['clean-web'])), VERDICT.CLEAN);
  assert.equal(classify(trimNext(fx['ai-web-nepali'])), VERDICT.AI, 'locale-proof');
});

test('classify: falls back to the forced-English header when primary info is absent', () => {
  assert.equal(classify(trimNext(fx['ai-tv'])), VERDICT.AI);
  assert.equal(classify(trimNext(fx['autodub-tv'])), VERDICT.CLEAN);
  assert.equal(classify(trimNext(fx['clean-tv'])), VERDICT.CLEAN);
  // An unrecognised header with no badge to consult is NOT an AI verdict.
  const odd = trimNext({ howThisWasMadeSectionViewModel: { bodyHeader: { content: 'Something new' } } });
  assert.equal(classify(odd), VERDICT.CLEAN);
});

test('the request is a masked WEB call', () => {
  const { url, init } = nextRequest('dQw4w9WgXcQ');
  assert.match(url, /fields=/);
  assert.match(decodeURIComponent(url), /videoPrimaryInfoRenderer\.badges/);
  assert.match(decodeURIComponent(url), /howThisWasMadeSectionViewModel/);
  assert.match(decodeURIComponent(url), /videoOwnerRenderer/);
  assert.equal(JSON.parse(init.body).context.client.clientName, 'WEB');
  assert.equal(init.credentials, 'omit');
});
