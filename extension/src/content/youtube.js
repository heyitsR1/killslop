/**
 * YouTube surface adapter.
 *
 * Finds video tiles, asks the background for a verdict, and hides what comes
 * back as slop. Deliberately dumb: no network, no storage, no policy. If you
 * find yourself deciding what counts as slop in here, it belongs in core/.
 *
 * YouTube ships several generations of tile component simultaneously — the
 * classic `ytd-*-renderer` family and the newer `yt-lockup-view-model` used in
 * the watch sidebar. We match both and normalise them to {videoId, channelId}.
 */

(() => {
  'use strict';

  const TILE_SELECTOR = [
    'ytd-rich-item-renderer',      // home, subscriptions, channel grids
    'ytd-video-renderer',          // search results
    'ytd-compact-video-renderer',  // classic watch sidebar
    'yt-lockup-view-model',        // current watch sidebar / chips
    'ytd-grid-video-renderer',     // legacy grids
    'ytd-reel-item-renderer',      // legacy shorts shelf
    'ytm-shorts-lockup-view-model-v2', // current shorts shelf
  ].join(',');

  const MARK = 'data-killslop';
  const ID_ATTR = 'data-killslop-id';
  const CH_ATTR = 'data-killslop-ch';

  let settings = { action: 'hide', enabled: true };
  const known = new Map();   // videoId -> {slop, reason}
  const channelKnown = new Map(); // channelId -> {slop, reason}

  /* ---------------------------------------------------------------- parsing */

  const { videoIdFrom, channelIdFrom } = globalThis.KillSlopParse;
  const probeQueue = globalThis.KillSlopProbe;

  function parseTile(el) {
    if (el.hasAttribute(ID_ATTR)) {
      return { videoId: el.getAttribute(ID_ATTR), channelId: el.getAttribute(CH_ATTR) || null, el };
    }

    let videoId = null;
    let channelId = null;
    for (const a of el.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!videoId) videoId = videoIdFrom(href);
      if (!channelId) channelId = channelIdFrom(href);
      if (videoId && channelId) break;
    }
    if (!videoId) return null;

    el.setAttribute(ID_ATTR, videoId);
    if (channelId) el.setAttribute(CH_ATTR, channelId);
    return { videoId, channelId, el };
  }

  function tiles() {
    const out = [];
    for (const el of document.querySelectorAll(TILE_SELECTOR)) {
      // YouTube nests the new lockup inside the classic rich-item on the home
      // grid. Only the outermost tile is a tile; marking both hides twice and
      // paints two placeholders.
      if (el.parentElement?.closest(TILE_SELECTOR)) continue;
      const parsed = parseTile(el);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /* ----------------------------------------------------------------- render */

  const REASON_LABEL = {
    disclosure: 'Labelled AI by the creator',
    channel: 'Channel publishes AI content',
    community: 'Reported by the community',
    'community-channel': 'Channel reported by the community',
    'community-measured': "Channel's own uploads are labelled AI",
    you: 'You marked this as slop',
    'you-channel': 'You marked this channel as slop',
  };

  function apply(el, state, reason) {
    if (state === 'clear') {
      el.removeAttribute(MARK);
      el.querySelector('.killslop-card')?.remove();
      return;
    }
    if (el.getAttribute(MARK) !== state) el.setAttribute(MARK, state);
    if (state !== 'hidden') return;
    const label = REASON_LABEL[reason] || 'Hidden as AI slop';
    const existing = el.querySelector('.killslop-card__text');
    if (existing) {
      // Same tile, new reason (say you just marked its channel): relabel.
      if (existing.textContent !== label) existing.textContent = label;
      return;
    }

    // A hidden tile leaves a thin, quiet placeholder rather than vanishing, so
    // the filter is auditable and one click reverses it.
    const card = document.createElement('div');
    card.className = 'killslop-card';
    card.innerHTML = `
      <span class="killslop-card__dot" aria-hidden="true"></span>
      <span class="killslop-card__text">${label}</span>
      <button type="button" class="killslop-card__btn" data-act="show">Show</button>
      <button type="button" class="killslop-card__btn killslop-card__btn--ghost" data-act="notslop">Not slop</button>
    `;
    card.addEventListener('click', (ev) => {
      const act = ev.target?.dataset?.act;
      if (!act) return;
      ev.preventDefault();
      ev.stopPropagation();
      const videoId = el.getAttribute(ID_ATTR);
      if (act === 'show') {
        apply(el, 'revealed');
      } else if (act === 'notslop') {
        const meta = {
          title: el.querySelector('#video-title, h3')?.textContent.trim() || null,
          channel: el.querySelector('ytd-channel-name a, #channel-name a')?.textContent.trim() || null,
        };
        send('override', { id: videoId, kind: 'video', slop: false, meta });
        known.set(videoId, { slop: false, reason: 'you' });
        apply(el, 'clear');
      }
    });
    el.appendChild(card);
  }

  function paint() {
    for (const { videoId, channelId, el } of tiles()) {
      const v = known.get(videoId);
      const ch = channelId ? channelKnown.get(channelId) : null;
      const slop = v ? v.slop : ch?.slop === true;
      const reason = v?.reason || (ch?.slop ? ch.reason : null);

      if (el.getAttribute(MARK) === 'revealed') continue; // user asked to see it
      if (slop) {
        apply(el, settings.action === 'dim' ? 'dimmed' : 'hidden', reason);
      } else {
        apply(el, 'clear');
      }
    }
    paintVote();
  }

  /* ------------------------------------------------------------ vote button */

  // One button on whatever you're watching: a pill beside like/dislike on the
  // watch page, a round action in the Shorts bar. Its label is what KillSlop
  // currently thinks, so a click always corrects something you can see.

  // The "no" sign: a circle with a slash. Stroked, so it takes currentColor.
  const ICON_BAN =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>';
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  // One label, three looks. Grey is something you can do; red is a verdict,
  // solid when it's yours and tinted when KillSlop reached it on its own.
  const VOTE_STATES = {
    none: { label: 'AI SLOP', title: 'Mark as AI slop. Hides it for you right away.' },
    mine: { label: 'AI SLOP', title: 'You marked this as AI slop. Click to undo.' },
    channel: { label: 'AI SLOP', title: 'You marked this channel as AI slop. Click to undo.' },
    flagged: { label: 'AI SLOP', title: null }, // title is the reason
    notai: { label: 'NOT SLOP', title: 'You said this is not AI slop. Click to undo.' },
  };

  function voteState(v) {
    if (!v || v.pending) return 'none';
    if (v.reason === 'you') return v.slop ? 'mine' : 'notai';
    if (v.reason === 'you-channel') return v.slop ? 'channel' : 'notai';
    return v.slop ? 'flagged' : 'none';
  }

  const isShorts = () => location.pathname.startsWith('/shorts/');
  const isVisible = (el) => el.getBoundingClientRect().height > 0;

  /** The row the button lives in, and the sibling it goes after. */
  function voteHost() {
    if (isShorts()) {
      // Shorts reuse one action bar and swap its contents as you scroll.
      const bar = [...document.querySelectorAll('reel-action-bar-view-model')].find(isVisible);
      if (!bar) return null;
      const after =
        bar.querySelector(':scope > dislike-button-view-model') ||
        bar.querySelector(':scope > like-button-view-model');
      return { host: bar, after };
    }
    const row = document.querySelector('ytd-watch-metadata #top-level-buttons-computed');
    if (!row) return null;
    return { host: row, after: row.querySelector(':scope > segmented-like-dislike-button-view-model') };
  }

  let voteBtn = null;

  function removeVote() {
    voteBtn?.remove();
    voteBtn = null;
  }

  function paintVote() {
    const target = settings.enabled ? watchTarget() : null;
    const place = target && voteHost();
    if (!place) {
      removeVote();
      return;
    }

    const shorts = isShorts();
    if (!voteBtn || voteBtn.classList.contains('killslop-vote--shorts') !== shorts) {
      removeVote();
      voteBtn = document.createElement('button');
      voteBtn.type = 'button';
      voteBtn.className = shorts ? 'killslop-vote killslop-vote--shorts' : 'killslop-vote';
      voteBtn.addEventListener('click', onVoteClick);
    }
    // YouTube re-renders these rows freely; put the button back when it does.
    if (voteBtn.parentElement !== place.host) {
      if (place.after) place.after.after(voteBtn);
      else place.host.prepend(voteBtn);
    }

    const v = known.get(target.videoId);
    const state = voteState(v);
    const key = `${target.videoId}:${state}:${v?.reason ?? ''}`;
    // Unchanged: leave the DOM alone, or the observer re-triggers us forever.
    if (voteBtn.dataset.key === key) return;
    voteBtn.dataset.key = key;
    voteBtn.dataset.state = state;
    const spec = VOTE_STATES[state];
    const title = spec.title ?? `${REASON_LABEL[v.reason] || 'Flagged as AI slop'}. Click for options.`;
    voteBtn.title = title;
    voteBtn.setAttribute('aria-label', title);
    voteBtn.setAttribute('aria-pressed', String(state === 'mine' || state === 'channel'));
    voteBtn.innerHTML =
      `<span class="killslop-vote__icon">${state === 'notai' ? ICON_CHECK : ICON_BAN}</span>` +
      `<span class="killslop-vote__label">${spec.label}</span>`;
  }

  async function onVoteClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const target = watchTarget();
    if (!target) return;
    const { videoId, channelId } = target;
    const v = known.get(videoId);
    const meta = pageMeta();

    switch (voteState(v)) {
      case 'none':
        mark(videoId, 'video', true, meta);
        toast(
          settings.shareReports
            ? 'Marked as AI slop. Hidden for you now, and for everyone else once the community list confirms it.'
            : 'Marked as AI slop. Hidden for you.',
          [
            channelId && { label: 'Hide whole channel', run: () => markChannel(channelId, meta) },
            { label: 'Undo', run: () => undo(videoId) },
          ]
        );
        break;
      case 'flagged':
        toast(`${REASON_LABEL[v.reason] || 'Flagged as AI slop'}.`, [
          {
            label: 'Not slop',
            run: () => {
              mark(videoId, 'video', false, meta);
              toast("Got it. KillSlop won't flag this video for you.", [
                { label: 'Undo', run: () => undo(videoId) },
              ]);
            },
          },
          channelId && !v.reason.includes('channel') && {
            label: 'Hide whole channel',
            run: () => markChannel(channelId, meta),
          },
        ]);
        break;
      case 'mine':
      case 'notai':
      case 'channel': {
        const id = v.reason === 'you-channel' ? channelId : videoId;
        if (!id) return;
        undo(id);
        toast('Removed your mark.');
        break;
      }
    }
  }

  /** Title and channel name, so "Your marks" can list more than raw ids. */
  function pageMeta() {
    const title =
      (!isShorts() && document.querySelector('ytd-watch-metadata h1')?.textContent.trim()) ||
      document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '').trim();
    const owner = isShorts()
      ? [...document.querySelectorAll('yt-reel-channel-bar-view-model a[href]')].find(isVisible)
      : document.querySelector('ytd-watch-metadata ytd-channel-name a');
    return { title: title || null, channel: owner?.textContent.trim() || null };
  }

  function mark(id, kind, slop, meta = null) {
    // Flip the button now; the worker's broadcast confirms it a moment later.
    if (kind === 'video') known.set(id, { slop, reason: 'you' });
    paint();
    return send('override', { id, kind, slop, meta });
  }

  function markChannel(channelId, meta) {
    mark(channelId, 'channel', true, { title: meta?.channel || channelId, channel: null });
    toast('Channel marked as AI slop. Its videos are hidden for you.', [
      { label: 'Undo', run: () => undo(channelId) },
    ]);
  }

  function undo(id) {
    known.delete(id);
    paint();
    return send('undoOverride', { id });
  }

  let toastEl = null;
  let toastTimer = 0;

  function dismissToast() {
    clearTimeout(toastTimer);
    toastEl?.remove();
    toastEl = null;
  }

  /** A YouTube-style snackbar with optional actions. Replaces any open one. */
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

  /* ---------------------------------------------------------------- plumbing */

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(res?.result ?? null);
      });
    });
  }

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

  /**
   * The video currently being watched, which is not a tile. Resolving it costs
   * one probe and pays for itself: it seeds the channel tally, so a slop
   * channel gets recognised from the videos you actually open, not just from
   * feed sampling.
   */
  function watchTarget() {
    const videoId = videoIdFrom(location.href);
    if (!videoId) return null;
    let channelId = null;
    const owner = isShorts()
      ? [...document.querySelectorAll('yt-reel-channel-bar-view-model a[href]')].find(isVisible)
      : document.querySelector(
          'ytd-video-owner-renderer a[href], #owner a[href], ytd-channel-name a[href]'
        );
    if (owner) channelId = channelIdFrom(owner.getAttribute('href'));
    return { videoId, channelId };
  }

  async function scan() {
    if (!settings.enabled) return;
    const all = tiles();
    const pending = all.filter((t) => !known.has(t.videoId));

    // Probing is the expensive tier; only ask about what's near the viewport.
    const visible = pending.filter((t) => {
      const r = t.el.getBoundingClientRect();
      return r.bottom > -800 && r.top < window.innerHeight + 1600;
    });

    const watching = watchTarget();
    // Never drop the watched video from the queue just because it scrolled.
    probeQueue.retainOnly([
      ...visible.map((t) => t.videoId),
      ...(watching ? [watching.videoId] : []),
    ]);

    const items = visible.map(({ videoId, channelId }) => ({ videoId, channelId }));
    if (watching && !known.has(watching.videoId)) items.push(watching);
    if (!items.length) {
      paint();
      return;
    }

    const res = await send('resolve', { items });
    if (res) {
      for (const [videoId, v] of Object.entries(res.verdicts || {})) {
        if (!v.pending) known.set(videoId, v);
      }
      // Anything the worker couldn't settle, we probe from here — YouTube 403s
      // InnerTube requests that carry an extension origin.
      if (res.probe?.length) probeQueue.enqueue(res.probe);
    }
    paint();
  }

  /** Drop cached verdicts for every video we know belongs to these channels. */
  function forgetChannels(ids) {
    if (!ids.length) return;
    const set = new Set(ids);
    for (const el of document.querySelectorAll(`[${CH_ATTR}]`)) {
      if (set.has(el.getAttribute(CH_ATTR))) known.delete(el.getAttribute(ID_ATTR));
    }
    const watching = watchTarget();
    if (watching?.channelId && set.has(watching.channelId)) known.delete(watching.videoId);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'killslop:update') return;
    const { videoId, channelId, channelIds, slop, reason, cleared } = msg.update || {};
    const chIds = channelIds || (channelId ? [channelId] : []);

    // The user marked a whole channel, or took a mark back. What we cached for
    // the affected videos is stale: forget it and re-resolve, and the worker
    // walks every tier again in priority order.
    if (cleared || reason === 'you-channel') {
      if (videoId) known.delete(videoId);
      forgetChannels(chIds);
      for (const id of chIds) {
        if (cleared) channelKnown.delete(id);
        else channelKnown.set(id, { slop, reason });
      }
      paint();
      scheduleScan();
      return;
    }

    if (videoId) known.set(videoId, { slop, reason });
    for (const id of chIds) channelKnown.set(id, { slop, reason: reason || 'channel' });
    paint();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    send('getSettings').then((s) => {
      if (!s) return;
      settings = s;
      if (!settings.enabled || !settings.platforms?.youtube) {
        document.querySelectorAll(`[${MARK}]`).forEach((el) => apply(el, 'clear'));
        removeVote();
        dismissToast();
      } else {
        paint();
      }
    });
  });

  probeQueue.setResultHandler((result) => {
    send('probeResult', result);
  });

  function start() {
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('scroll', scheduleScan, { passive: true });
    document.addEventListener('yt-navigate-finish', scheduleScan);
    scheduleScan();
  }

  send('getSettings').then((s) => {
    if (s) settings = s;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  });
})();
