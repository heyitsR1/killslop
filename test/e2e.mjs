/**
 * Loads the unpacked extension into a real Chrome and checks that it actually
 * hides slop on live YouTube pages. Run: npm run test:e2e
 *
 * Not part of `npm test` — it needs Chrome, the network, and ~a minute.
 */
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stable Google Chrome removed --load-extension in 137, so e2e runs against
// Chrome for Testing:  npx @puppeteer/browsers install chrome@latest --path ./.browsers
const CHROME =
  process.env.KILLSLOP_CHROME ||
  fileURLToPath(
    new URL(
      '../.browsers/chrome/mac_arm-153.0.8009.0/chrome-mac-arm64/' +
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      import.meta.url
    )
  );
const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const SHOT_DIR = process.env.KILLSLOP_SHOTS || tmpdir();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  // Windowed by default; KILLSLOP_HEADLESS=1 runs it off-screen, which current
  // Chrome for Testing handles, service worker included.
  headless: process.env.KILLSLOP_HEADLESS === '1',
  userDataDir: mkdtempSync(join(tmpdir(), 'killslop-')),
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
  ],
});

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  // --- the service worker must actually boot -------------------------------
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker', {
    timeout: 15000,
  });
  const worker = await target.worker();
  check('service worker booted', Boolean(worker));

  const extensionId = new URL(target.url()).host;
  console.log(`  extension id: ${extensionId}\n`);

  // --- verdict path, driven the way the product actually works ------------
  // The probe fetch can only be issued from a youtube.com origin, so we open
  // real watch pages and let the content script do it, then read the settled
  // verdict back out of the worker's cache.
  console.log('verdict engine (real watch pages → worker cache):');
  const harness = await browser.newPage();
  await harness.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, {
    waitUntil: 'domcontentloaded',
  });

  // Nothing a test does — a click, a measured tally — may reach the live list.
  await harness.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: 'setSettings', patch: { shareReports: false } }, resolve)
      )
  );

  const ask = (items) =>
    harness.evaluate(
      (items) =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'resolve', items }, (res) => resolve(res?.result));
        }),
      items
    );

  const WANT = {
    '9kzE8isXlQY': { slop: true, why: 'chill chill journal — labelled AI' },
    '_Ak-mOGI_B4': { slop: true, why: 'AI Music Atlas — labelled AI' },
    'aDoanNM7O_s': { slop: false, why: 'National Geographic — AUTO-DUBBED, must survive' },
    'XWxKXpwwvz8': { slop: false, why: 'Motiversity — auto-dubbed, must survive' },
    'dQw4w9WgXcQ': { slop: false, why: 'Rick Astley — human' },
  };
  const ids = Object.keys(WANT);

  const cold = await ask(ids.map((videoId) => ({ videoId })));
  check(
    'unseen videos report pending rather than guessing',
    ids.every((id) => cold.verdicts[id]?.pending === true),
    `${ids.filter((id) => cold.verdicts[id]?.pending).length}/${ids.length} pending`
  );
  check('worker asks the content script to probe them', cold.probe.length === ids.length,
    `${cold.probe.length} probe requests`);

  const watch = await browser.newPage();
  for (const id of ids) {
    await watch.goto(`https://www.youtube.com/watch?v=${id}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await sleep(6000); // content script probes the watched video
  }
  await watch.close();

  // Probes are asynchronous; give stragglers (the first page load of a fresh
  // profile is the slow one) up to 20 s more to land before judging.
  let warm;
  for (let i = 0; i < 10; i += 1) {
    warm = await ask(ids.map((videoId) => ({ videoId })));
    if (ids.every((id) => warm.verdicts[id] && !warm.verdicts[id].pending)) break;
    await sleep(2000);
  }
  for (const id of ids) {
    const got = warm.verdicts[id];
    check(
      `${id} slop=${WANT[id].slop}`,
      got && got.slop === WANT[id].slop && !got.pending,
      `got slop=${got?.slop} reason=${got?.reason} — ${WANT[id].why}`
    );
  }
  check('settled verdicts are served from cache, not re-probed', warm.probe.length === 0,
    `${warm.probe.length} re-probes`);

  // --- the "Mark AI" button ------------------------------------------------
  console.log('\nvote button (watch page and Shorts):');
  const HUMAN = 'dQw4w9WgXcQ';
  const vp = await browser.newPage();
  await vp.setViewport({ width: 1440, height: 900 });
  await vp.goto(`https://www.youtube.com/watch?v=${HUMAN}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  const voteBtn = await vp
    .waitForSelector('#top-level-buttons-computed .killslop-vote', { timeout: 30000 })
    .catch(() => null);
  check('button is in the like/dislike row', Boolean(voteBtn));

  if (voteBtn) {
    await sleep(3000); // let the watched video's probe settle
    const readVote = () =>
      vp.evaluate(() => {
        const b = document.querySelector('.killslop-vote');
        return {
          state: b?.dataset.state,
          text: b?.textContent.trim(),
          prev: b?.previousElementSibling?.tagName.toLowerCase(),
          toast: document.querySelector('.killslop-toast')?.textContent || '',
        };
      });
    const before = await readVote();
    check('reads "AI SLOP", grey, on a human video', before.state === 'none' && before.text === 'AI SLOP',
      `${before.state} / ${before.text}`);
    check('sits right after like/dislike', before.prev === 'segmented-like-dislike-button-view-model',
      before.prev);

    await vp.click('.killslop-vote');
    await sleep(800);
    const marked = await readVote();
    check('one click turns it solid red', marked.state === 'mine', marked.state);
    check('toast offers channel + undo', /Hide whole channel/.test(marked.toast) && /Undo/.test(marked.toast),
      marked.toast);
    const afterMark = (await ask([{ videoId: HUMAN }])).verdicts[HUMAN];
    check('worker records it as your override', afterMark?.slop === true && afterMark?.reason === 'you',
      JSON.stringify(afterMark));
    await vp.screenshot({ path: join(SHOT_DIR, 'killslop-vote-marked.png') });

    await vp.evaluate(() =>
      [...document.querySelectorAll('.killslop-toast__btn')].find((b) => b.textContent === 'Undo')?.click()
    );
    await sleep(1500);
    const undone = await readVote();
    const afterUndo = (await ask([{ videoId: HUMAN }])).verdicts[HUMAN];
    check('Undo puts it back', undone.state === 'none', undone.state);
    check('worker falls back to the cached verdict', afterUndo?.reason !== 'you' && afterUndo?.slop === false,
      JSON.stringify(afterUndo));
  }

  const SLOP = '9kzE8isXlQY'; // labelled AI by its creator, probed above
  await vp.goto(`https://www.youtube.com/watch?v=${SLOP}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await vp.waitForSelector('#top-level-buttons-computed .killslop-vote', { timeout: 30000 }).catch(() => null);
  await sleep(3000);
  const flagged = await vp.evaluate(() => {
    const b = document.querySelector('.killslop-vote');
    return { state: b?.dataset.state, title: b?.title };
  });
  check('a labelled video gets the red tint, with its reason', flagged.state === 'flagged' && /Labelled/.test(flagged.title || ''),
    `${flagged.state} / ${flagged.title}`);

  await vp.goto('https://www.youtube.com/shorts/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const shortsBtn = await vp
    .waitForSelector('reel-action-bar-view-model .killslop-vote--shorts', { timeout: 30000 })
    .catch(() => null);
  check('Shorts get the button in the action bar', Boolean(shortsBtn));
  await sleep(1500);
  await vp.screenshot({ path: join(SHOT_DIR, 'killslop-vote-shorts.png') });
  await vp.close();

  // --- a real search feed --------------------------------------------------
  console.log('\nlive feed (search "ai generated relaxing music"):');
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('https://www.youtube.com/results?search_query=ai+generated+relaxing+music', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  // Dismiss the consent wall if this fresh profile gets one.
  await sleep(2000);
  const consent = await page.$('button[aria-label*="Reject"], button[aria-label*="reject"]');
  if (consent) {
    await consent.click();
    await sleep(3000);
  }

  await page.waitForSelector('ytd-video-renderer', { timeout: 30000 });
  // Give the probe queue time to work through the visible tiles.
  await sleep(35000);

  const feed = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('ytd-video-renderer')];
    const read = (el) => ({
      id: el.getAttribute('data-killslop-id'),
      state: el.getAttribute('data-killslop'),
      title: el.querySelector('#video-title')?.textContent?.trim().slice(0, 58) || '',
      channel: el.querySelector('ytd-channel-name a')?.textContent?.trim() || '',
    });
    return {
      total: tiles.length,
      parsed: tiles.filter((t) => t.hasAttribute('data-killslop-id')).length,
      hidden: tiles.filter((t) => t.getAttribute('data-killslop') === 'hidden').map(read),
      hiddenAnywhere: document.querySelectorAll('[data-killslop="hidden"]').length,
      cards: document.querySelectorAll('.killslop-card').length,
    };
  });

  check('tiles were parsed for video ids', feed.parsed > 0, `${feed.parsed}/${feed.total}`);
  check('slop was hidden on a live feed', feed.hidden.length > 0, `${feed.hidden.length} hidden`);
  check('every hidden tile got a restore card', feed.cards === feed.hiddenAnywhere,
    `${feed.cards} cards / ${feed.hiddenAnywhere} hidden`);

  for (const h of feed.hidden) {
    console.log(`      hidden: ${h.channel} — ${h.title}`);
  }

  await page.screenshot({ path: join(SHOT_DIR, 'killslop-feed.png') });

  // --- popup renders -------------------------------------------------------
  console.log('\npopup:');
  const popup = harness;
  await popup.setViewport({ width: 340, height: 700 });
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1500);
  const popupState = await popup.evaluate(() => ({
    platformRows: document.querySelectorAll('#platforms .row').length,
    switches: document.querySelectorAll('.switch').length,
    master: document.getElementById('master')?.getAttribute('aria-checked'),
    status: document.getElementById('status')?.textContent,
    videosKnown: document.getElementById('stat-videos')?.textContent,
  }));
  // One switch per live platform; planned ones share a single "Next:" line.
  check('platform rows rendered', popupState.platformRows >= 1, `${popupState.platformRows}`);
  check('master switch is on', popupState.master === 'true');
  check('cache reports videos seen', Number(popupState.videosKnown) > 0, `${popupState.videosKnown} known`);
  await popup.screenshot({ path: join(SHOT_DIR, 'killslop-popup.png') });

  console.log(`\nscreenshots → ${SHOT_DIR}`);
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
