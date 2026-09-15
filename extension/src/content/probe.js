/**
 * The probe queue. Lives in the content script because YouTube 403s any
 * InnerTube request carrying a `chrome-extension://` origin — only code running
 * at youtube.com origin can ask. See RESEARCH.md.
 *
 * Plain content script (no ES modules), so it publishes onto globalThis and
 * duplicates the small classification constants from core/innertube.js. The
 * classification *policy* still lives in the service worker; this file only
 * decides which request to send and trims the reply.
 */

(() => {
  'use strict';

  const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
  // Mask the response down to the badge, the owner and the disclosure header:
  // ~1 KB instead of ~1 MB. Paths verified live 2026-09-12.
  const NEXT_FIELDS = [
    'contents.twoColumnWatchNextResults.results.results.contents(' +
      'videoPrimaryInfoRenderer.badges,' +
      'videoSecondaryInfoRenderer.owner.videoOwnerRenderer.navigationEndpoint.browseEndpoint)',
    'engagementPanels.engagementPanelSectionListRenderer.content.' +
      'structuredDescriptionContentRenderer.items.howThisWasMadeSectionViewModel.bodyHeader',
  ].join(',');
  const NEXT_PATH =
    `/youtubei/v1/next?key=${INNERTUBE_KEY}&prettyPrint=false&fields=${encodeURIComponent(NEXT_FIELDS)}`;

  const CLIENTS = {
    WEB: { clientName: 'WEB', clientVersion: '2.20240401.00.00' },
    TVHTML5: { clientName: 'TVHTML5', clientVersion: '7.20240401.10.00' },
  };

  const HEADER_AI = new Set(['Made with AI']);
  const HEADER_NOT_AI = new Set(['Auto-dubbed', 'Captured with a camera']);

  /** In-flight probes allowed at once, and the minimum gap between starts. */
  const CONCURRENCY = 2;
  const MIN_INTERVAL_MS = 250;

  const queue = [];
  const queued = new Set();
  let active = 0;
  let lastStart = 0;
  let onResult = () => {};

  function findFirst(node, key, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 40) return undefined;
    if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    for (const value of Object.values(node)) {
      const hit = findFirst(value, key, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /** {ucid, handle} of the video's owner — often the only place we learn it. */
  function ownerOf(json) {
    const owner = findFirst(json, 'videoOwnerRenderer');
    const ep = owner?.navigationEndpoint?.browseEndpoint;
    const ucid = ep?.browseId;
    const base = ep?.canonicalBaseUrl;
    const handle = typeof base === 'string' && base.startsWith('/@') ? base.slice(1).toLowerCase() : null;
    if (!ucid && !handle) return null;
    return { ucid: /^UC[\w-]{22}$/.test(ucid ?? '') ? ucid : null, handle };
  }

  async function call(videoId, clientKey) {
    const res = await fetch(NEXT_PATH, {
      method: 'POST',
      credentials: 'omit', // never tie a probe to the user's YouTube identity
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: { client: { ...CLIENTS[clientKey], hl: 'en', gl: 'US' } },
        videoId,
      }),
    });
    if (!res.ok) throw new Error(`innertube ${clientKey} ${res.status}`);
    const json = await res.json();

    const vm = findFirst(json, 'howThisWasMadeSectionViewModel');
    const primary = findFirst(json, 'videoPrimaryInfoRenderer');
    return {
      owner: ownerOf(json),
      hasSection: vm !== undefined,
      hasPrimary: primary !== undefined,
      header: vm?.bodyHeader?.content ?? null,
      badges: (primary?.badges ?? []).map((b) => ({
        style: b?.metadataBadgeRenderer?.style ?? null,
        icon: b?.metadataBadgeRenderer?.icon?.iconType ?? null,
      })),
    };
  }

  async function probe(videoId) {
    let r;
    try {
      r = await call(videoId, 'WEB');
    } catch {
      return { verdict: 'unknown', source: 'error', header: null, owner: null };
    }
    const { owner, header } = r;
    if (!r.hasSection) return { verdict: 'clean', source: 'web', header: null, owner };

    // Structural, locale-proof: an AI disclosure carries an INFO/SIMPLE badge on
    // the primary info; an auto-dub carries the section but no badge.
    if (r.hasPrimary) {
      const badged = r.badges.some((b) => b.style === 'BADGE_STYLE_TYPE_SIMPLE' && b.icon === 'INFO');
      return { verdict: badged ? 'ai' : 'clean', source: 'web', header, owner };
    }
    // No primary info at all (mask drift?) — fall back to the forced-English header.
    return { verdict: HEADER_AI.has(header) ? 'ai' : 'clean', source: 'web-header', header, owner };
  }

  async function drain() {
    if (active >= CONCURRENCY || queue.length === 0) return;

    const gap = Date.now() - lastStart;
    if (gap < MIN_INTERVAL_MS) {
      setTimeout(drain, MIN_INTERVAL_MS - gap);
      return;
    }

    const item = queue.shift();
    queued.delete(item.videoId);
    active += 1;
    lastStart = Date.now();

    try {
      const result = await probe(item.videoId);
      if (result.verdict !== 'unknown') {
        onResult({ ...item, ...result });
      }
    } catch {
      /* network hiccup — the item simply stays unfiltered */
    } finally {
      active -= 1;
      drain();
    }
  }

  globalThis.KillSlopProbe = {
    enqueue(items) {
      for (const item of items) {
        if (queued.has(item.videoId)) continue;
        queued.add(item.videoId);
        queue.push(item);
      }
      drain();
    },
    /** Drop anything not listed — feeds scroll faster than we can probe. */
    retainOnly(videoIds) {
      const keep = new Set(videoIds);
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (!keep.has(queue[i].videoId)) {
          queued.delete(queue[i].videoId);
          queue.splice(i, 1);
        }
      }
    },
    setResultHandler(fn) {
      onResult = fn;
    },
    stats: () => ({ queued: queue.length, active }),
  };
})();
