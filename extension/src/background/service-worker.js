/** Message router. All network and storage lives here, not in the content script. */

import * as verdict from '../core/verdict.js';
import * as store from '../core/store.js';
import * as community from '../core/community.js';
import { getSettings, setSettings } from '../core/settings.js';

/** Every page a content script runs on; the hosts in the manifest. */
const CONTENT_TABS = ['*://*.youtube.com/*', 'https://x.com/*', 'https://www.linkedin.com/*'];

/**
 * Session counter shown in the popup, reset on browser restart. Tracked as a
 * set of ids rather than a running total: a feed is re-resolved on every scroll
 * and navigation, so incrementing per call counts the same tile many times.
 */
const hiddenThisSession = new Set();

verdict.onResolved((update) => {
  // Push late-resolving results to every tab we run in. Ids are namespaced
  // per platform, so a tab simply finds nothing of its own in another's.
  chrome.tabs.query({ url: CONTENT_TABS }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'killslop:update', update }).catch(() => {});
    }
  });
});

const handlers = {
  async resolve({ items, platform = 'youtube' }) {
    // `check` is as load-bearing as `probe`, and for the mirror-image reason:
    // it is how tier 4 reaches the page, which is the only side that can read a
    // post's text. content/feed.js acts on res.check. Dropping it here left the
    // writing check dead on X and LinkedIn — every candidate stayed 'pending'
    // for ever, nothing was ever sent, and no error was raised anywhere. On
    // LinkedIn that is the only hiding tier there is, so the platform hid
    // nothing at all. Keep the three fields together.
    const { verdicts, probe, check } = await verdict.resolveBatch(items, platform);
    for (const [videoId, v] of Object.entries(verdicts)) {
      if (v.slop) hiddenThisSession.add(videoId);
    }
    return { verdicts, probe, check };
  },

  /**
   * A probe result from a content script. The fetch has to happen there —
   * YouTube 403s InnerTube requests carrying an extension origin.
   */
  async probeResult({ videoId, channelId, verdict: v, source, header, owner }) {
    const res = await verdict.recordProbe({ videoId, channelId, verdict: v, source, header, owner });
    if (res.slop) hiddenThisSession.add(videoId);
    return res;
  },

  /** What the X content script read off X's own post data. */
  async observe({ posts }) {
    const res = await verdict.recordObservations(Array.isArray(posts) ? posts.slice(0, 500) : []);
    for (const id of res.ai || []) hiddenThisSession.add(id);
    return { ok: res.ok };
  },

  /**
   * Posts the other tiers could not place, checked by their writing. The page
   * has already dropped everything its local gate found unremarkable; the cap
   * is a bound on what one page can ask for at once.
   */
  async checkWriting({ posts, platform }) {
    const res = await verdict.recordWriting(Array.isArray(posts) ? posts.slice(0, 40) : [], platform);
    for (const [id, v] of Object.entries(res.verdicts)) {
      if (v.slop) hiddenThisSession.add(id);
    }
    return res;
  },

  async override({ id, kind, slop, meta }) {
    const settings = await getSettings();
    return verdict.submitOverride({ id, kind, slop, meta, share: settings.shareReports });
  },

  async undoOverride({ id }) {
    const settings = await getSettings();
    return verdict.removeOverride(id, { share: settings.shareReports });
  },

  async listOverrides() {
    return store.listOverrides();
  },

  async getSettings() {
    return getSettings();
  },

  async setSettings({ patch }) {
    return setSettings(patch);
  },

  async getStats() {
    const s = await store.stats();
    return { ...s, hiddenThisSession: hiddenThisSession.size };
  },

  async sendFeedback({ category, message, email }) {
    return community.feedback({ category, message, email, version: chrome.runtime.getManifest().version });
  },

  async clearData() {
    await store.clearAll();
    hiddenThisSession.clear();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the channel open for the async response
});

/**
 * A welcome page, once, on a fresh install. Never on an update or a reload:
 * a tab that reappears every time the extension updates is a nuisance, and
 * that is what `reason` distinguishes.
 *
 * This waited until killslop.app existed. Opening a domain we did not control
 * on every install would have been a gift to whoever registered it.
 */
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: 'https://killslop.app/welcome' });
});

/**
 * Where Chrome sends people when they remove KillSlop.
 *
 * Set at top level rather than inside onInstalled: MV3 evicts this worker
 * constantly, so top level runs on every wake and the version stays current
 * across an update, which an install-only listener would miss.
 *
 * The version is the only thing it carries. There is a random install id in
 * core/community.js, and it is deliberately not sent: the privacy policy
 * promises that two votes from one install cannot be linked to each other, and
 * putting that id on this URL would join an uninstall to the votes made from
 * the same browser. Which build someone left on is enough to act on.
 */
chrome.runtime.setUninstallURL(
  `https://killslop.app/uninstall?v=${encodeURIComponent(chrome.runtime.getManifest().version)}`
);
