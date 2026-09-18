/**
 * Verdict engine. Decides "is this slop?" for a batch of feed items on one
 * platform.
 *
 * Tiers, cheapest first. The first tier that answers wins:
 *
 *   0. User override      — free, instant, absolute. Your "not slop" click
 *                           outranks the platform and the community both.
 *   1. Local cache        — free. Verdicts don't expire; disclosures don't change.
 *   2. Channel inference  — free once a channel is tallied. On YouTube this is
 *                           where the coverage comes from (see RESEARCH.md):
 *                           slop farms label ~100% of uploads, real channels 0%.
 *   3. Community list     — one batched request per hash bucket.
 *   4. Writing check      — X and LinkedIn only, and off unless asked for.
 *                           The words themselves, when nothing else can place
 *                           the post: X labels media but never text, and
 *                           LinkedIn labels nothing at all.
 *   5. InnerTube probe    — YouTube only, and it cannot happen here.
 *
 * Tiers 4 and 5 are both delegated to the content script, for opposite
 * reasons. YouTube 403s any request carrying an extension origin, so the page
 * issues the probe and calls recordProbe(). The writing check needs the post's
 * text, which only the page can read, so the page gates it locally and calls
 * recordWriting() with what survived. X needs no probe: its feed already
 * carries the label, and the X content script hands over what it read through
 * recordObservations().
 */

import { VERDICT } from './innertube.js';
import * as store from './store.js';
import * as community from './community.js';
import { HIDE_AT, classifyText, lookupTexts } from './writing.js';
import { getSettings } from './settings.js';
import { channelRule, isValidId, platformOf } from './ids.js';

/** Where the writing check applies. Never YouTube (RESEARCH.md section 7). */
const WRITING_PLATFORMS = new Set(['x', 'linkedin']);

/** How a cached verdict got there, so tier 1 can say why rather than guess. */
const isWritingSource = (source) => typeof source === 'string' && source.endsWith(':writing');

const listeners = new Set();

export function onResolved(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(update) {
  for (const fn of listeners) {
    try {
      fn(update);
    } catch {
      /* a bad listener must not break the caller */
    }
  }
}

/** A handle: the tally knows it under a stable id once it has seen one. */
const isAlias = (id) => id.startsWith('@') || id.startsWith('x:@');

export function channelVerdict(record, settings, platform = 'youtube') {
  if (!record || !settings.useChannelInference) return null;
  const rule = channelRule(platform, settings);
  if (!rule || record.total < rule.minSamples) return null;
  const rate = record.ai / record.total;
  if (rate >= rule.threshold) return { slop: true, reason: 'channel', rate };
  return null;
}

/**
 * @param {Array<{videoId:string, channelId?:string}>} items
 * @param {string} platform  a key of PLATFORMS; every item belongs to it
 * @returns {Promise<{verdicts:Object, probe:Array<{videoId,channelId}>}>}
 */
export async function resolveBatch(items, platform = 'youtube') {
  const settings = await getSettings();
  const verdicts = {};
  const probe = [];
  if (!settings.enabled || !settings.platforms[platform]) return { verdicts, probe };

  const videoIds = [...new Set(items.map((i) => i.videoId).filter(Boolean))];
  const rawChannelIds = [...new Set(items.map((i) => i.channelId).filter(Boolean))];

  // Tiles link to a channel by handle or by a stable id (YouTube's UC id, X's
  // user id), and the stable id is what gets tallied. A handle we've seen
  // resolved before is translated so both spellings land on the same record.
  const aliases = await store.getAliases(rawChannelIds.filter(isAlias));
  const canon = (id) => (id && aliases.get(id)) || id || null;
  const channelKeys = [...new Set(rawChannelIds.flatMap((id) => [id, canon(id)]))];

  const [videoOverrides, channelOverrides, cached, channels] = await Promise.all([
    store.getOverrides(videoIds),
    store.getOverrides(channelKeys),
    store.getVideos(videoIds),
    store.getChannels(channelKeys),
  ]);

  const channelRecord = (id) => channels.get(canon(id)) || channels.get(id);
  const channelOverride = (id) => channelOverrides.get(id) || channelOverrides.get(canon(id));

  const unresolved = [];

  for (const item of items) {
    const { videoId, channelId } = item;
    if (!videoId) continue;

    // Tier 0 — the user's own word, on the video or on its channel.
    const vo = videoOverrides.get(videoId);
    if (vo) {
      verdicts[videoId] = { slop: vo.slop, reason: 'you' };
      continue;
    }
    const co = channelId && channelOverride(channelId);
    if (co) {
      verdicts[videoId] = { slop: co.slop, reason: 'you-channel' };
      continue;
    }

    // Tier 1 — local cache.
    const hit = cached.get(videoId);
    if (hit && hit.verdict !== VERDICT.UNKNOWN) {
      if (hit.verdict === VERDICT.AI) {
        // A cached "yes" from the writing check must not claim the platform
        // labelled it: that would be a stronger claim than we can make.
        verdicts[videoId] = { slop: true, reason: isWritingSource(hit.source) ? 'writing' : 'disclosure' };
      } else {
        // Known clean by disclosure, but the channel may still condemn it.
        const cv = channelVerdict(channelRecord(channelId), settings, platform);
        verdicts[videoId] = cv
          ? { slop: true, reason: 'channel' }
          : { slop: false, reason: 'clean' };
      }
      continue;
    }

    // Tier 2 — channel inference, before we spend anything.
    if (channelVerdict(channelRecord(channelId), settings, platform)) {
      verdicts[videoId] = { slop: true, reason: 'channel' };
      continue;
    }

    unresolved.push(item);
  }

  // Tier 3 — community list, batched by hash prefix.
  let remaining = unresolved;
  if (remaining.length && settings.useCommunity) {
    const ids = [
      ...new Set([
        ...remaining.map((i) => i.videoId),
        ...remaining.flatMap((i) => (i.channelId ? [i.channelId, canon(i.channelId)] : [])),
      ]),
    ];
    let found;
    try {
      found = await community.lookup(ids);
    } catch {
      found = new Map();
    }

    // Opinion-only entries are dropped when the user wants measurement only.
    const usable = (e) => e && (settings.trustVotes || e.evidence === 'disclosure');
    const rule = channelRule(platform, settings);

    const next = [];
    for (const item of remaining) {
      const vRaw = found.get(item.videoId);
      const cRaw = item.channelId
        ? found.get(canon(item.channelId)) || found.get(item.channelId)
        : undefined;
      const v = usable(vRaw) ? vRaw : undefined;
      const c = usable(cRaw) ? cRaw : undefined;
      const entry = v || c;
      if (entry) {
        verdicts[item.videoId] = {
          slop: entry.slop,
          reason: v
            ? 'community'
            : entry.evidence === 'disclosure'
              ? 'community-measured'
              : 'community-channel',
        };
        if (entry.slop && c && !v && rule) {
          // Remember community channel verdicts locally so the next feed is free.
          await store.setChannelTally(canon(item.channelId), rule.minSamples, rule.minSamples, {
            fromCommunity: true,
          });
        }
        continue;
      }
      next.push(item);
    }
    remaining = next;
  }

  // Tiers 4 and 5 — hand back to the content script, which has what we don't:
  // an origin YouTube will answer, and the post's own text. With nothing left
  // to ask, say so, which stops the page asking again; an X label that turns
  // up later arrives through recordObservations().
  const check = [];
  for (const item of remaining) {
    if (platform === 'youtube') {
      if (settings.useDisclosure) {
        verdicts[item.videoId] = { slop: false, reason: 'pending', pending: true };
        probe.push({ videoId: item.videoId, channelId: item.channelId ?? null });
      }
    } else if (settings.useWritingCheck && WRITING_PLATFORMS.has(platform)) {
      verdicts[item.videoId] = { slop: false, reason: 'pending', pending: true };
      check.push({ videoId: item.videoId, channelId: item.channelId ?? null });
    } else {
      verdicts[item.videoId] = { slop: false, reason: 'none' };
    }
  }

  return { verdicts, probe, check };
}

/**
 * Record what the writing check made of posts the other tiers could not place.
 *
 * The page has already read the text and held back everything its local gate
 * found unremarkable, so what arrives here is the short list. Each text is
 * looked up by hash first, and only a text nobody has had checked before is
 * sent anywhere.
 *
 * A post the check cannot answer for is left undecided rather than accused:
 * no cache entry, no verdict, and the next scan may try again.
 *
 * @param {Array<{id:string, text:string}>} posts
 * @param {string} platform
 * @returns {Promise<{verdicts:Object}>}
 */
export async function recordWriting(posts, platform) {
  const settings = await getSettings();
  const verdicts = {};
  if (!settings.enabled || !settings.useWritingCheck) return { verdicts };
  if (!WRITING_PLATFORMS.has(platform) || !settings.platforms[platform]) return { verdicts };

  const valid = (posts || []).filter(
    (p) => isValidId(p?.id, 'video') && platformOf(p.id) === platform && typeof p.text === 'string' && p.text
  );
  if (!valid.length) return { verdicts };

  // One request per bucket for everything already known, before anything is sent.
  const known = await lookupTexts([...new Set(valid.map((p) => p.text))]);

  for (const p of valid) {
    const answer = known.get(p.text) ?? (await classifyText(p.text, platform));
    if (!answer) continue;
    const slop = answer.score >= HIDE_AT;
    await store.putVideo(p.id, slop ? VERDICT.AI : VERDICT.CLEAN, `${platform}:writing`);
    verdicts[p.id] = slop ? { slop: true, reason: 'writing' } : { slop: false, reason: 'clean' };
    if (slop) emit({ videoId: p.id, slop: true, reason: 'writing' });
  }
  return { verdicts };
}

/**
 * Fold one labelled-or-not sample into a channel's tally, and publish the
 * channel once it crosses its platform's threshold.
 */
async function tallySample(key, spellings, slop, platform, settings) {
  const tally = await store.tallyChannel(key, slop);
  if (!channelVerdict(tally, settings, platform)) return;
  emit({ channelId: key, channelIds: spellings, slop: true, reason: 'channel' });
  // Share the measurement once. It is a fact about the channel's own labels,
  // not an opinion, which is what makes it safe to publish.
  if (settings.shareReports && settings.useCommunity && !tally.shared) {
    const ids = spellings.filter((s) => isValidId(s, 'channel'));
    community
      .tally({ ids, ai: tally.ai, total: tally.total, platform })
      .then((r) => (r.ok ? store.markChannelShared(key) : null))
      .catch(() => {});
  }
}

/**
 * Record a probe performed by the content script. Updates the cache, folds the
 * result into the channel tally, and broadcasts anything newly decided.
 */
export async function recordProbe({ videoId, channelId, verdict, source, header, owner }) {
  if (!videoId || verdict === VERDICT.UNKNOWN) return { ok: false };

  await store.putVideo(videoId, verdict, source, header ?? null);
  const slop = verdict === VERDICT.AI;

  // The tally key. The probe's UC id is authoritative and covers the sidebar,
  // where tiles carry no channel link at all; a tile-supplied handle is the
  // fallback. Every other spelling we saw becomes an alias of the key.
  const ucid = owner?.ucid ?? null;
  const key = ucid ?? channelId ?? owner?.handle ?? null;
  const spellings = [...new Set([key, channelId, owner?.handle].filter(Boolean))];
  if (ucid) {
    for (const s of spellings) if (s.startsWith('@')) await store.setAlias(s, ucid);
  }

  if (key) await tallySample(key, spellings, slop, 'youtube', await getSettings());

  emit({ videoId, slop, reason: slop ? 'disclosure' : 'clean' });
  return { ok: true, slop, channelId: key };
}

/**
 * Record what the X content script read off X's own post data (RESEARCH.md
 * section 12): for each post with media, whether X labelled it AI. X's label
 * only exists on media (section 13), so text-only posts are not samples.
 *
 * The same post turns up on every scroll and every visit, so only posts not
 * seen before are counted; otherwise one popular post would fill its author's
 * tally on its own.
 *
 * @param {Array<{id, channelId, alias, media, ai, source}>} posts
 * @returns {Promise<{ok:boolean, ai?:string[]}>}  ai: newly labelled post ids
 */
export async function recordObservations(posts) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.useDisclosure) return { ok: false };
  const samples = posts.filter(
    (p) => p?.media === true && isValidId(p.id, 'video') && settings.platforms[platformOf(p.id)]
  );
  if (!samples.length) return { ok: true, ai: [] };

  const seen = await store.getVideos(samples.map((p) => p.id));
  const ai = [];
  for (const p of samples) {
    if (seen.has(p.id)) continue;
    seen.set(p.id, true); // a batch can repeat a post
    const platform = platformOf(p.id);
    const slop = p.ai === true;
    await store.putVideo(p.id, slop ? VERDICT.AI : VERDICT.CLEAN, `${platform}:${p.source || 'label'}`);

    const key = isValidId(p.channelId, 'channel') ? p.channelId : null;
    const alias = isValidId(p.alias, 'channel') ? p.alias : null;
    if (key && alias) await store.setAlias(alias, key);
    if (key || alias) {
      await tallySample(key || alias, [key, alias].filter(Boolean), slop, platform, settings);
    }

    if (slop) {
      ai.push(p.id);
      emit({ videoId: p.id, slop: true, reason: 'disclosure' });
    }
  }
  return { ok: true, ai };
}

/** Record the user's correction, locally first and to the community second. */
export async function submitOverride({ id, kind, slop, share, meta = null }) {
  await store.setOverride(id, kind, slop, meta);
  emit(
    kind === 'channel'
      ? { channelId: id, channelIds: [id], slop, reason: 'you-channel' }
      : { videoId: id, slop, reason: 'you' }
  );
  if (share) community.report({ id, kind, slop });
  return { ok: true };
}

/**
 * Undo the user's own call. Tabs are told to forget and re-resolve, so the
 * item falls back to whatever the lower tiers say. The community vote is
 * taken back too.
 */
export async function removeOverride(id, { share = false } = {}) {
  const prior = await store.getOverride(id);
  await store.clearOverride(id);
  if (!prior) return { ok: true };
  emit(
    prior.kind === 'channel'
      ? { channelId: id, channelIds: [id], cleared: true }
      : { videoId: id, cleared: true }
  );
  if (share) community.retract({ id, kind: prior.kind });
  return { ok: true };
}

export const __testing = { channelVerdict };
