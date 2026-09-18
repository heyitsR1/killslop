/**
 * Measures X accounts by how their posts read, so the list does not start
 * empty on a platform whose slop is made of words.
 *
 * Every verdict is a measurement of the account's own posts: the share of the
 * ones we read that the writing check scores at or above the bar, using the
 * same model and the same rubric as the extension (worker/src/jev.js). Nothing
 * here is an opinion, a heuristic or a verdict copied from someone else's
 * list, and an account that fails the measurement is dropped however it was
 * nominated.
 *
 *   node scripts/measure-social.mjs collect DIR --accounts nasa,someone
 *   node scripts/measure-social.mjs measure DIR
 *   node scripts/measure-social.mjs sql DIR > seed-social.sql
 *   (cd worker && npx wrangler d1 execute killslop --remote --file=../seed-social.sql)
 *
 * Collection is deliberately passive and deliberately manual to start. It
 * attaches over CDP to a browser you already launched and are already signed
 * in to (.browsers/social/launch.mjs, CDP on 9333) and reads the posts X has
 * already rendered. It does not log in, does not call X's API, and does not
 * touch anything but the page it was given. RESEARCH.md section 22 takes the
 * same stance on LinkedIn, and X's automation rules deserve it just as much:
 * a crawler that gets the maintainer's account banned has cost more than the
 * list it filled.
 *
 * Results accumulate in DIR/social.json, so a rerun resumes where the last one
 * stopped and never re-reads or re-checks an account it already has.
 */

import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { askJev } from '../worker/src/jev.js';
import {
  PREFIX_LEN,
  WRITING_RULES,
  isValidId,
  isValidWriting,
  sha256Hex,
} from '../worker/src/policy.js';

/** The score at or above which one post counts as reading AI-written. */
const HIDE_AT = 3.0;

/** Posts read per account. Fewer than this and the share means little. */
const SAMPLE = 12;

/**
 * Published without review only when well clear of the extension's own bar
 * (WRITING_RULES.x: half of at least 6): 60% of at least 8 posts. An account
 * between the two bars goes to the review queue instead.
 */
const PUBLISH_MIN_SAMPLES = 8;
const PUBLISH_THRESHOLD = 0.6;

const CDP = 'http://127.0.0.1:9333';
const CONCURRENCY = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ state */

const statePath = (dir) => join(dir, 'social.json');

async function load(dir) {
  try {
    return JSON.parse(await readFile(statePath(dir), 'utf8'));
  } catch {
    return { accounts: {} };
  }
}

async function save(dir, state) {
  await mkdir(dir, { recursive: true });
  const tmp = `${statePath(dir)}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, statePath(dir));
}

/* ---------------------------------------------------------------- collect */

/**
 * Read an account's own posts from the page, the way the extension does:
 * whatever X has already rendered, and nothing else. Replies and reposts are
 * skipped, because the point is how this account writes.
 */
async function readAccount(page, handle) {
  await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);

  const seen = new Map();
  for (let pass = 0; pass < 8 && seen.size < SAMPLE; pass++) {
    const batch = await page.evaluate((who) => {
      const out = [];
      for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
        const href =
          [...article.querySelectorAll('a[href*="/status/"] time')]
            .map((t) => t.closest('a'))
            .find((a) => !a.closest('div[role="link"]'))
            ?.getAttribute('href') ?? '';
        const id = (href.match(/\/([^/]+)\/status\/(\d{1,20})/) || [])[2];
        const author = (href.match(/^\/([^/]+)\/status\//) || [])[1];
        // Somebody else's post on this timeline is a repost, not their writing.
        if (!id || !author || author.toLowerCase() !== who.toLowerCase()) continue;
        const userId =
          article.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href') ?? null;
        out.push({
          id,
          text: article.querySelector('[data-testid="tweetText"]')?.innerText.trim() ?? '',
          reply: /Replying to/.test(article.innerText.slice(0, 200)),
          userId,
        });
      }
      return out;
    }, handle);

    for (const p of batch) {
      if (!p.reply && p.text && !seen.has(p.id)) seen.set(p.id, p.text);
    }
    await page.mouse.wheel(0, 1600);
    await sleep(1400);
  }
  return [...seen.entries()].slice(0, SAMPLE).map(([id, text]) => ({ id, text }));
}

async function collect(dir, handles) {
  const { chromium } = await import('playwright');
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP);
  } catch {
    console.error(
      `No browser on ${CDP}. Start one and sign in first:\n  node .browsers/social/launch.mjs`
    );
    process.exit(1);
  }
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  const state = await load(dir);
  for (const handle of handles) {
    const key = `x:@${handle.toLowerCase()}`;
    if (state.accounts[key]?.posts?.length) {
      console.log(`have    ${handle.padEnd(24)} ${state.accounts[key].posts.length} posts`);
      continue;
    }
    let posts = [];
    try {
      posts = await readAccount(page, handle);
    } catch (err) {
      console.error(`error   ${handle.padEnd(24)} ${String(err?.message || err).slice(0, 60)}`);
      continue;
    }
    state.accounts[key] = { ...(state.accounts[key] ?? {}), handle: handle.toLowerCase(), posts, at: Date.now() };
    console.log(`read    ${handle.padEnd(24)} ${posts.length} posts`);
    await save(dir, state);
    await sleep(1200); // unhurried on purpose
  }
  await page.close();
  console.log('\nCollected. Now: node scripts/measure-social.mjs measure', dir);
}

/* ---------------------------------------------------------------- measure */

function grade(ai, total) {
  if (total >= PUBLISH_MIN_SAMPLES && ai / total >= PUBLISH_THRESHOLD) return 'publish';
  return isValidWriting(ai, total, 'x') ? 'queue' : 'below';
}

async function pool(items, size, task) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await task(items[next++]);
    })
  );
}

async function measure(dir) {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error('TYPESAFE_API_KEY is not set. The measurement is the model; without it there is nothing to do.');
    process.exit(1);
  }
  const env = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY };
  const state = await load(dir);

  const todo = Object.entries(state.accounts).filter(([, a]) => a.posts?.length && !a.result);
  console.log(`${Object.keys(state.accounts).length} accounts, ${todo.length} to measure\n`);

  let done = 0;
  for (const [key, account] of todo) {
    const scores = [];
    await pool(account.posts, CONCURRENCY, async (post) => {
      const answer = await askJev(post.text, env);
      if (answer) scores.push({ id: post.id, score: answer.score, signal: answer.signal });
    });
    // Mostly unanswered is not a fact about the account.
    if (scores.length < Math.ceil(account.posts.length / 2)) {
      account.result = 'error';
      console.log(`error   ${account.handle.padEnd(24)} only ${scores.length}/${account.posts.length} answered`);
    } else {
      const ai = scores.filter((s) => s.score >= HIDE_AT).length;
      account.ai = ai;
      account.total = scores.length;
      account.scores = scores;
      account.result = grade(ai, scores.length);
      account.at = Date.now();
      if (account.result !== 'below') {
        console.log(`${account.result.padEnd(7)} ${String(ai).padStart(2)}/${String(scores.length).padEnd(2)} ${account.handle}`);
      }
    }
    state.accounts[key] = account;
    if (++done % 5 === 0) await save(dir, state);
  }
  await save(dir, state);

  const tally = {};
  for (const a of Object.values(state.accounts)) tally[a.result ?? 'unmeasured'] = (tally[a.result ?? 'unmeasured'] ?? 0) + 1;
  console.log('\nDone. All measured so far:', tally);
}

/* -------------------------------------------------------------------- sql */

const sqlText = (s) =>
  s == null ? 'NULL' : `'${String(s).replace(/[\x00-\x1f\x7f]/g, ' ').replaceAll("'", "''")}'`;

/**
 * INSERTs for every account that passed. Writing evidence goes in its own
 * columns, never in the tally columns: a tally is a label the platform
 * published and counted, this is a model's reading of the words, and the list
 * keeps the two apart end to end. `publish` rows arrive approved; `queue` rows
 * wait in the console. Rows the list already has are left alone, so a rerun
 * never overrides a maintainer's call or counts the crawler twice.
 */
async function sql(dir) {
  const state = await load(dir);
  const out = [
    '-- Generated by scripts/measure-social.mjs from its own measurements.',
    '-- Writing evidence: a model read these accounts posts, no label was published.',
    '-- New rows only: an entry the list already has keeps its row and its review.',
  ];
  for (const account of Object.values(state.accounts)) {
    if (account.result !== 'publish' && account.result !== 'queue') continue;
    const id = `x:@${account.handle}`;
    if (!isValidId(id, 'channel')) continue;
    const approved = account.result === 'publish';
    const hash = await sha256Hex(id);
    const meta = JSON.stringify({
      read: { ai: account.ai, total: account.total },
      sample: account.scores.slice(0, 6).map((s) => ({ id: s.id, score: s.score, signal: s.signal })),
      measured: { by: 'writing-crawler', model: 'jev', at: account.at },
    });
    const values = [
      sqlText(hash), sqlText(hash.slice(0, PREFIX_LEN)), sqlText(id), "'channel'", "'x'",
      1, account.ai, account.total, account.at, account.at,
      approved ? "'slop'" : 'NULL', approved ? account.at : 'NULL',
      sqlText(`@${account.handle}`), sqlText(meta), account.at,
    ];
    out.push(
      'INSERT INTO entries (hash, prefix, id, kind, platform, writings, writing_ai, writing_total, created, ' +
        `updated, review, reviewed_at, title, meta, meta_at) VALUES (${values.join(', ')}) ON CONFLICT(hash) DO NOTHING;`
    );
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

/* ------------------------------------------------------------------- main */

const [command, dir, ...flags] = process.argv.slice(2);
const value = (name, fallback) => {
  const i = flags.indexOf(name);
  return i >= 0 && flags[i + 1] ? flags[i + 1] : fallback;
};

if (!dir || !['collect', 'measure', 'sql'].includes(command)) {
  console.error('usage: measure-social.mjs collect DIR --accounts a,b,c   (needs the CDP browser, signed in)');
  console.error('       measure-social.mjs measure DIR                    (needs TYPESAFE_API_KEY)');
  console.error('       measure-social.mjs sql DIR > seed-social.sql');
  process.exit(1);
}

if (command === 'collect') {
  const handles = value('--accounts', '')
    .split(',')
    .map((h) => h.trim().replace(/^@/, ''))
    .filter((h) => /^\w{1,15}$/.test(h));
  if (!handles.length) {
    console.error('no usable handles in --accounts');
    process.exit(1);
  }
  await collect(dir, handles);
} else if (command === 'measure') {
  await measure(dir);
} else {
  await sql(dir);
}
