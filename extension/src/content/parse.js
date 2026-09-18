/**
 * Id parsing for tiles and posts on every platform. Loaded as a plain content
 * script (content scripts can't be ES modules), so it publishes onto
 * globalThis.
 *
 * Kept separate from the adapters purely so it can be unit tested — these
 * regexes are the difference between filtering the right tile and the wrong
 * one. The ids they return follow extension/src/core/ids.js.
 */

(() => {
  'use strict';

  /* ---------------------------------------------------------------- YouTube */

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

  /* ---------------------------------------------------------------------- X */

  const X_ORIGIN = String.raw`(?:https?://(?:www\.|mobile\.)?(?:x|twitter)\.com)?`;
  const X_POST = new RegExp(`^${X_ORIGIN}/(?:\\w{1,15}|i(?:/web)?)/status/(\\d{1,20})(?:[/?#]|$)`);
  const X_PROFILE = new RegExp(`^${X_ORIGIN}/(\\w{1,15})/?(?:[?#]|$)`);
  // First path segments that are X's own pages, not accounts.
  const X_RESERVED = new Set([
    'home', 'explore', 'search', 'notifications', 'messages', 'settings', 'compose',
    'i', 'hashtag', 'bookmarks', 'lists', 'communities', 'jobs', 'premium',
    'premium_sign_up', 'tos', 'privacy', 'login', 'logout', 'signup', 'share', 'intent',
  ]);

  /** '/<handle>/status/<id>' (and '/i/status/<id>') -> 'x:<id>'. */
  function xPostIdFrom(href) {
    if (typeof href !== 'string' || !href) return null;
    const m = href.match(X_POST);
    return m ? `x:${m[1]}` : null;
  }

  /** '/<handle>' -> 'x:@<handle>'. X handles are case-insensitive. */
  function xHandleFrom(href) {
    if (typeof href !== 'string' || !href) return null;
    const m = href.match(X_PROFILE);
    if (!m || X_RESERVED.has(m[1].toLowerCase())) return null;
    return `x:@${m[1].toLowerCase()}`;
  }

  /* --------------------------------------------------------------- LinkedIn */

  /**
   * A feed post's componentkey is 'expanded' + base64url(sha256(its URN)) +
   * 'FeedType_...' (RESEARCH.md section 20). The hash is the post's id.
   */
  function linkedinPostIdFrom(componentkey) {
    if (typeof componentkey !== 'string') return null;
    const m = componentkey.match(/^expanded([A-Za-z0-9_-]{43})FeedType_/);
    return m ? `li:${m[1]}` : null;
  }

  /**
   * '/in/<slug>', '/company/<slug>' or '/showcase/<slug>' (a brand's page under
   * a company) -> 'li:in:<slug>', 'li:company:<slug>', 'li:showcase:<slug>'.
   */
  function linkedinAuthorFrom(href) {
    if (typeof href !== 'string' || !href) return null;
    let path;
    try {
      // Resolving percent-encodes a non-Latin vanity name the same way every time.
      path = new URL(href, 'https://www.linkedin.com').pathname;
    } catch {
      return null;
    }
    const m = path.match(/^\/(in|company|showcase)\/([^/]{2,100})/);
    if (!m) return null;
    const slug = m[2].toLowerCase();
    return /^[a-z0-9%_-]{2,100}$/.test(slug) ? `li:${m[1]}:${slug}` : null;
  }

  globalThis.KillSlopParse = {
    videoIdFrom,
    channelIdFrom,
    xPostIdFrom,
    xHandleFrom,
    linkedinPostIdFrom,
    linkedinAuthorFrom,
  };
})();
