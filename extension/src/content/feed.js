/**
 * Feed engine for platforms where every post looks alike: X and LinkedIn.
 *
 * An adapter (x.js, linkedin.js) says how to find a post and read its ids.
 * This file does the rest: asks the background for verdicts, hides what comes
 * back as slop, puts an AI SLOP button on every post, and shows the toast.
 * Like youtube.js it holds no policy and makes no requests; if you find
 * yourself deciding what counts as slop in here, it belongs in core/.
 *
 * YouTube keeps its own adapter because it also owns the probe queue and the
 * watch page's single button. X and LinkedIn have no watch page, so the button
 * goes on each post, next to the post's own actions.
 *
 * Adapter:
 *   platform          'x' | 'linkedin', a key of PLATFORMS in core/settings.js
 *   selector          CSS for one post
 *   noun              what a channel is called here: 'account', 'author'
 *   disclosureLabel   why a post the platform labelled AI was hidden
 *   parse(el)         -> {id, channelId} or null; ids as in core/ids.js
 *   meta(el)          -> {title, channel}, for "Your marks"
 *   text(el)          -> the post's own words, for the writing check
 *   voteHost(el)      -> the element the post's AI SLOP button goes in, or null
 */

(() => {
  'use strict';

  const MARK = 'data-killslop';
  const ID_ATTR = 'data-killslop-id';
  const CH_ATTR = 'data-killslop-ch';

  // The "no" sign: a circle with a slash. Stroked, so it takes currentColor.
  const ICON_BAN =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res?.result ?? null);
      });
    });
  }

  function voteState(v) {
    if (!v || v.pending) return 'none';
    if (v.reason === 'you') return v.slop ? 'mine' : 'notai';
    if (v.reason === 'you-channel') return v.slop ? 'channel' : 'notai';
    return v.slop ? 'flagged' : 'none';
  }

  /**
   * Cards and the toast follow the page's theme. Neither site marks its theme
   * in a way worth depending on, so read the page's background instead.
   */
  function syncTheme() {
    const html = document.documentElement;
    let theme = 'light';
    for (const el of [document.body, html]) {
      if (!el) continue;
      const [r, g, b, a = 1] = (getComputedStyle(el).backgroundColor.match(/[\d.]+/g) || []).map(Number);
      if (r === undefined || a === 0) continue;
      theme = 0.2126 * r + 0.7152 * g + 0.0722 * b > 128 ? 'light' : 'dark';
      break;
    }
    if (html.dataset.killslopTheme !== theme) html.dataset.killslopTheme = theme;
  }

  /* ------------------------------------------------------------------ toast */

  let toastEl = null;
  let toastTimer = 0;

  function dismissToast() {
    clearTimeout(toastTimer);
    toastEl?.remove();
    toastEl = null;
  }

  /** A snackbar with optional actions. Replaces any open one. */
  function toast(text, actions = []) {
    dismissToast();
    const el = document.createElement('div');
    el.className = 'killslop-toast';
    el.setAttribute('role', 'status');
    const msg = document.createElement('span');
    msg.className = 'killslop-toast__text';
    msg.textContent = text;
    el.append(msg);
    for (const action of actions.filter(Boolean)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'killslop-toast__btn';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        dismissToast();
        action.run();
      });
      el.append(btn);
    }
    // Hovering holds it open, so Undo never vanishes mid-reach.
    el.addEventListener('mouseenter', () => clearTimeout(toastTimer));
    el.addEventListener('mouseleave', () => {
      toastTimer = setTimeout(dismissToast, 3000);
    });
    document.body.append(el);
    toastEl = el;
    toastTimer = setTimeout(dismissToast, 7000);
  }

  /* ----------------------------------------------------------------- engine */

  function start(adapter) {
    const { platform, selector, noun } = adapter;

    const REASON_LABEL = {
      disclosure: adapter.disclosureLabel,
      channel: `This ${noun} often posts AI media`,
      writing: 'Reads as AI-written',
      community: 'Reported by the community',
      'community-channel': `This ${noun} was reported by the community`,
      'community-measured': `This ${noun}'s own posts are labelled AI`,
      you: 'You marked this as slop',
      'you-channel': `You marked this ${noun} as slop`,
    };
    const reasonText = (reason) => REASON_LABEL[reason] || 'Hidden as AI slop';

    const VOTE_TITLES = {
      none: 'Mark as AI slop. Hides it for you right away.',
      mine: 'You marked this as AI slop. Click to undo.',
      channel: `You marked this ${noun} as AI slop. Click to undo.`,
      notai: 'You said this is not AI slop. Click to undo.',
    };

    let settings = { enabled: false, action: 'hide', platforms: {} };
    const on = () => Boolean(settings.enabled && settings.platforms?.[platform]);
    const known = new Map(); // post id -> {slop, reason}
    const channelKnown = new Map(); // channel id -> {slop, reason}
    const asking = new Set(); // post ids with a resolve in flight

    /* -------------------------------------------------------------- parsing */

    function reset(el) {
      el.removeAttribute(MARK);
      el.querySelector('.killslop-card')?.remove();
      el.querySelector('.killslop-vote')?.remove();
    }

    function parseTile(el) {
      const p = adapter.parse(el);
      if (!p?.id) return null;
      // A post element can be reused for another post as the list scrolls. An
      // id cached on it would then hide the wrong post, so re-read every time.
      if (el.getAttribute(ID_ATTR) !== p.id) {
        if (el.hasAttribute(ID_ATTR)) reset(el);
        el.setAttribute(ID_ATTR, p.id);
      }
      if (p.channelId) el.setAttribute(CH_ATTR, p.channelId);
      else el.removeAttribute(CH_ATTR);
      return { id: p.id, channelId: p.channelId || null, el };
    }

    function tiles() {
      const out = [];
      for (const el of document.querySelectorAll(selector)) {
        if (el.parentElement?.closest(selector)) continue; // a post inside a post
        const t = parseTile(el);
        if (t) out.push(t);
      }
      return out;
    }

    /* --------------------------------------------------------------- render */

    function apply(el, state, reason) {
      if (state === 'clear') {
        if (el.hasAttribute(MARK)) el.removeAttribute(MARK);
        el.querySelector('.killslop-card')?.remove();
        return;
      }
      if (el.getAttribute(MARK) !== state) el.setAttribute(MARK, state);
      if (state !== 'hidden') return;
      const label = reasonText(reason);
      const existing = el.querySelector('.killslop-card__text');
      if (existing) {
        if (existing.textContent !== label) existing.textContent = label;
        return;
      }

      // A hidden post leaves a thin, quiet placeholder rather than vanishing,
      // so the filter is auditable and one click reverses it.
      const card = document.createElement('div');
      card.className = 'killslop-card';
      const dot = document.createElement('span');
      dot.className = 'killslop-card__dot';
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'killslop-card__text';
      text.textContent = label;
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'killslop-card__btn';
      show.dataset.act = 'show';
      show.textContent = 'Show';
      const notSlop = document.createElement('button');
      notSlop.type = 'button';
      notSlop.className = 'killslop-card__btn killslop-card__btn--ghost';
      notSlop.dataset.act = 'notslop';
      notSlop.textContent = 'Not slop';
      card.append(dot, text, show, notSlop);
      card.addEventListener('click', (ev) => {
        const act = ev.target?.dataset?.act;
        // Both sites open the post on any click inside it; the card is ours.
        ev.preventDefault();
        ev.stopPropagation();
        if (act === 'show') {
          apply(el, 'revealed');
          paint();
        } else if (act === 'notslop') {
          const id = el.getAttribute(ID_ATTR);
          send('override', { id, kind: 'video', slop: false, meta: adapter.meta(el) });
          known.set(id, { slop: false, reason: 'you' });
          apply(el, 'clear');
          paint();
        }
      });
      el.prepend(card);
    }

    function paintVote(t) {
      let btn = t.el.querySelector('.killslop-vote');
      const host = on() ? adapter.voteHost(t.el) : null;
      if (!host) {
        btn?.remove();
        return;
      }
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'killslop-vote';
        btn.addEventListener('click', onVoteClick);
      }
      // Both sites re-render a post's actions freely; put the button back.
      if (btn.parentElement !== host) host.append(btn);

      const v = known.get(t.id);
      const state = voteState(v);
      const key = `${t.id}:${state}:${v?.reason ?? ''}`;
      // Unchanged: leave the DOM alone, or the observer re-triggers us forever.
      if (btn.dataset.key === key) return;
      btn.dataset.key = key;
      btn.dataset.state = state;
      const title = VOTE_TITLES[state] ?? `${reasonText(v?.reason)}. Click for options.`;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.setAttribute('aria-pressed', String(state === 'mine' || state === 'channel'));
      btn.innerHTML =
        `<span class="killslop-vote__icon">${state === 'notai' ? ICON_CHECK : ICON_BAN}</span>` +
        `<span class="killslop-vote__label">${state === 'notai' ? 'NOT SLOP' : 'AI SLOP'}</span>`;
    }

    function paint() {
      syncTheme();
      for (const t of tiles()) {
        const v = known.get(t.id);
        const ch = t.channelId ? channelKnown.get(t.channelId) : null;
        const slop = v ? v.slop : ch?.slop === true;
        const reason = v?.reason || (ch?.slop ? ch.reason : null);

        if (t.el.getAttribute(MARK) !== 'revealed') {
          if (on() && slop) apply(t.el, settings.action === 'dim' ? 'dimmed' : 'hidden', reason);
          else apply(t.el, 'clear');
        }
        paintVote(t);
      }
    }

    /* ---------------------------------------------------------------- votes */

    function mark(id, kind, slop, meta = null) {
      // Flip the button now; the worker's broadcast confirms it a moment later.
      if (kind === 'video') known.set(id, { slop, reason: 'you' });
      paint();
      return send('override', { id, kind, slop, meta });
    }

    function markChannel(channelId, meta) {
      mark(channelId, 'channel', true, { title: meta?.channel || channelId, channel: null });
      toast(`Marked this ${noun} as AI slop. Its posts are hidden for you.`, [
        { label: 'Undo', run: () => undo(channelId) },
      ]);
    }

    function undo(id) {
      known.delete(id);
      paint();
      return send('undoOverride', { id });
    }

    function onVoteClick(ev) {
      // The button sits inside the post, and a click on the post opens it.
      ev.preventDefault();
      ev.stopPropagation();
      const el = ev.currentTarget.closest(`[${ID_ATTR}]`);
      if (!el) return;
      const id = el.getAttribute(ID_ATTR);
      const channelId = el.getAttribute(CH_ATTR);
      const v = known.get(id);
      const meta = adapter.meta(el);
      const hideChannel = channelId && {
        label: `Hide this ${noun}`,
        run: () => markChannel(channelId, meta),
      };

      switch (voteState(v)) {
        case 'none':
          mark(id, 'video', true, meta);
          toast(
            settings.shareReports
              ? 'Marked as AI slop. Hidden for you now, and for everyone else once the community list confirms it.'
              : 'Marked as AI slop. Hidden for you.',
            [hideChannel, { label: 'Undo', run: () => undo(id) }]
          );
          break;
        case 'flagged':
          toast(`${reasonText(v.reason)}.`, [
            {
              label: 'Not slop',
              run: () => {
                mark(id, 'video', false, meta);
                toast("Got it. KillSlop won't flag this post for you.", [
                  { label: 'Undo', run: () => undo(id) },
                ]);
              },
            },
            !String(v.reason).includes('channel') && hideChannel,
          ]);
          break;
        case 'mine':
        case 'notai':
        case 'channel': {
          const target = v.reason === 'you-channel' ? channelId : id;
          if (!target) return;
          undo(target);
          toast('Removed your mark.');
          break;
        }
      }
    }

    /* -------------------------------------------------------------- resolve */

    let scanScheduled = false;
    function scheduleScan() {
      if (scanScheduled) return;
      scanScheduled = true;
      requestIdleCallback(
        () => {
          scanScheduled = false;
          scan();
        },
        { timeout: 500 }
      );
    }

    async function scan() {
      if (!on()) return;
      // Only ask about what is near the viewport; the rest waits for a scroll.
      const near = tiles().filter((t) => {
        const r = t.el.getBoundingClientRect();
        return r.bottom > -800 && r.top < window.innerHeight + 1600;
      });
      const ask = near.filter((t) => !known.has(t.id) && !asking.has(t.id));
      if (ask.length) {
        for (const t of ask) asking.add(t.id);
        const res = await send('resolve', {
          platform,
          items: ask.map(({ id, channelId }) => ({ videoId: id, channelId })),
        });
        for (const t of ask) asking.delete(t.id);
        for (const [id, v] of Object.entries(res?.verdicts || {})) {
          if (!v.pending) known.set(id, v);
        }
        if (res?.check?.length) await checkWriting(res.check);
      }
      paint();
    }

    /**
     * Posts nothing else could place. Their text is read here and gated here:
     * a post whose writing shows none of the signs is settled locally and its
     * words never leave the page. Only what is left is handed to the
     * background, which asks by hash before it sends anything.
     */
    async function checkWriting(items) {
      const signs = globalThis.KillSlopSigns;
      if (!signs || typeof adapter.text !== 'function') return;

      const byId = new Map(tiles().map((t) => [t.id, t.el]));
      const posts = [];
      for (const { videoId } of items) {
        const el = byId.get(videoId);
        if (!el) continue;
        const { suspicious, text } = signs.prefilter(adapter.text(el));
        if (!suspicious) {
          known.set(videoId, { slop: false, reason: 'none' });
          continue;
        }
        posts.push({ id: videoId, text });
      }
      if (!posts.length) return;

      const res = await send('checkWriting', { platform, posts });
      for (const [id, v] of Object.entries(res?.verdicts || {})) known.set(id, v);
    }

    /** Forget cached verdicts for every post we know belongs to these channels. */
    function forgetChannels(ids) {
      const set = new Set(ids);
      for (const el of document.querySelectorAll(`[${CH_ATTR}]`)) {
        if (set.has(el.getAttribute(CH_ATTR))) known.delete(el.getAttribute(ID_ATTR));
      }
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== 'killslop:update') return;
      const { videoId, channelId, channelIds, slop, reason, cleared } = msg.update || {};
      const chIds = channelIds || (channelId ? [channelId] : []);

      // A channel's standing changed: you marked it, took a mark back, or it
      // crossed the threshold. What we cached for its posts is stale: forget
      // it and re-resolve, so the background walks every tier in order again.
      if (chIds.length) {
        if (videoId) known.delete(videoId);
        forgetChannels(chIds);
        for (const id of chIds) {
          if (cleared) channelKnown.delete(id);
          else channelKnown.set(id, { slop, reason: reason || 'channel' });
        }
        paint();
        scheduleScan();
        return;
      }

      if (videoId) {
        if (cleared) known.delete(videoId);
        else known.set(videoId, { slop, reason });
      }
      paint();
      if (cleared) scheduleScan();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      send('getSettings').then((s) => {
        if (!s) return;
        settings = s;
        if (!on()) {
          document.querySelectorAll(`[${ID_ATTR}]`).forEach(reset);
          dismissToast();
        } else {
          paint();
          scheduleScan();
        }
      });
    });

    function observe() {
      new MutationObserver(scheduleScan).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      window.addEventListener('scroll', scheduleScan, { passive: true });
      scheduleScan();
    }

    send('getSettings').then((s) => {
      if (s) settings = s;
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', observe, { once: true });
      } else {
        observe();
      }
    });
  }

  globalThis.KillSlopFeed = { start };
})();
