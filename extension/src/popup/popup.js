import { DEFAULTS, PLATFORMS } from '../core/settings.js';

const send = (type, payload = {}) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res?.result ?? null);
    });
  });

const $ = (id) => document.getElementById(id);
let settings = null;

/* --------------------------------------------------------------- switches */

const TOGGLES = [
  'useDisclosure',
  'useChannelInference',
  'useCommunity',
  'trustVotes',
  'shareReports',
  'useWritingCheck',
];

function paintSwitch(el, on) {
  el.setAttribute('aria-checked', String(Boolean(on)));
}

function wireSwitch(el, read, write) {
  el.addEventListener('click', async () => {
    const next = el.getAttribute('aria-checked') !== 'true';
    paintSwitch(el, next);
    settings = await send('setSettings', { patch: write(next) });
    paint();
  });
  paintSwitch(el, read());
}

/* -------------------------------------------------------------- platforms */

/** Live platforms get a switch each; planned ones share one line underneath. */
function renderPlatforms() {
  const host = $('platforms');
  host.replaceChildren();
  const all = Object.values(PLATFORMS);

  for (const p of all.filter((x) => x.status !== 'planned')) {
    const row = document.createElement('div');
    row.className = 'row';

    const body = document.createElement('div');
    body.className = 'row__body';
    const title = document.createElement('div');
    title.className = 'row__title';
    title.textContent = p.label;
    body.appendChild(title);
    row.appendChild(body);

    const sw = document.createElement('button');
    sw.className = 'switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', p.label);
    paintSwitch(sw, settings.platforms[p.id]);
    sw.addEventListener('click', async () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      paintSwitch(sw, next);
      settings = await send('setSettings', {
        patch: { platforms: { ...settings.platforms, [p.id]: next } },
      });
      paint();
    });
    row.appendChild(sw);
    host.appendChild(row);
  }

  const planned = all.filter((x) => x.status === 'planned').map((x) => x.label);
  if (planned.length) {
    const next = document.createElement('p');
    next.className = 'row__desc platforms__next';
    next.textContent = `Next: ${planned.join(', ')}`;
    host.appendChild(next);
  }
}

/* ------------------------------------------------------------------ paint */

function paint() {
  paintSwitch($('master'), settings.enabled);
  $('status').textContent = settings.enabled ? 'Filtering' : 'Paused';
  $('status-dot').classList.toggle('dot--off', !settings.enabled);

  for (const key of TOGGLES) paintSwitch($(key), settings[key]);

  for (const btn of $('action').querySelectorAll('button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.value === settings.action));
  }

  // Say exactly what still leaves the browser: marks are shared whenever
  // "Contribute reports" is on, and YouTube's label check always asks YouTube.
  // X's label is read from the page itself and sends nothing.
  //
  // The writing check is named first when it is on, because it is the only
  // setting that can send the words of a post rather than a hash of them.
  $('privacy').textContent = settings.unreachable
    ? "KillSlop's background page is not responding, so these are the default settings and changes will not save. Reload the extension at chrome://extensions."
    : settings.useWritingCheck
      ? 'The writing check asks by hash first, and sends the text itself only for a post nothing else could place and nobody has had checked before.'
      : settings.useCommunity
      ? 'Lookups are sent as a 4-character hash prefix, so the list never learns what you watched or read.'
      : settings.shareReports
        ? 'Community list is off, so nothing is looked up in it. Your marks are still shared; turn off Contribute reports to keep them here.'
        : "Community list and sharing are off. Only YouTube's label check sends a request, to YouTube, without your cookies.";
}

async function refreshStats() {
  const s = await send('getStats');
  if (!s) return;
  $('stat-session').textContent = s.hiddenThisSession ?? 0;
  $('stat-videos').textContent = s.videos ?? 0;
  $('stat-channels').textContent = s.channels ?? 0;

  const marks = (await send('listOverrides')) || [];
  const slop = marks.filter((m) => m.slop).length;
  const clean = marks.length - slop;
  $('marks-desc').textContent = marks.length
    ? [slop && `${slop} AI slop`, clean && `${clean} not slop`].filter(Boolean).join(' · ')
    : 'Nothing marked yet';
}

/* ------------------------------------------------------------------- init */

(async () => {
  /**
   * A popup that cannot reach the background must still open and still work.
   * This used to return early when the background did not answer, which left
   * the markup on screen with nothing wired to it: the popup looked fine and
   * every switch was dead, which is indistinguishable from the extension being
   * broken. Fall back to the defaults, wire everything, and say so.
   */
  const live = await send('getSettings');
  settings = live ?? { ...DEFAULTS, unreachable: true };

  renderPlatforms();

  $('master').addEventListener('click', async () => {
    const next = $('master').getAttribute('aria-checked') !== 'true';
    settings = await send('setSettings', { patch: { enabled: next } });
    paint();
  });

  for (const key of TOGGLES) {
    wireSwitch(
      $(key),
      () => settings[key],
      (next) => ({ [key]: next })
    );
  }

  // Opened from a YouTube, X or LinkedIn tab, the feedback page offers to
  // attach that page, which is what a "wrong call" report needs. The URL is
  // readable because those sites are in host_permissions; no other tab's
  // address is ever read.
  $('feedback').addEventListener('click', async () => {
    const url = new URL(chrome.runtime.getURL('src/feedback/feedback.html'));
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && /^https:\/\/((www\.|m\.)?youtube\.com|x\.com|www\.linkedin\.com)\//.test(tab.url)) {
      url.searchParams.set('from', tab.url);
    }
    chrome.tabs.create({ url: url.href });
  });

  $('action').addEventListener('click', async (ev) => {
    const value = ev.target?.dataset?.value;
    if (!value) return;
    settings = await send('setSettings', { patch: { action: value } });
    paint();
  });

  $('marks').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/marks/marks.html') });
  });

  $('reset').addEventListener('click', async () => {
    await send('clearData');
    await refreshStats();
  });

  paint();
  refreshStats();
})();
