/** "Your marks": everything the user called slop or not slop, with a way back. */

const send = (type, payload = {}) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res?.result ?? null);
    });
  });

const $ = (id) => document.getElementById(id);

let marks = [];
let tab = 'slop';
/** videoId -> {title, channel}, for marks saved before titles were recorded. */
const looked = new Map();

const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const channelUrl = (id) =>
  id.startsWith('@') ? `https://www.youtube.com/${id}` : `https://www.youtube.com/channel/${id}`;

/** Ids follow core/ids.js: X and LinkedIn ids carry a prefix, YouTube's none. */
const platformOf = (id) => (id.startsWith('x:') ? 'x' : id.startsWith('li:') ? 'linkedin' : 'youtube');
const PLATFORM_LABEL = { youtube: 'YouTube', x: 'X', linkedin: 'LinkedIn' };
const CHANNEL_NOUN = { youtube: 'channel', x: 'account', linkedin: 'author' };

/** Where a mark points, or null for a LinkedIn post: its id is a one-way hash. */
function urlOf({ id, kind }) {
  if (id.startsWith('x:u:')) return `https://x.com/i/user/${id.slice(4)}`;
  if (id.startsWith('x:@')) return `https://x.com/${id.slice(3)}`;
  if (id.startsWith('x:')) return `https://x.com/i/status/${id.slice(2)}`;
  const author = /^li:(in|company|showcase):(.+)$/.exec(id);
  if (author) return `https://www.linkedin.com/${author[1]}/${author[2]}/`;
  if (id.startsWith('li:')) return null;
  return kind === 'channel' ? channelUrl(id) : watchUrl(id);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(ts) {
  const mins = Math.round((ts - Date.now()) / 60_000);
  if (mins > -1) return 'just now';
  if (mins > -60) return rtf.format(mins, 'minute');
  const hours = Math.round(mins / 60);
  if (hours > -24) return rtf.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days > -30) return rtf.format(days, 'day');
  return new Date(ts).toLocaleDateString();
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** A link that opens in a new tab, or a plain span when there is nowhere to go. */
function link(className, href) {
  if (!href) return el('span', className);
  const a = el('a', className);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

/** Older marks carry no title. oEmbed is public and needs no key. */
async function lookUp(videoId) {
  if (looked.has(videoId)) return looked.get(videoId);
  const pending = fetch(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl(videoId))}`,
    { credentials: 'omit' }
  )
    .then((res) => (res.ok ? res.json() : null))
    .then((o) => (o ? { title: o.title, channel: o.author_name } : null))
    .catch(() => null);
  looked.set(videoId, pending);
  return pending;
}

function row(m) {
  const isChannel = m.kind === 'channel';
  const platform = platformOf(m.id);
  const isVideo = platform === 'youtube' && !isChannel;
  const url = urlOf(m);
  const item = el('div', 'item');

  const thumb = link(isVideo ? 'item__thumb' : 'item__thumb item__thumb--channel', url);
  thumb.tabIndex = -1;
  thumb.setAttribute('aria-hidden', 'true');
  if (isVideo) {
    const img = el('img');
    img.src = `https://i.ytimg.com/vi/${m.id}/mqdefault.jpg`;
    img.alt = '';
    img.loading = 'lazy';
    thumb.append(img);
  } else {
    // No thumbnail to show without asking the site: an initial stands in.
    const avatar = el('span', 'item__avatar');
    const name = isChannel ? m.meta?.title : m.meta?.channel || m.meta?.title;
    avatar.textContent = (name || m.id.replace(/^(x|li):(u:|in:|company:|showcase:)?/, ''))
      .replace(/^@/, '')
      .charAt(0)
      .toUpperCase();
    thumb.append(avatar);
  }

  const body = el('div', 'item__body');
  const title = link('item__title', url);
  const meta = el('div', 'item__meta');
  const paint = (info) => {
    title.textContent = info?.title || (platform === 'linkedin' && !isChannel ? 'LinkedIn post' : m.id);
    meta.textContent = [
      platform !== 'youtube' && PLATFORM_LABEL[platform],
      isChannel ? `Whole ${CHANNEL_NOUN[platform]}` : info?.channel,
      `marked ${ago(m.ts)}`,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  paint(m.meta);
  if (isVideo && !m.meta?.title) lookUp(m.id).then((info) => info && paint(info));
  body.append(title, meta);

  const remove = el('button', 'btn btn--sm');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.title = m.slop ? 'Stop treating this as AI slop' : 'Let KillSlop judge this again';
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    await send('undoOverride', { id: m.id });
    marks = marks.filter((x) => x.id !== m.id);
    render();
  });

  item.append(thumb, body, remove);
  return item;
}

function render() {
  const slop = marks.filter((m) => m.slop);
  const clean = marks.filter((m) => !m.slop);
  $('count-slop').textContent = slop.length;
  $('count-clean').textContent = clean.length;
  for (const b of $('tabs').querySelectorAll('button')) {
    b.setAttribute('aria-selected', String(b.dataset.value === tab));
  }

  const shown = tab === 'slop' ? slop : clean;
  const list = $('list');
  list.replaceChildren();
  for (const [kind, label] of [
    ['channel', 'Channels and accounts'],
    ['video', 'Videos and posts'],
  ]) {
    const items = shown.filter((m) => m.kind === kind);
    if (!items.length) continue;
    const group = el('section', 'group');
    const heading = el('h2', 'eyebrow');
    heading.textContent = `${label} · ${items.length}`;
    const box = el('div', 'box');
    box.append(...items.map(row));
    group.append(heading, box);
    list.append(group);
  }

  $('empty').hidden = shown.length > 0;
  $('empty').textContent =
    tab === 'slop'
      ? 'Nothing marked yet. Press AI SLOP under a YouTube video, an X post or a LinkedIn post.'
      : 'Nothing here yet. Things you tell KillSlop are not slop show up here.';
}

async function load() {
  marks = (await send('listOverrides')) || [];
  render();
}

$('tabs').addEventListener('click', (ev) => {
  const value = ev.target.closest('button')?.dataset.value;
  if (!value) return;
  tab = value;
  render();
});

// Marks made in another tab show up when you come back here.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});

(async () => {
  const settings = await send('getSettings');
  if (settings && !settings.shareReports) {
    $('sub').textContent = 'Hidden for you right away. Sharing is off, so your marks stay on this device.';
  }
  load();
})();
