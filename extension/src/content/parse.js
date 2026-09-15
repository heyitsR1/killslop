/**
 * URL parsing for YouTube tiles. Loaded as a plain content script (content
 * scripts can't be ES modules), so it publishes onto globalThis.
 *
 * Kept separate from youtube.js purely so it can be unit tested — these regexes
 * are the difference between filtering the right tile and the wrong one.
 */

(() => {
  'use strict';

  function videoIdFrom(href) {
    if (typeof href !== 'string' || !href) return null;
    const watch = href.match(/[?&]v=([\w-]{11})(?:[&#]|$)/);
    if (watch) return watch[1];
    const short = href.match(/\/(?:shorts|embed|live)\/([\w-]{11})(?:[/?#]|$)/);
    if (short) return short[1];
    return null;
  }

  function channelIdFrom(href) {
    if (typeof href !== 'string' || !href) return null;
    const ucid = href.match(/\/channel\/(UC[\w-]{22})(?:[/?#]|$)/);
    if (ucid) return ucid[1];
    // Handles are case-insensitive on YouTube; normalise so tallies agree.
    const handle = href.match(/\/(@[\w.-]{1,48})(?:[/?#]|$)/);
    if (handle) return handle[1].toLowerCase();
    return null;
  }

  globalThis.KillSlopParse = { videoIdFrom, channelIdFrom };
})();
