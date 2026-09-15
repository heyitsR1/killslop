/* KillSlop console. Plain DOM and fetch: no framework, no build step, and no
   inline handlers (the CSP forbids them). Every value that came from the
   database goes in through textContent, never innerHTML. */

'use strict';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function link(href, className, text) {
  const a = el('a', className, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function img(src) {
  const i = el('img');
  i.src = src;
  i.alt = '';
  i.loading = 'lazy';
  return i;
}

function button(label, modifiers, onClick) {
  const b = el('button', modifiers ? `btn ${modifiers}` : 'btn', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

async function api(path, body) {
  const init =
    body === undefined
      ? { headers: { accept: 'application/json' } }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  if (res.status === 401) {
    location.reload(); // the session ran out; the reload lands on the sign-in page
    throw new Error('Signed out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------- formatting */

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function ago(ts) {
  if (!ts) return '';
  const mins = Math.round((ts - Date.now()) / 60000);
  if (mins > -1) return 'just now';
  if (mins > -60) return rtf.format(mins, 'minute');
  const hours = Math.round(mins / 60);
  if (hours > -24) return rtf.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days > -30) return rtf.format(days, 'day');
  return new Date(ts).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

const fullDate = (ts) => new Date(ts).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const initial = (text) => (text || '?').replace(/^@/, '').trim().charAt(0).toUpperCase() || '?';

const ytUrl = (e) =>
  e.kind === 'video'
    ? `https://www.youtube.com/watch?v=${e.id}`
    : e.id.startsWith('@')
      ? `https://www.youtube.com/${e.id}`
      : `https://www.youtube.com/channel/${e.id}`;
const thumbUrl = (videoId) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

/* ------------------------------------------------------------------- copy */

const MODE = {
  all: ['Review: everything', 'Nothing reaches clients until you approve it here.'],
  votes: [
    'Review: votes only',
    'Channels measured by two or more reporters publish on their own. Votes wait for you.',
  ],
  off: ['Review: off', 'The automatic thresholds decide. Your calls here still override them.'],
};

const LEDE = {
  queue:
    'Reported by people using KillSlop and not reviewed yet. Check each one on YouTube, then approve it into the final database or reject it.',
  slop:
    'The final database: what clients are served, and what the public export at /api/v1/export/youtube-channels.json contains.',
  clean:
    'Rejected entries are never served, whatever the votes say. Move one back to the queue to reconsider it.',
};

const EMPTY = {
  queue: 'The queue is empty. New reports show up here.',
  slop: 'Nothing approved yet. Approve entries from the queue, or paste a link above.',
  clean: 'Nothing rejected.',
};

/** [label, review it sets, button style] per tab. */
const ACTIONS = {
  queue: [
    ['Approve', 'slop', 'btn--primary'],
    ['Reject', 'clean', ''],
  ],
  slop: [
    ['Move to queue', null, ''],
    ['Reject', 'clean', ''],
  ],
  clean: [
    ['Move to queue', null, ''],
    ['Approve', 'slop', ''],
  ],
};

const DONE = { slop: 'Approved', clean: 'Rejected', queue: 'Moved back to the queue' };
const DEFAULT_SORT = { queue: 'signal', slop: 'reviewed', clean: 'reviewed' };
const CATEGORY = { bug: 'Bug', wrong: 'Wrong call', idea: 'Idea', other: 'Other' };

/* ------------------------------------------------------------------ state */

const TABS = ['queue', 'slop', 'clean', 'feedback'];
const state = { tab: 'queue', kind: '', sort: 'signal', offset: 0, fbStatus: 'new', fbOffset: 0 };
/** The entry behind each rendered row. */
const rowEntry = new WeakMap();
/** Bumped by every list load, so a slow response cannot paint over a newer one. */
let seq = 0;

/* ------------------------------------------------------------------ toast */

let toastTimer = 0;

function toast(message, action) {
  const box = $('toast');
  box.replaceChildren(el('span', 'toast__text', message));
  if (action) {
    box.append(
      button(action.label, 'btn--sm btn--inverse', () => {
        box.hidden = true;
        action.run();
      })
    );
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), action ? 8000 : 3500);
}

/* --------------------------------------------------------------- overview */

async function refreshCounts() {
  let o;
  try {
    o = await api('/admin/api/overview');
  } catch (err) {
    toast(err.message);
    return;
  }
  const total = (byKind) => Object.values(byKind || {}).reduce((a, b) => a + b, 0);
  const counts = {
    queue: total(o.entries.queue),
    slop: total(o.entries.slop),
    clean: total(o.entries.clean),
    feedback: o.feedback.new || 0,
  };
  for (const [key, n] of Object.entries(counts)) {
    document.querySelector(`[data-count="${key}"]`).textContent = n ? n.toLocaleString() : '';
  }
  const [label, detail] = MODE[o.mode] || MODE.all;
  $('mode').textContent = label;
  $('mode').title = detail;
}

/* -------------------------------------------------------- YouTube lookups */

// Each lookup can cost the worker several requests to YouTube; keep a few in
// flight rather than firing one per row at once.
const metaJobs = [];
let metaActive = 0;

function queueMeta(job) {
  metaJobs.push(job);
  // A row queues its lookup before it is appended; start once it is on the page.
  queueMicrotask(pumpMeta);
}

function pumpMeta() {
  while (metaActive < 3 && metaJobs.length) {
    metaActive += 1;
    metaJobs
      .shift()()
      .finally(() => {
        metaActive -= 1;
        pumpMeta();
      });
  }
}

function loadMeta(row, refresh = false) {
  const e = rowEntry.get(row);
  row.querySelector('.check').replaceChildren(el('span', 'check__muted', 'Checking YouTube...'));
  queueMeta(() =>
    row.isConnected
      ? api(`/admin/api/meta?hash=${e.hash}${refresh ? '&refresh=1' : ''}`)
          .then((info) => paintMeta(row, info))
          .catch(() => paintMeta(row, null))
      : Promise.resolve()
  );
}

function paintMeta(row, info) {
  const e = rowEntry.get(row);
  const meta = info?.meta ?? null;

  if (info?.title) {
    row.querySelector('.entry__title').textContent = info.title;
    const avatar = row.querySelector('.entry__avatar');
    if (avatar) avatar.textContent = initial(info.title);
  }

  const bits = [e.id];
  if (e.kind === 'video' && meta?.channel) {
    bits.unshift(meta.handle ? `${meta.channel} (${meta.handle})` : meta.channel);
  }
  if (e.kind === 'channel' && meta?.ucid && meta.ucid !== e.id) bits.push(meta.ucid);
  row.querySelector('.entry__sub').textContent = bits.join(' · ');

  const check = row.querySelector('.check');
  check.replaceChildren();
  if (!info) {
    check.append(el('span', 'check__muted', 'Could not reach YouTube.'));
  } else if (meta?.unavailable) {
    check.append(
      el(
        'span',
        'check__muted',
        e.kind === 'video'
          ? 'Unavailable on YouTube: deleted, private, or not embeddable.'
          : 'Channel not found on YouTube.'
      )
    );
  } else if (e.kind === 'video') {
    check.append(videoLabel(meta?.aiLabel));
  } else {
    channelCheck(check, meta);
  }
  check.append(button('Recheck', 'btn--link', () => loadMeta(row, true)));
}

function videoLabel(ai) {
  if (ai === true) return el('span', 'label label--ai', "Carries YouTube's AI label");
  if (ai === false) return el('span', 'label', 'No YouTube AI label');
  return el('span', 'check__muted', 'AI label not checked');
}

function channelCheck(check, meta) {
  const labelled = meta?.labelled;
  if (labelled?.total) {
    const heavy = labelled.ai / labelled.total >= 0.6;
    check.append(
      el(
        'span',
        heavy ? 'label label--ai' : 'label',
        `AI label on ${labelled.ai} of ${plural(labelled.total, 'recent upload')}`
      )
    );
  }
  const recent = meta?.recent || [];
  if (!recent.length) {
    if (!labelled?.total) check.append(el('span', 'check__muted', 'No recent uploads found.'));
    return;
  }
  const strip = el('div', 'strip');
  for (const v of recent) {
    const a = link(`https://www.youtube.com/watch?v=${v.id}`, 'strip__item');
    a.title = v.title || v.id;
    a.append(img(thumbUrl(v.id)));
    if (v.ai) a.append(el('span', 'strip__ai', 'AI'));
    strip.append(a);
  }
  check.append(strip);
}

/* ---------------------------------------------------------------- entries */

function signals(e) {
  const out = [];
  if (e.tallies) {
    out.push([
      `Measured by ${plural(e.tallies, 'reporter')}: ${e.tally_ai} of ${e.tally_total} sampled uploads labelled AI`,
      'strong',
    ]);
  }
  if (e.up || e.down) {
    out.push([`${plural(e.up, 'slop vote')}, ${plural(e.down, 'not-slop vote')}`, e.up - e.down >= 3 ? 'strong' : '']);
  }
  if (!e.tallies && !e.up && !e.down) out.push(['No votes', '']);
  if (e.served && !e.review) out.push(['Served without review', 'warn']);
  return out;
}

function timeline(e) {
  const parts = [`First seen ${ago(e.created)}`];
  if (e.updated > e.created) parts.push(`last activity ${ago(e.updated)}`);
  if (e.review && e.reviewed_at) parts.push(`${DONE[e.review].toLowerCase()} ${ago(e.reviewed_at)}`);
  return parts.join(' · ');
}

function entryRow(e) {
  const row = el('article', 'entry');
  row.tabIndex = 0;
  rowEntry.set(row, e);
  const url = ytUrl(e);

  const media = link(url, e.kind === 'video' ? 'entry__media' : 'entry__media entry__media--channel');
  media.tabIndex = -1;
  media.setAttribute('aria-hidden', 'true');
  media.append(e.kind === 'video' ? img(thumbUrl(e.id)) : el('span', 'entry__avatar', initial(e.title || e.id)));

  const head = el('div', 'entry__head');
  head.append(
    el('span', 'tag', e.kind === 'channel' ? 'Channel' : 'Video'),
    link(url, 'entry__title', e.title || e.id)
  );

  const chips = el('div', 'chips');
  for (const [text, tone] of signals(e)) chips.append(el('span', tone ? `chip chip--${tone}` : 'chip', text));

  const body = el('div', 'entry__body');
  body.append(head, el('div', 'entry__sub', e.id), chips, el('div', 'check'), el('div', 'entry__times', timeline(e)));

  const actions = el('div', 'entry__actions');
  for (const [label, review, style] of ACTIONS[state.tab]) {
    actions.append(button(label, style, () => setReview(row, review)));
  }

  row.append(media, body, actions);
  if (e.meta_at) paintMeta(row, { title: e.title, meta: e.meta });
  else loadMeta(row);
  return row;
}

function dropRow(row, list, empty, emptyText) {
  const hadFocus = row.contains(document.activeElement);
  const next = row.nextElementSibling || row.previousElementSibling;
  row.remove();
  if (hadFocus && next) next.focus();
  if (!list.childElementCount) {
    empty.textContent = emptyText;
    empty.hidden = false;
  }
}

async function setReview(row, next) {
  const e = rowEntry.get(row);
  const before = e.review ?? null;
  if (next === before || row.classList.contains('entry--busy')) return;
  row.classList.add('entry--busy');
  try {
    await api('/admin/api/review', { hash: e.hash, review: next });
  } catch (err) {
    row.classList.remove('entry--busy');
    toast(err.message);
    return;
  }
  state.offset -= 1;
  dropRow(row, $('list'), $('empty'), EMPTY[state.tab]);
  refreshCounts();
  toast(`${DONE[next ?? 'queue']}: ${e.title || e.id}`, {
    label: 'Undo',
    run: async () => {
      try {
        await api('/admin/api/review', { hash: e.hash, review: before });
      } catch (err) {
        toast(err.message);
      }
      refreshCounts();
      loadEntries(true);
    },
  });
}

async function loadEntries(reset) {
  const mine = ++seq;
  if (reset) {
    state.offset = 0;
    metaJobs.length = 0;
    $('list').replaceChildren(el('p', 'loading', 'Loading...'));
    $('more').hidden = true;
    $('empty').hidden = true;
  }
  const q = new URLSearchParams({ status: state.tab, sort: state.sort, offset: String(state.offset) });
  if (state.kind) q.set('kind', state.kind);

  let data;
  try {
    data = await api(`/admin/api/entries?${q}`);
  } catch (err) {
    if (mine === seq) $('list').replaceChildren(el('p', 'error', err.message));
    return;
  }
  if (mine !== seq) return;
  if (reset) $('list').replaceChildren();
  for (const e of data.entries) $('list').append(entryRow(e));
  state.offset += data.entries.length;
  $('more').hidden = !data.more;
  $('empty').textContent = EMPTY[state.tab];
  $('empty').hidden = $('list').childElementCount > 0;
}

async function addLink(ev) {
  ev.preventDefault();
  const input = $('add-input').value.trim();
  if (!input) return;
  const submit = $('add').querySelector('button');
  const msg = $('add-msg');
  submit.disabled = true;
  try {
    const r = await api('/admin/api/add', { input });
    $('add-input').value = '';
    msg.className = 'add__msg';
    msg.textContent = `Added ${r.title || r.id} to the final database${r.twins ? ', with its other spelling' : ''}.`;
    refreshCounts();
    loadEntries(true);
  } catch (err) {
    msg.className = 'add__msg add__msg--error';
    msg.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

/* --------------------------------------------------------------- feedback */

function feedbackRow(f) {
  const row = el('article', f.status === 'new' ? 'fb fb--new' : 'fb');

  const head = el('div', 'fb__head');
  const when = el('time', 'fb__when', ago(f.created));
  when.dateTime = new Date(f.created).toISOString();
  when.title = fullDate(f.created);
  head.append(el('span', `tag tag--${f.category}`, CATEGORY[f.category] || 'Other'), when);
  if (f.version) head.append(el('span', 'fb__version', `v${f.version}`));

  const foot = el('div', 'fb__foot');
  if (f.email) {
    const mail = el('a', 'fb__email', f.email);
    mail.href = `mailto:${f.email}?subject=${encodeURIComponent('Re: your KillSlop feedback')}`;
    foot.append(mail);
  } else {
    foot.append(el('span', 'fb__noemail', 'No email left'));
  }
  foot.append(el('span', 'spacer'));

  const toggle = button(f.status === 'new' ? 'Mark handled' : 'Mark as new', 'btn--sm', async () => {
    const status = f.status === 'new' ? 'done' : 'new';
    try {
      await api('/admin/api/feedback/status', { id: f.id, status });
    } catch (err) {
      toast(err.message);
      return;
    }
    refreshCounts();
    if (state.fbStatus && state.fbStatus !== status) {
      dropFeedback(row);
    } else {
      f.status = status;
      row.replaceWith(feedbackRow(f));
    }
  });

  // Two clicks rather than a confirm() dialog.
  let armed = 0;
  const del = button('Delete', 'btn--sm btn--quiet', async () => {
    if (!armed) {
      del.textContent = 'Click again to delete';
      del.classList.add('btn--danger');
      armed = setTimeout(() => {
        armed = 0;
        del.textContent = 'Delete';
        del.classList.remove('btn--danger');
      }, 4000);
      return;
    }
    clearTimeout(armed);
    try {
      await api('/admin/api/feedback/delete', { id: f.id });
    } catch (err) {
      toast(err.message);
      return;
    }
    dropFeedback(row);
    refreshCounts();
    toast('Feedback deleted.');
  });

  foot.append(toggle, del);
  row.append(head, el('p', 'fb__message', f.message), foot);
  return row;
}

function dropFeedback(row) {
  state.fbOffset -= 1;
  dropRow(row, $('fb-list'), $('fb-empty'), 'Nothing here.');
}

async function loadFeedback(reset) {
  const mine = ++seq;
  if (reset) {
    state.fbOffset = 0;
    $('fb-list').replaceChildren(el('p', 'loading', 'Loading...'));
    $('fb-more').hidden = true;
    $('fb-empty').hidden = true;
  }
  const q = new URLSearchParams({ offset: String(state.fbOffset) });
  if (state.fbStatus) q.set('status', state.fbStatus);

  let data;
  try {
    data = await api(`/admin/api/feedback?${q}`);
  } catch (err) {
    if (mine === seq) $('fb-list').replaceChildren(el('p', 'error', err.message));
    return;
  }
  if (mine !== seq) return;
  if (reset) $('fb-list').replaceChildren();
  for (const f of data.feedback) $('fb-list').append(feedbackRow(f));
  state.fbOffset += data.feedback.length;
  $('fb-more').hidden = !data.more;
  $('fb-empty').textContent = state.fbStatus === 'new' ? 'No new feedback.' : 'No feedback yet.';
  $('fb-empty').hidden = $('fb-list').childElementCount > 0;
}

/* -------------------------------------------------------------- navigation */

function selectTab(tab) {
  if (!TABS.includes(tab)) tab = 'queue';
  state.tab = tab;
  for (const b of $('tabs').querySelectorAll('[role="tab"]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }
  history.replaceState(null, '', `#${tab}`);

  const feedback = tab === 'feedback';
  $('view-entries').hidden = feedback;
  $('view-feedback').hidden = !feedback;
  if (feedback) {
    loadFeedback(true);
    return;
  }
  $('lede').textContent = LEDE[tab];
  $('add').hidden = tab !== 'slop';
  $('add-msg').textContent = '';
  state.sort = DEFAULT_SORT[tab];
  $('sort').value = state.sort;
  loadEntries(true);
}

function segmented(group, key, onPick) {
  group.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || !group.contains(b)) return;
    for (const x of group.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    onPick(b.dataset[key]);
  });
}

/** J/K move between rows; A, R and Q review the focused one. */
function onKey(ev) {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || state.tab === 'feedback') return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
  const rows = [...$('list').querySelectorAll('.entry')];
  if (!rows.length) return;
  const current = ev.target.closest?.('.entry');
  const key = ev.key.toLowerCase();

  if (key === 'j' || key === 'k') {
    ev.preventDefault();
    const i = rows.indexOf(current);
    const next = rows[Math.min(Math.max(i + (key === 'j' ? 1 : -1), 0), rows.length - 1)];
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
    return;
  }
  const review = { a: 'slop', r: 'clean', q: null }[key];
  if (review === undefined || !current) return;
  ev.preventDefault();
  setReview(current, review);
}

$('tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[role="tab"]');
  if (b) selectTab(b.dataset.tab);
});
segmented($('kind'), 'kind', (kind) => {
  state.kind = kind;
  loadEntries(true);
});
segmented($('fb-status'), 'status', (status) => {
  state.fbStatus = status;
  loadFeedback(true);
});
$('sort').addEventListener('change', () => {
  state.sort = $('sort').value;
  loadEntries(true);
});
$('more').addEventListener('click', () => loadEntries(false));
$('fb-more').addEventListener('click', () => loadFeedback(false));
$('add').addEventListener('submit', addLink);
document.addEventListener('keydown', onKey);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshCounts();
});
window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1);
  if (tab !== state.tab) selectTab(tab);
});

refreshCounts();
selectTab(location.hash.slice(1));
