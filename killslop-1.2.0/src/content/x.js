/**
 * X adapter. Posts come from the feed engine (feed.js); what this file adds is
 * X's own AI label. x-page.js reads it off the post data in the page's world
 * and hands it over as an event (RESEARCH.md sections 12 and 14); this
 * forwards it to the background, which caches it and tallies the author.
 */

(() => {
  'use strict';

  const { xPostIdFrom, xHandleFrom } = globalThis.KillSlopParse;

  /** 'x:@handle' -> 'x:u:<rest_id>', learned from post data. Handles can change. */
  const users = new Map();

  const queue = new Map();
  let timer = 0;

  function flush() {
    const posts = [...queue.values()];
    queue.clear();
    if (!posts.length) return;
    chrome.runtime.sendMessage({ type: 'observe', posts }, () => void chrome.runtime.lastError);
  }

  // The page's world can send anything on this event: check every field.
  document.addEventListener('killslop:x-posts', (ev) => {
    let posts;
    try {
      posts = JSON.parse(ev.detail);
    } catch {
      return;
    }
    if (!Array.isArray(posts)) return;
    for (const p of posts.slice(0, 500)) {
      if (typeof p?.id !== 'string' || !/^\d{1,20}$/.test(p.id)) continue;
      const channelId = /^\d{1,20}$/.test(p.userId ?? '') ? `x:u:${p.userId}` : null;
      const alias = /^\w{1,15}$/.test(p.handle ?? '') ? `x:@${p.handle.toLowerCase()}` : null;
      if (alias && channelId) users.set(alias, channelId);
      queue.set(p.id, {
        id: `x:${p.id}`,
        channelId,
        alias,
        media: p.media === true,
        ai: p.ai === true,
        source: typeof p.source === 'string' ? p.source.slice(0, 32) : null,
      });
    }
    clearTimeout(timer);
    timer = setTimeout(flush, 250);
  });

  /**
   * The post's own permalink is the /status/ link around its timestamp. A
   * quoted post carries one too, inside a role="link" box; skip that one.
   */
  function permalink(el) {
    for (const time of el.querySelectorAll('a[href*="/status/"] time')) {
      const a = time.closest('a');
      if (!a.closest('div[role="link"]')) return a.getAttribute('href');
    }
    return null;
  }

  function authorHandle(el) {
    return xHandleFrom(el.querySelector('[data-testid="User-Name"] a[href^="/"]')?.getAttribute('href'));
  }

  globalThis.KillSlopFeed.start({
    platform: 'x',
    // Promoted posts have no timestamp link, so they never parse.
    selector: 'article[data-testid="tweet"]',
    noun: 'account',
    disclosureLabel: 'X labels this as made with AI',

    parse(el) {
      const id = xPostIdFrom(permalink(el));
      if (!id) return null;
      const alias = authorHandle(el);
      return { id, channelId: (alias && users.get(alias)) || alias };
    },

    // What the writing check reads: the post's own words, as shown. A quoted
    // post carries its own text node, so take this post's first one only.
    text: (el) => el.querySelector('[data-testid="tweetText"]')?.innerText.trim() || '',

    meta(el) {
      const text = el.querySelector('[data-testid="tweetText"]')?.innerText.trim() || '';
      const handle = authorHandle(el);
      return {
        title: text.replace(/\s+/g, ' ').slice(0, 120) || null,
        channel: handle ? handle.replace(/^x:/, '') : null,
      };
    },

    // The row of reply / repost / like / bookmark / share.
    voteHost: (el) => el.querySelector('[role="group"]'),
  });
})();
