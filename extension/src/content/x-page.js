/**
 * Runs in x.com's own page world, not the extension's ("world": "MAIN" in the
 * manifest), because only there can it see the API responses the page already
 * receives. X marks AI media on the post object itself (RESEARCH.md section
 * 12); the rendered label is a bare, tool-dependent text line with nothing
 * stable to select on (section 14), so this reads the mark from the data.
 *
 * It sends nothing anywhere and never changes a request or a response. Each
 * response it reads is summarised as {id, userId, handle, media, ai, source}
 * per post and handed to the content script (x.js) as a DOM event.
 */

(() => {
  'use strict';

  const EVENT = 'killslop:x-posts';

  function isApi(url) {
    try {
      const u = new URL(String(url), location.href);
      return /^(x|twitter)\.com$/.test(u.hostname) && u.pathname.startsWith('/i/api/');
    } catch {
      return false;
    }
  }

  /**
   * Every Tweet object in a response, wherever the timeline nests it (entries,
   * modules, quoted posts, visibility wrappers). Keyed by id: one response can
   * carry the same post twice.
   */
  function postsFrom(json) {
    const out = new Map();
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 64) return;
      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth + 1);
        return;
      }
      // Posts are typed 'Tweet'. A visibility wrapper (TweetWithVisibilityResults)
      // holds its post under `tweet`; recognise that one by shape as well.
      if (
        typeof node.rest_id === 'string' &&
        (node.__typename === 'Tweet' || typeof node.legacy?.full_text === 'string')
      ) {
        const user = node.core?.user_results?.result;
        const mark = node.content_disclosure?.ai_generated_disclosure;
        const post = {
          id: node.rest_id,
          userId: typeof user?.rest_id === 'string' ? user.rest_id : null,
          handle: user?.core?.screen_name ?? user?.legacy?.screen_name ?? null,
          media: (node.legacy?.extended_entities?.media?.length ?? 0) > 0,
          ai: mark?.has_ai_generated_media === true,
          source: mark?.ai_generated_detection_source ?? null,
        };
        // A second copy of a post may be trimmed; one copy's label is enough.
        const prev = out.get(post.id);
        out.set(
          post.id,
          prev
            ? {
                ...post,
                userId: prev.userId ?? post.userId,
                handle: prev.handle ?? post.handle,
                media: prev.media || post.media,
                ai: prev.ai || post.ai,
                source: prev.source ?? post.source,
              }
            : post
        );
      }
      for (const v of Object.values(node)) walk(v, depth + 1);
    };
    walk(json, 0);
    return [...out.values()];
  }

  function read(text) {
    // Most API traffic (badges, typeahead, settings) holds no posts; skip the parse.
    if (typeof text !== 'string' || !text.includes('"Tweet"')) return;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const posts = postsFrom(json);
    // A string crosses from the page's world to the extension's intact.
    if (posts.length) document.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify(posts) }));
  }

  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const pending = nativeFetch.apply(this, args);
    pending.then(
      (res) => {
        if (isApi(res.url)) res.clone().text().then(read, () => {});
      },
      () => {}
    );
    return pending;
  };

  function onXhrLoad() {
    if (this.responseType === '' || this.responseType === 'text') read(this.responseText);
    else if (this.responseType === 'json' && this.response) read(JSON.stringify(this.response));
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (isApi(url)) this.addEventListener('load', onXhrLoad);
    return nativeOpen.call(this, method, url, ...rest);
  };
})();
