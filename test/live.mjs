/**
 * Live end-to-end check of the shipped probe against real YouTube URLs.
 * Network-dependent, so it is not part of `npm test`.  Run: npm run test:live
 */
import { probeWith } from '../extension/src/core/innertube.js';

// In the extension this fetch is issued by the content script at youtube.com
// origin, because YouTube 403s requests carrying a chrome-extension:// origin.
// From Node there is no Origin header at all, so an absolute URL is fine.
const ytFetch = (path, init) => fetch(`https://www.youtube.com${path}`, init);
const probeVideo = (id) => probeWith(ytFetch, id);

const CASES = [
  // [url, expected, why]
  ['https://www.youtube.com/watch?v=9kzE8isXlQY', 'ai',    'chill chill journal — the video from the screenshot'],
  ['https://www.youtube.com/watch?v=_Ak-mOGI_B4', 'ai',    'AI Music Atlas — labelled AI'],
  ['https://www.youtube.com/watch?v=aDoanNM7O_s', 'clean', 'National Geographic — AUTO-DUBBED, must not be flagged'],
  ['https://www.youtube.com/watch?v=XWxKXpwwvz8', 'clean', 'Motiversity — auto-dubbed, must not be flagged'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'clean', 'Rick Astley — plain human video'],
  ['https://www.youtube.com/watch?v=lcjdwSY2AzM', 'clean', 'Veritasium — plain human video'],
  ['https://www.youtube.com/watch?v=yhB3BgJyGl8', 'clean', 'MrBeast — plain human video'],
];

const id = (url) => url.match(/[?&]v=([\w-]{11})/)[1];
let failed = 0;

console.log('videoId      expected  actual    source          header');
console.log('─'.repeat(78));

for (const [url, expected, why] of CASES) {
  const videoId = id(url);
  const t0 = Date.now();
  const { verdict, source, header, owner } = await probeVideo(videoId);
  const ok = verdict === expected;
  if (!ok) failed += 1;
  console.log(
    `${videoId}  ${expected.padEnd(8)}  ${verdict.padEnd(8)}  ${String(source).padEnd(14)}  ${header ?? '—'}` +
      `  ${ok ? 'ok' : 'MISMATCH'}  (${Date.now() - t0}ms)`
  );
  console.log(`             ${why}  [${owner?.ucid ?? '?'} ${owner?.handle ?? ''}]`);
}

console.log('─'.repeat(78));
console.log(failed ? `${failed} MISMATCH(ES)` : `all ${CASES.length} live cases correct`);
process.exit(failed ? 1 : 0);
