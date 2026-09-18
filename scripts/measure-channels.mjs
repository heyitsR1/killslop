/**
 * Measures YouTube channels with the extension's own disclosure probe, in
 * bulk, so the list does not wait for users to stumble on every slop farm.
 *
 * Every verdict is a measurement of the channel's own words: the share of its
 * recent uploads that carry YouTube's "Made with AI" disclosure, read with the
 * same masked probe and classifier as the extension
 * (extension/src/core/innertube.js, rules in RESEARCH.md). Nothing here is an
 * opinion, a heuristic or a verdict copied from someone else's list.
 * Candidates come from YouTube search on slop-heavy topics and from public
 * lists (see ATTRIBUTION.md); a candidate that fails the measurement is
 * dropped, whoever listed it.
 *
 *   node scripts/measure-channels.mjs measure DIR [--no-search] [--lists cevval,aislist]
 *                                                 [--list-max N]
 *   node scripts/measure-channels.mjs sql DIR > seed.sql
 *   (cd worker && npx wrangler d1 execute killslop --remote --file=../seed.sql)
 *
 * Results accumulate in DIR/measured.json, so a rerun resumes where the last
 * one stopped and never measures a channel twice.
 */

import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { VERDICT, probeWith } from '../extension/src/core/innertube.js';
import { parseFeed } from '../worker/src/admin.js';
import {
  PREFIX_LEN,
  TALLY_RULES,
  isValidId,
  isValidTally,
  sha256Hex,
} from '../worker/src/policy.js';

const YT = 'https://www.youtube.com';
const CLIENT = { clientName: 'WEB', clientVersion: '2.20260910.01.00', hl: 'en', gl: 'US' };
// English so titles are stable; SOCS skips the EU consent interstitial.
const HEADERS = { 'accept-language': 'en-US,en;q=0.8', cookie: 'SOCS=CAI' };
const TIMEOUT_MS = 10_000;

/** Uploads sampled per channel, newest first. The RSS feed carries 15. */
const SAMPLE = 12;
/**
 * Published without review only when well clear of the extension's own bar
 * (TALLY_THRESHOLD of at least TALLY_MIN_SAMPLES): 75% of at least 8 uploads.
 * A channel between the two bars goes to the review queue instead.
 */
const PUBLISH_MIN_SAMPLES = 8;
const PUBLISH_THRESHOLD = 0.75;

/** The extension's own bar for YouTube, which the early abandonment aims at. */
const { minSamples: TALLY_MIN_SAMPLES, threshold: TALLY_THRESHOLD } = TALLY_RULES.youtube;

const CONCURRENCY = 6;
const SEARCH_PAGES = 3;
/** Consecutive failed requests before the run stops and saves: YouTube is refusing us. */
const MAX_FAILURES = 25;

/**
 * Where labelled slop clusters (RESEARCH.md section 6): AI music, bible and
 * kids' animation, generated animals and "documentaries". A query only finds
 * candidates; the channel's own labels decide.
 */
const QUERIES = [
  'ai generated music', 'ai music', 'ai relaxing music', 'ai lofi', 'ai sleep music', 'ai jazz',
  'ai country song', 'ai rock song', 'ai metal cover', 'ai cover song', 'ai soul music', 'ai gospel music',
  'ai christian worship song', 'ai kpop', 'ai rap song', 'ai 1950s music', 'ai motown', 'ai music video',
  'bible stories animation', 'bible story for kids', 'jesus animation', 'bible animation shorts',
  'ai animation', 'ai short film', 'ai cartoon for kids', 'nursery rhymes 3d animation ai',
  'ai cat story', 'ai cat', 'ai baby animals', 'ai fruit babies', 'ai animals rescue', 'ai giant animals',
  'ai dinosaur', 'ai wildlife', 'ai pets', 'ai transformation', 'ai fantasy creatures',
  'ai documentary', 'lost civilization documentary ai', 'ai history documentary', 'ai horror story',
  'ai asmr', 'glass fruit cutting asmr', 'ai food asmr', 'ai cooking', 'ai movie trailer', 'ai trailer',
  'veo 3', 'sora ai video', 'ai generated video', 'ai vlog', 'ai bodycam', 'ai prophecy', 'ai sermon',
  'ai motivational speech', 'ai story', 'ai celebrity', 'ai podcast', 'ai news', 'ai sand art',
];

/** Public lists, used only as candidates. Licences in ATTRIBUTION.md. */
const LISTS = {
  cevval: {
    url: 'https://raw.githubusercontent.com/cevvalkoala/CevvalYoutubeAIBlocklist/HEAD/CevvalYoutubeAIblocklist.txt',
    parse: (text) => [...text.matchAll(/href\*="(UC[\w-]{22}|@[^"]+)"/g)].map((m) => m[1]),
  },
  aislist: {
    url: 'https://raw.githubusercontent.com/Override92/AiSList/HEAD/AiSList/aislist_blocklist.txt',
    parse: (text) =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^(@|UC)/.test(line)),
  },
};

/* ---------------------------------------------------------------- network */

let failures = 0;
let halted = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch against youtube.com, retrying 429s, 5xx and timeouts with backoff.
 * Returns the last response (or null) once retries run out. A long run of
 * failures halts the whole run rather than hammering a server that said no.
 */
async function ytFetch(path, init = {}) {
  const { credentials, ...rest } = init;
  let res = null;
  for (let attempt = 0; attempt < 4 && !halted; attempt++) {
    try {
      res = await fetch(`${YT}${path}`, {
        ...rest,
        headers: { ...HEADERS, ...rest.headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status !== 429 && res.status < 500) {
        failures = 0;
        return res;
      }
      // Release the refused response before retrying, or its socket and buffer stay held.
      await res.body?.cancel().catch(() => {});
    } catch {
      res = null;
    }
    if (++failures >= MAX_FAILURES && !halted) {
      halted = true;
      console.error(`\nYouTube refused ${failures} requests in a row (last: ${res?.status ?? 'timeout'}). Stopping.`);
    }
    await sleep(1000 * 2 ** attempt);
  }
  return res;
}

async function innertube(endpoint, body) {
  const res = await ytFetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: { client: CLIENT }, ...body }),
  });
  return res?.ok ? res.json() : res?.status === 404 ? { notFound: true } : null;
}

/** Calls `visit` on every object in a response, depth-limited. */
function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 60) return;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit, depth + 1);
}

const handleOf = (base) =>
  typeof base === 'string' && base.startsWith('/@') ? normalizeHandle(base.slice(1)) : null;

/** Lowercased, as the extension stores it (content/parse.js), or null if the list cannot hold it. */
function normalizeHandle(raw) {
  let handle;
  try {
    handle = decodeURIComponent(raw).toLowerCase();
  } catch {
    return null;
  }
  return isValidId(handle, 'channel') ? handle : null;
}

/** Video ids from a search, with the owner when the result carries one (Shorts do not). */
async function search(query) {
  const videos = new Map();
  let body = { query };
  for (let page = 0; page < SEARCH_PAGES && !halted; page++) {
    const res = await innertube('search', body);
    if (!res || res.notFound) break;
    let next = null;
    walk(res, (n) => {
      const v = n.videoRenderer;
      if (v?.videoId) {
        const ep = v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint;
        videos.set(v.videoId, { ucid: ep?.browseId ?? null, handle: handleOf(ep?.canonicalBaseUrl) });
      }
      const short = n.reelWatchEndpoint?.videoId;
      if (short && !videos.has(short)) videos.set(short, { ucid: null, handle: null });
      next = n.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ?? next;
    });
    if (!next) break;
    body = { continuation: next };
  }
  return videos;
}

/** A handle's UC id; null when YouTube says there is no such channel, undefined on failure. */
async function resolveHandle(handle) {
  const res = await innertube('navigation/resolve_url', { url: `${YT}/${handle}` });
  if (!res) return undefined;
  if (res.notFound) return null;
  const ucid = res.endpoint?.browseEndpoint?.browseId;
  return /^UC[\w-]{22}$/.test(ucid ?? '') ? ucid : null;
}

/* ------------------------------------------------------------ measurement */

function grade(ai, total) {
  if (total >= PUBLISH_MIN_SAMPLES && ai / total >= PUBLISH_THRESHOLD) return 'publish';
  return isValidTally(ai, total) ? 'queue' : 'below';
}

/**
 * Probe a channel's newest uploads, stopping as soon as the rest could no
 * longer lift it over the extension's bar. Real channels label nothing
 * (RESEARCH.md section 7), so most of them cost five probes, not twelve.
 */
async function measureChannel(ucid) {
  const at = Date.now();
  const res = await ytFetch(`/feeds/videos.xml?channel_id=${ucid}`);
  if (res?.status === 404) return { ucid, at, result: 'gone' };
  if (!res?.ok) return { ucid, at, result: 'error' };

  const { title, videos } = parseFeed(await res.text());
  const sample = videos.slice(0, SAMPLE);
  let ai = 0;
  let total = 0;
  let unknown = 0;
  let handle = null;
  const recent = [];
  for (let i = 0; i < sample.length && !halted; i++) {
    const probe = await probeWith(ytFetch, sample[i].id);
    handle ??= probe.owner?.handle ? normalizeHandle(probe.owner.handle) : null;
    if (probe.verdict === VERDICT.UNKNOWN) unknown += 1;
    else {
      total += 1;
      if (probe.verdict === VERDICT.AI) ai += 1;
    }
    recent.push({ ...sample[i], ai: probe.verdict === VERDICT.UNKNOWN ? null : probe.verdict === VERDICT.AI });
    const rest = sample.length - i - 1;
    if (total + rest < TALLY_MIN_SAMPLES || (ai + rest) / (total + rest) < TALLY_THRESHOLD) break;
  }
  // Cut short by a halt, or mostly unanswered: not a fact about the channel.
  if (halted || unknown > total) return { ucid, at, result: 'error' };
  return { ucid, handle, title, ai, total, recent, at, result: grade(ai, total) };
}

async function pool(items, size, task) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length && !halted) await task(items[next++]);
    })
  );
}

/* ------------------------------------------------------------------ state */

const statePath = (dir) => join(dir, 'measured.json');

async function load(dir) {
  try {
    return JSON.parse(await readFile(statePath(dir), 'utf8'));
  } catch {
    return { searched: {}, resolved: {}, channels: {} };
  }
}

async function save(dir, state) {
  await mkdir(dir, { recursive: true });
  const tmp = `${statePath(dir)}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, statePath(dir));
}

/* -------------------------------------------------------------- commands */

async function measure(dir, { useSearch, lists, listMax }) {
  const state = await load(dir);
  const candidates = new Map(); // ucid -> { handle, sources }
  const addCandidate = (ucid, handle, source) => {
    if (!/^UC[\w-]{22}$/.test(ucid ?? '')) return;
    const c = candidates.get(ucid) ?? { handle: null, sources: new Set() };
    c.handle ??= handle;
    c.sources.add(source);
    candidates.set(ucid, c);
  };

  // Search results are probed one by one; only a channel that has at least
  // one labelled video in the results is worth sampling in full.
  if (useSearch) {
    for (const query of QUERIES) {
      if (halted) break;
      const prior = state.searched[query];
      if (prior) {
        for (const [ucid, handle] of prior.found) addCandidate(ucid, handle, 'search');
        continue;
      }
      const videos = [...(await search(query))];
      const found = new Map();
      await pool(videos, CONCURRENCY, async ([id, owner]) => {
        const probe = await probeWith(ytFetch, id);
        if (probe.verdict !== VERDICT.AI) return;
        const ucid = probe.owner?.ucid ?? owner.ucid;
        const handle = normalizeHandle(probe.owner?.handle ?? '') ?? owner.handle;
        if (ucid) found.set(ucid, handle);
      });
      if (halted) break;
      for (const [ucid, handle] of found) addCandidate(ucid, handle, 'search');
      state.searched[query] = { at: Date.now(), videos: videos.length, found: [...found] };
      console.log(`search  ${query.padEnd(34)} ${String(videos.length).padStart(3)} videos, ${found.size} labelled channels`);
      await save(dir, state);
    }
  }

  for (const name of lists) {
    if (halted) break;
    const list = LISTS[name];
    const res = await fetch(list.url);
    if (!res.ok) {
      console.error(`list ${name}: HTTP ${res.status}, skipped`);
      continue;
    }
    const ids = [...new Set(list.parse(await res.text()))].slice(0, listMax);
    const handles = [];
    for (const raw of ids) {
      if (/^UC[\w-]{22}$/.test(raw)) addCandidate(raw, null, name);
      else {
        const handle = normalizeHandle(raw.replace(/^@?/, '@'));
        if (!handle) continue;
        if (handle in state.resolved) addCandidate(state.resolved[handle], handle, name);
        else handles.push(handle);
      }
    }
    await pool(handles, CONCURRENCY, async (handle) => {
      const ucid = await resolveHandle(handle);
      if (ucid === undefined) return;
      state.resolved[handle] = ucid;
      addCandidate(ucid, handle, name);
    });
    console.log(`list    ${name.padEnd(34)} ${ids.length} ids, ${handles.length} handles resolved`);
    await save(dir, state);
  }

  const todo = [];
  for (const [ucid, c] of candidates) {
    const known = state.channels[ucid];
    if (known && known.result !== 'error') {
      known.sources = [...new Set([...(known.sources ?? []), ...c.sources])];
    } else todo.push([ucid, c]);
  }
  console.log(`\n${candidates.size} candidate channels, ${todo.length} to measure\n`);

  let done = 0;
  let sinceSave = 0;
  await pool(todo, CONCURRENCY, async ([ucid, c]) => {
    const rec = await measureChannel(ucid);
    rec.handle = c.handle ?? rec.handle ?? null;
    rec.sources = [...c.sources];
    state.channels[ucid] = rec;
    done += 1;
    if (rec.result === 'publish' || rec.result === 'queue') {
      console.log(
        `${rec.result.padEnd(7)} ${String(rec.ai).padStart(2)}/${String(rec.total).padEnd(2)} ` +
          `${ucid} ${rec.handle ?? ''} ${rec.title ?? ''}  [${rec.sources.join(', ')}]`
      );
    }
    if (done % 100 === 0) console.log(`... ${done}/${todo.length} measured`);
    if (++sinceSave >= 25) {
      sinceSave = 0;
      await save(dir, state);
    }
  });
  await save(dir, state);

  const tally = {};
  for (const rec of Object.values(state.channels)) tally[rec.result] = (tally[rec.result] ?? 0) + 1;
  console.log(`\n${halted ? 'Stopped early; rerun to resume.' : 'Done.'} All measured so far:`, tally);
  process.exitCode = halted ? 2 : 0;
}

const sqlText = (s) =>
  s == null ? 'NULL' : `'${String(s).replace(/[\x00-\x1f\x7f]/g, ' ').replaceAll("'", "''")}'`;

/**
 * INSERTs for every channel that passed, as UC id and as handle, because a
 * tile may carry either spelling (see applyToTwins in worker/src/admin.js).
 * `publish` rows arrive approved; `queue` rows wait in the console. Rows the
 * list already has are left alone, so a rerun never overrides a maintainer's
 * call or counts the crawler twice. The crawler counts as one tally.
 */
async function sql(dir) {
  const state = await load(dir);
  const out = [
    '-- Generated by scripts/measure-channels.mjs from its own measurements.',
    '-- New rows only: an entry the list already has keeps its row and its review.',
  ];
  for (const rec of Object.values(state.channels)) {
    if (rec.result !== 'publish' && rec.result !== 'queue') continue;
    const approved = rec.result === 'publish';
    const meta = JSON.stringify({
      ucid: rec.ucid,
      recent: rec.recent.slice(0, 6),
      labelled: { ai: rec.ai, total: rec.total },
      measured: { by: 'crawler', at: rec.at },
    });
    for (const id of new Set([rec.ucid, rec.handle].filter((s) => s && isValidId(s, 'channel')))) {
      const hash = await sha256Hex(id);
      const values = [
        sqlText(hash), sqlText(hash.slice(0, PREFIX_LEN)), sqlText(id), "'channel'", "'youtube'",
        1, rec.ai, rec.total, rec.at, rec.at,
        approved ? "'slop'" : 'NULL', approved ? rec.at : 'NULL',
        sqlText(rec.title), sqlText(meta), rec.at,
      ];
      out.push(
        'INSERT INTO entries (hash, prefix, id, kind, platform, tallies, tally_ai, tally_total, created, ' +
          `updated, review, reviewed_at, title, meta, meta_at) VALUES (${values.join(', ')}) ON CONFLICT(hash) DO NOTHING;`
      );
    }
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

/* ------------------------------------------------------------------- main */

const [command, dir, ...flags] = process.argv.slice(2);
const flag = (name) => flags.includes(name);
const value = (name, fallback) => {
  const i = flags.indexOf(name);
  return i >= 0 && flags[i + 1] ? flags[i + 1] : fallback;
};

if (!dir || !['measure', 'sql'].includes(command)) {
  console.error('usage: measure-channels.mjs measure DIR [--no-search] [--lists a,b] [--list-max N]');
  console.error('       measure-channels.mjs sql DIR > seed.sql');
  process.exit(1);
}

if (command === 'sql') {
  await sql(dir);
} else {
  const lists = value('--lists', '')
    .split(',')
    .filter(Boolean);
  const unknown = lists.filter((name) => !LISTS[name]);
  if (unknown.length) {
    console.error(`unknown list: ${unknown.join(', ')} (known: ${Object.keys(LISTS).join(', ')})`);
    process.exit(1);
  }
  await measure(dir, {
    useSearch: !flag('--no-search'),
    lists,
    listMax: Number(value('--list-max', Infinity)),
  });
}
