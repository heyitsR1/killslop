/**
 * InnerTube request building and AI-disclosure classification.
 *
 * NOTE ON WHERE THE FETCH HAPPENS — this is not a style choice.
 * YouTube answers this endpoint with 403 "Sorry..." when the request carries a
 * `chrome-extension://` origin, so the background service worker CANNOT make
 * it. The fetch must be issued from the content script, which runs at
 * youtube.com origin. This module therefore only builds requests and grades
 * responses; the caller supplies the network. See RESEARCH.md.
 *
 * The classification rules, all of which came out of measurement:
 *
 *  1. Feed responses (search / browse / recommendations) carry NO AI signal.
 *     The disclosure exists only on the `next` (watch) endpoint, so there is no
 *     way around one request per video.
 *
 *  2. `howThisWasMadeSectionViewModel` is NOT an "is AI" flag. It is a generic
 *     container that also carries "Auto-dubbed", i.e. machine-translated audio.
 *     Treating its presence as an AI verdict flags National Geographic,
 *     Veritasium and Motiversity — 14% of a 208-video sample.
 *
 *  3. The body text is localised ("AI प्रयोग गरी बनाइएको", "Creado con IA"), so
 *     we force hl=en on our own request rather than parsing the user's locale,
 *     and we grade structurally first: an AI disclosure puts an INFO badge on
 *     `videoPrimaryInfoRenderer`; an auto-dub puts none.
 *
 *  4. A `fields` mask (measured 2026-09-12) trims the WEB response from ~1 MB
 *     to ~1 KB while keeping the badge, the disclosure header and the owner.
 *     That made the old TVHTML5-then-escalate-to-WEB dance unnecessary: one
 *     masked WEB request carries every signal we grade on.
 */

const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

/**
 * Everything we grade on, and nothing else. Paths verified live 2026-09-12:
 * badges on the primary info, owner on the secondary info, and the
 * "how this was made" section inside the description engagement panel.
 */
export const NEXT_FIELDS = [
  'contents.twoColumnWatchNextResults.results.results.contents(' +
    'videoPrimaryInfoRenderer.badges,' +
    'videoSecondaryInfoRenderer.owner.videoOwnerRenderer.navigationEndpoint.browseEndpoint)',
  'engagementPanels.engagementPanelSectionListRenderer.content.' +
    'structuredDescriptionContentRenderer.items.howThisWasMadeSectionViewModel.bodyHeader',
].join(',');

/** Relative on purpose: it must resolve against youtube.com, not the extension. */
export const NEXT_PATH =
  `/youtubei/v1/next?key=${INNERTUBE_KEY}&prettyPrint=false&fields=${encodeURIComponent(NEXT_FIELDS)}`;

export const CLIENTS = {
  WEB: { clientName: 'WEB', clientVersion: '2.20240401.00.00' },
  /** Kept for the live harness and as a fallback; lacks the structural badge. */
  TVHTML5: { clientName: 'TVHTML5', clientVersion: '7.20240401.10.00' },
};

export const VERDICT = { AI: 'ai', CLEAN: 'clean', UNKNOWN: 'unknown' };

/** Forced-English `bodyHeader` values we have positively identified. */
export const HEADER_AI = new Set(['Made with AI']);
export const HEADER_NOT_AI = new Set([
  'Auto-dubbed',            // machine-translated audio. Not AI-generated content.
  'Captured with a camera', // C2PA provenance — the opposite of slop.
]);

export function nextRequest(videoId, clientKey = 'WEB') {
  return {
    url: NEXT_PATH,
    init: {
      method: 'POST',
      credentials: 'omit', // never tie a probe to the user's YouTube identity
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: { client: { ...CLIENTS[clientKey], hl: 'en', gl: 'US' } },
        videoId,
      }),
    },
  };
}

/** Depth-limited search for the first value under `key`. */
export function findFirst(node, key, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return undefined;
  if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
  for (const value of Object.values(node)) {
    const hit = findFirst(value, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Reduce a ~210KB-1MB response to the handful of fields we grade on, so the
 * content script can post it across the message boundary cheaply.
 */
/**
 * The video's owner, as {ucid, handle}. Both TVHTML5 and WEB responses carry a
 * `videoOwnerRenderer` whose browse endpoint has the UC id and the canonical
 * `/@handle` URL. Feed tiles in the watch sidebar link only to the video, so
 * this is often the ONLY place we learn which channel a video belongs to.
 */
export function ownerOf(response) {
  const owner = findFirst(response, 'videoOwnerRenderer');
  const ep = owner?.navigationEndpoint?.browseEndpoint;
  const ucid = ep?.browseId;
  const base = ep?.canonicalBaseUrl;
  const handle = typeof base === 'string' && base.startsWith('/@') ? base.slice(1).toLowerCase() : null;
  if (!ucid && !handle) return null;
  return { ucid: /^UC[\w-]{22}$/.test(ucid ?? '') ? ucid : null, handle };
}

export function trimNext(response) {
  const vm = findFirst(response, 'howThisWasMadeSectionViewModel');
  const primary = findFirst(response, 'videoPrimaryInfoRenderer');
  const out = { owner: ownerOf(response) };
  if (vm) out.header = vm.bodyHeader?.content ?? null;
  if (primary) {
    out.badges = (primary.badges ?? []).map((b) => ({
      style: b?.metadataBadgeRenderer?.style ?? null,
      icon: b?.metadataBadgeRenderer?.icon?.iconType ?? null,
    }));
    out.hasPrimary = true;
  }
  out.hasSection = vm !== undefined;
  return out;
}

/**
 * Grade a trimmed TVHTML5 response.
 * @returns {'ai'|'clean'|'escalate'}
 */
export function classifyCheap(trimmed) {
  if (!trimmed?.hasSection) return VERDICT.CLEAN;
  const header = trimmed.header ?? null;
  if (HEADER_AI.has(header)) return VERDICT.AI;
  if (HEADER_NOT_AI.has(header)) return VERDICT.CLEAN;
  return 'escalate';
}

/**
 * Grade a trimmed WEB response structurally — the locale-proof rule.
 *
 * An AI-disclosed video gets a badge on videoPrimaryInfoRenderer; an
 * auto-dubbed one gets none. We require BOTH the badge and the disclosure
 * section, so unrelated badges (Unlisted, Members only, Paid promotion) can't
 * produce a false positive on their own.
 */
export function classifyStructural(trimmed) {
  if (!trimmed?.hasSection) return VERDICT.CLEAN;
  const hasDisclosureBadge = (trimmed.badges ?? []).some(
    (b) => b.style === 'BADGE_STYLE_TYPE_SIMPLE' && b.icon === 'INFO'
  );
  return hasDisclosureBadge ? VERDICT.AI : VERDICT.CLEAN;
}

/**
 * Grade a masked WEB response. Structural rule first; the forced-English
 * header is the tie-breaker for a response that carries the section but, for
 * whatever reason, no badge array at all (a future mask change, say).
 */
export function classify(trimmed) {
  if (!trimmed?.hasSection) return VERDICT.CLEAN;
  if (trimmed.hasPrimary) return classifyStructural(trimmed);
  return classifyCheap(trimmed) === VERDICT.AI ? VERDICT.AI : VERDICT.CLEAN;
}

/**
 * Full probe, given a fetch implementation bound to the youtube.com origin.
 * Used by the content script and by the live test harness. One masked WEB
 * request, ~1 KB.
 */
export async function probeWith(fetchImpl, videoId) {
  let trimmed;
  try {
    const { url, init } = nextRequest(videoId, 'WEB');
    const res = await fetchImpl(url, init);
    if (!res.ok) throw new Error(`innertube WEB ${res.status}`);
    trimmed = trimNext(await res.json());
  } catch {
    return { verdict: VERDICT.UNKNOWN, source: 'error', header: null, owner: null };
  }
  return { verdict: classify(trimmed), source: 'web', header: trimmed.header ?? null, owner: trimmed.owner };
}
