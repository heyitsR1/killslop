import { DEFAULTS, PLATFORMS, getSettings, setSettings } from '../core/settings.js';

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
    settings = await setSettings(write(next));
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
      settings = await setSettings({ platforms: { ...settings.platforms, [p.id]: next } });
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

/** Last counts seen, so the tiles have something true to show immediately. */
const STATS_CACHE = 'statsCache';

function paintStats({ session, videos, channels, marks }) {
  $('stat-session').textContent = session ?? 0;
  $('stat-videos').textContent = videos ?? 0;
  $('stat-channels').textContent = channels ?? 0;
  $('marks-desc').textContent = marks || 'Nothing marked yet';
}

/**
 * The counts live in IndexedDB, which only the background can reach, so these
 * are the one thing the popup cannot read for itself. They are therefore also
 * the one thing it must not wait on: last known values paint at once, the
 * worker catches them up, and the two calls go together rather than in turn.
 */
async function refreshStats() {
  const cached = await chrome.storage.local
    .get(STATS_CACHE)
    .then((r) => r[STATS_CACHE])
    .catch(() => null);
  if (cached) paintStats(cached);

  const [s, overrides] = await Promise.all([send('getStats'), send('listOverrides')]);
  if (!s) return;

  const marks = overrides || [];
  const slop = marks.filter((m) => m.slop).length;
  const clean = marks.length - slop;
  const fresh = {
    session: s.hiddenThisSession ?? 0,
    videos: s.videos ?? 0,
    channels: s.channels ?? 0,
    marks: marks.length
      ? [slop && `${slop} AI slop`, clean && `${clean} not slop`].filter(Boolean).join(' · ')
      : 'Nothing marked yet',
  };
  paintStats(fresh);
  chrome.storage.local.set({ [STATS_CACHE]: fresh }).catch(() => {});
}

/* ------------------------------------------------------------------- init */

(async () => {
  /**
   * Read settings straight from storage instead of asking the background.
   *
   * Measured 2026-09-18: the first sendMessage of a popup's life cost 394ms,
   * because it has to start the service worker and load everything the worker
   * imports; the same settings read directly cost 2ms. Nothing the first paint
   * needs lives in the worker, so nothing the first paint needs should wait
   * for it. The worker is now woken only for the counts, which are allowed to
   * arrive late.
   *
   * Falling back to defaults rather than returning early matters too: this
   * used to bail out after the markup had rendered, leaving a popup that
   * looked fine with every control dead.
   */
  settings = await getSettings().catch(() => ({ ...DEFAULTS, unreachable: true }));

  renderPlatforms();

  $('master').addEventListener('click', async () => {
    const next = $('master').getAttribute('aria-checked') !== 'true';
    paintSwitch($('master'), next); // flip now; the write is fast but not free
    settings = await setSettings({ enabled: next });
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
    settings = await setSettings({ action: value });
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
