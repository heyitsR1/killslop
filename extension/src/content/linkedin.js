/**
 * LinkedIn adapter. LinkedIn exposes no AI label in the feed (RESEARCH.md
 * section 18), so posts here are resolved by your own marks and the
 * community list only.
 *
 * Passive on purpose: this reads the DOM LinkedIn already rendered and makes
 * no requests to LinkedIn of its own (section 22).
 *
 * The author is found through the post's menu button, whose label names them
 * ("Open control menu for post by <Name>"; section 21). That label is English:
 * in another interface language the post still gets its button and can still
 * be hidden, but not by author.
 */

(() => {
  'use strict';

  const { linkedinPostIdFrom, linkedinAuthorFrom } = globalThis.KillSlopParse;

  const MENU_PREFIX = 'Open control menu for post by ';

  function authorName(el) {
    const label = el.querySelector(`button[aria-label^="${MENU_PREFIX}"]`)?.getAttribute('aria-label');
    return label ? label.slice(MENU_PREFIX.length).trim() : null;
  }

  /**
   * The first profile link in a post is often someone else ("X reacted to
   * this" sits above the author); the author's link is the one showing their
   * name.
   */
  function author(el) {
    const name = authorName(el);
    if (!name) return null;
    for (const a of el.querySelectorAll('a[href*="/in/"], a[href*="/company/"], a[href*="/showcase/"]')) {
      if (a.innerText.includes(name)) return linkedinAuthorFrom(a.getAttribute('href'));
    }
    return null;
  }

  globalThis.KillSlopFeed.start({
    platform: 'linkedin',
    // Main feed and search results; the componentkey carries the post's hash.
    selector: '[role="listitem"][componentkey^="expanded"]',
    noun: 'author',
    disclosureLabel: 'Labelled AI',

    parse(el) {
      const id = linkedinPostIdFrom(el.getAttribute('componentkey'));
      return id ? { id, channelId: author(el) } : null;
    },

    meta(el) {
      const text = el.querySelector('[data-testid="expandable-text-box"]')?.innerText.trim() || '';
      return { title: text.replace(/\s+/g, ' ').slice(0, 120) || null, channel: authorName(el) };
    },

    // The smallest box holding both Comment and Repost is the action row.
    voteHost(el) {
      const repost = el.querySelector('button[aria-label^="Repost"]');
      const comment = el.querySelector('button[aria-label^="Comment"]');
      if (!repost || !comment) return null;
      let row = repost.parentElement;
      while (row && row !== el && !row.contains(comment)) row = row.parentElement;
      return row && row !== el ? row : null;
    },
  });
})();
