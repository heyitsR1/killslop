/** User settings, backed by chrome.storage.sync so they follow the profile. */

export const PLATFORMS = {
  youtube: { id: 'youtube', label: 'YouTube', status: 'live' },
  x: { id: 'x', label: 'X', status: 'live' },
  linkedin: { id: 'linkedin', label: 'LinkedIn', status: 'live' },
  reddit: { id: 'reddit', label: 'Reddit', status: 'planned' },
  pinterest: { id: 'pinterest', label: 'Pinterest', status: 'planned' },
  google: { id: 'google', label: 'Google Images', status: 'planned' },
  spotify: { id: 'spotify', label: 'Spotify', status: 'planned' },
};

export const DEFAULTS = {
  enabled: true,
  platforms: { youtube: true, x: true, linkedin: true },

  /** 'hide' removes the tile; 'dim' greys it out with a label. */
  action: 'hide',

  /** Trust the platform's own AI label: YouTube's disclosure, X's AI media mark. */
  useDisclosure: true,

  /**
   * Infer from the channel. The research is unambiguous that this is where the
   * coverage is: slop farms label ~100% of uploads, real channels label 0%.
   */
  useChannelInference: true,
  channelMinSamples: 5,
  channelThreshold: 0.6,

  /** Community-reported list. */
  useCommunity: true,
  /**
   * Also act on human votes, not just on channels other clients *measured*
   * (their own uploads carry YouTube's AI label). Off = measurement only,
   * which cannot produce an opinion-based false positive.
   */
  trustVotes: true,
  /** Contribute your own reports back. Off means read-only. */
  shareReports: true,
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(null);
  return {
    ...DEFAULTS,
    ...stored,
    platforms: { ...DEFAULTS.platforms, ...(stored.platforms || {}) },
  };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
  return getSettings();
}

export function onSettingsChanged(fn) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') fn(changes);
  });
}
