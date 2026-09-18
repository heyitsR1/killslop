/**
 * Measures the writing check, so its threshold rests on evidence rather than
 * on the handful of posts it started from (RESEARCH.md sections 23 and 26).
 *
 *   node scripts/eval-classifier.mjs labelled FILE.json
 *   node scripts/eval-classifier.mjs feed FILE.json
 *
 * Both need TYPESAFE_API_KEY. Neither writes anything: they print a table.
 *
 * `labelled` takes [{ text, truth: "slop" | "human", note? }] and prints, for
 * every candidate threshold, how much slop it catches and how many real people
 * it would hide. Precision and recall on someone's writing are the whole
 * argument for a number, so both are printed and neither is summarised away.
 *
 * `feed` takes [{ text }] scraped from a real timeline, unlabelled, and
 * answers the two questions labels are not needed for: what share of an
 * ordinary feed the local gate sends at all, and how the scores of what it
 * does send are distributed. That share is the cost and the privacy claim
 * both, so it is worth knowing from a real feed rather than assuming.
 */

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { askJev } from '../worker/src/jev.js';
import { HIDE_AT } from '../extension/src/core/writing.js';

/** slopsigns.js is a plain content script; load it the way Chrome would. */
const context = {};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  readFileSync(new URL('../extension/src/content/slopsigns.js', import.meta.url), 'utf8'),
  context
);
const { prefilter } = context.KillSlopSigns;

const THRESHOLDS = [2.0, 2.5, 3.0, 3.5];
const CONCURRENCY = 8;

async function pool(items, size, task) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await task(items[next++]);
    })
  );
}

const env = { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY };

async function score(posts) {
  const out = [];
  let asked = 0;
  await pool(posts, CONCURRENCY, async (post) => {
    const gate = prefilter(post.text);
    // The gate is part of what is being measured: a post it holds back is
    // never scored in real use, so scoring it here would flatter the result.
    if (!gate.suspicious) {
      out.push({ ...post, sent: false, hits: gate.hits, score: null });
      return;
    }
    asked += 1;
    const answer = await askJev(gate.text, env);
    out.push({ ...post, sent: true, hits: gate.hits, score: answer?.score ?? null, signal: answer?.signal ?? null });
  });
  return { rows: out, asked };
}

/* --------------------------------------------------------------- labelled */

async function labelled(file) {
  const posts = JSON.parse(await readFile(file, 'utf8'));
  const bad = posts.filter((p) => !p?.text || !['slop', 'human'].includes(p.truth));
  if (bad.length) {
    console.error(`${bad.length} entries lack a text or a truth of "slop"/"human"`);
    process.exit(1);
  }
  const { rows, asked } = await score(posts);

  const slop = rows.filter((r) => r.truth === 'slop');
  const human = rows.filter((r) => r.truth === 'human');
  console.log(`${rows.length} posts: ${slop.length} slop, ${human.length} human. ${asked} reached the model.\n`);

  // A post the gate held back is a miss, not a pass: in use it is never asked
  // about, so it counts against recall exactly as a low score would.
  const held = slop.filter((r) => !r.sent).length;
  if (held) console.log(`${held} slop posts were held back by the gate before any threshold applied.\n`);

  console.log('threshold  caught      missed  false positives  precision  recall');
  for (const t of THRESHOLDS) {
    const over = (r) => r.sent && r.score !== null && r.score >= t;
    const tp = slop.filter(over).length;
    const fp = human.filter(over).length;
    const fn = slop.length - tp;
    const precision = tp + fp ? tp / (tp + fp) : 1;
    const recall = slop.length ? tp / slop.length : 0;
    console.log(
      `${t.toFixed(1).padStart(9)}  ${String(tp).padStart(3)}/${String(slop.length).padEnd(6)} ` +
        `${String(fn).padStart(6)}  ${String(fp).padStart(8)}/${String(human.length).padEnd(6)} ` +
        `${precision.toFixed(3).padStart(9)}  ${recall.toFixed(3).padStart(6)}`
    );
  }

  const wrong = rows.filter((r) => r.truth === 'human' && r.sent && r.score >= HIDE_AT);
  if (wrong.length) {
    console.log(`\nHuman posts the shipping threshold (${HIDE_AT}) would hide:`);
    for (const r of wrong) {
      console.log(`  ${r.score.toFixed(2)}  ${r.signal ?? ''}  ${r.text.replace(/\s+/g, ' ').slice(0, 88)}`);
    }
  } else {
    console.log(`\nNo human post reached the shipping threshold (${HIDE_AT}).`);
  }
}

/* ------------------------------------------------------------------- feed */

async function feed(file) {
  const posts = JSON.parse(await readFile(file, 'utf8')).filter((p) => p?.text);
  const { rows, asked } = await score(posts);

  const sent = rows.filter((r) => r.sent);
  const scored = sent.filter((r) => r.score !== null);
  const pct = (n) => `${((100 * n) / rows.length).toFixed(1)}%`;

  console.log(`${rows.length} posts from a real timeline, unlabelled.\n`);
  console.log(`  held locally, text never sent : ${rows.length - sent.length} (${pct(rows.length - sent.length)})`);
  console.log(`  sent to be checked            : ${sent.length} (${pct(sent.length)})`);
  console.log(`  cost at $0.042 per M tokens   : about $${((asked * 835 * 0.042) / 1e6).toFixed(5)} for this feed`);
  console.log(`  per 1,000 posts of feed       : about $${(((asked / rows.length) * 835 * 0.042) / 1e6 * 1000).toFixed(4)}`);

  const bands = [[0, 1], [1, 2], [2, 3], [3, 4.01]];
  console.log('\n  scores of what was sent:');
  for (const [lo, hi] of bands) {
    const n = scored.filter((r) => r.score >= lo && r.score < hi).length;
    console.log(`    ${lo} to ${hi === 4.01 ? 4 : hi}  ${String(n).padStart(3)}  ${'#'.repeat(n)}`);
  }
  const hidden = scored.filter((r) => r.score >= HIDE_AT);
  console.log(`\n  would be hidden at ${HIDE_AT}: ${hidden.length} of ${rows.length} (${pct(hidden.length)})`);
  for (const r of hidden.slice(0, 10)) {
    console.log(`    ${r.score.toFixed(2)}  ${r.text.replace(/\s+/g, ' ').slice(0, 84)}`);
  }

  const gateCounts = {};
  for (const r of sent) for (const h of r.hits) gateCounts[h] = (gateCounts[h] ?? 0) + 1;
  console.log('\n  which signs did the sending:');
  for (const [sign, n] of Object.entries(gateCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${sign.padEnd(22)} ${n}`);
  }
}

/* ------------------------------------------------------------------- main */

const [command, file] = process.argv.slice(2);
if (!file || !['labelled', 'feed'].includes(command)) {
  console.error('usage: eval-classifier.mjs labelled FILE.json   [{text, truth: "slop"|"human"}]');
  console.error('       eval-classifier.mjs feed FILE.json       [{text}] from a real timeline');
  process.exit(1);
}
if (!process.env.TYPESAFE_API_KEY) {
  console.error('TYPESAFE_API_KEY is not set.');
  process.exit(1);
}
await (command === 'labelled' ? labelled(file) : feed(file));
