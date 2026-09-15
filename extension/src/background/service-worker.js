/** Message router. All network and storage lives here, not in the content script. */

import * as verdict from '../core/verdict.js';
import * as store from '../core/store.js';
import * as community from '../core/community.js';
import { getSettings, setSettings } from '../core/settings.js';

/**
 * Session counter shown in the popup, reset on browser restart. Tracked as a
 * set of ids rather than a running total: a feed is re-resolved on every scroll
 * and navigation, so incrementing per call counts the same tile many times.
 */
const hiddenThisSession = new Set();

verdict.onResolved((update) => {
  // Push late-resolving probe results to every YouTube tab.
  chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'killslop:update', update }).catch(() => {});
    }
  });
});

const handlers = {
  async resolve({ items }) {
    const { verdicts, probe } = await verdict.resolveBatch(items);
    for (const [videoId, v] of Object.entries(verdicts)) {
      if (v.slop) hiddenThisSession.add(videoId);
    }
    return { verdicts, probe };
  },

  /**
   * A probe result from a content script. The fetch has to happen there —
   * YouTube 403s InnerTube requests carrying an extension origin.
   */
  async probeResult({ videoId, channelId, verdict: v, source, header }) {
    const res = await verdict.recordProbe({ videoId, channelId, verdict: v, source, header });
    if (res.slop) hiddenThisSession.add(videoId);
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

// No welcome tab on install: we do not own a website yet, and opening a domain
// we don't control on every install would be a gift to whoever does.
