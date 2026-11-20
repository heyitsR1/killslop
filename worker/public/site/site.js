/* killslop.app: the copy buttons and the live numbers from the list.
   No tracking of any kind; the only request is the public stats endpoint. */

'use strict';

const API = 'https://api.killslop.app';

/* ------------------------------------------------------------------ copy */

for (const btn of document.querySelectorAll('[data-copy]')) {
  const label = btn.textContent;
  let timer = 0;
  btn.addEventListener('click', async () => {
    const target = document.getElementById(btn.dataset.copy);
    if (!target) return;
    let copied = false;
    try {
      // data-copy-text holds the full value when the page shows a shortened one.
      await navigator.clipboard.writeText(btn.dataset.copyText || target.textContent.trim());
      copied = true;
    } catch {
      // No clipboard access: select the text so the keyboard shortcut works.
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    btn.textContent = copied ? 'Copied' : 'Selected';
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.textContent = label;
    }, 1600);
  });
}

/* ----------------------------------------------------------------- stats */

// Numbers are shown only when the API answers and they are above zero. An
// empty block is hidden rather than advertised.
const stats = document.getElementById('stats');
if (stats) {
  const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(5000) : undefined;
  fetch(`${API}/api/v1/stats`, { credentials: 'omit', signal })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      if (!body) return;
      let shown = 0;
      for (const value of stats.querySelectorAll('[data-stat]')) {
        const n = Number(body[value.dataset.stat]);
        const cell = value.closest('.stat');
        if (Number.isFinite(n) && n > 0) {
          value.textContent = n.toLocaleString('en');
          shown += 1;
        } else if (cell) {
          cell.hidden = true;
        }
      }
      stats.hidden = shown === 0;
    })
    .catch(() => {});
}

/* ----------------------------------------------------------------- crawl */

// The hero decoration. Made-up handles roll up toward the red line; bots are
// struck as they cross it and about one account in five is kept. The handles
// are invented on purpose: naming real accounts as bots on the home page would
// be an accusation. Stands still for reduced motion and pauses off screen.
const crawl = document.getElementById('crawl');
if (crawl) {
  const BOTS = ['growthguru_ai', 'reply_boost_9', 'thought_leadr', 'crypto_insight_x', 'ai_wisdom_daily',
    'great_point_bot', 'vibe_founder_42', 'insightful_take', 'engage_more_ai', 'alpha_drops_now',
    'saas_whisperer', 'deep_thoughts_ai', 'so_true_bestie', 'valuable_add_ai', 'big_if_true_ai', 'web3_mentor_x'];
  const PEOPLE = ['maria_builds', 'sam_on_rails', 'jdoe', 'tinyshop_kim', 'nate_codes', 'priya_designs',
    'lena_draws', 'tomsfieldnotes'];
  const PATTERN = [1, 1, 1, 0, 1, 1, 1, 1, 0]; // 0 = kept
  const HEIGHT = 300;
  const ROW = 28;
  const LINE = 170;
  const SPEED = 0.035; // px per ms
  const rows = [];
  let k = 0;
  let bot = 0;
  let person = 0;

  const add = (y) => {
    const isBot = PATTERN[k++ % PATTERN.length] === 1;
    const el = document.createElement('div');
    el.className = 'crawl__row';
    const name = document.createElement('span');
    name.className = 'crawl__name';
    name.textContent = `@${isBot ? BOTS[bot++ % BOTS.length] : PEOPLE[person++ % PEOPLE.length]}`;
    const tag = document.createElement('span');
    tag.className = 'crawl__tag';
    tag.textContent = isBot ? 'HIDDEN' : 'KEPT';
    el.append(name, tag);
    crawl.append(el);
    rows.push({ el, y, isBot, done: false });
  };

  const place = (row) => {
    row.el.style.transform = `translateY(${row.y}px)`;
    if (!row.done && row.y + ROW / 2 < LINE) {
      row.done = true;
      row.el.classList.add(row.isBot ? 'is-hidden' : 'is-kept');
    }
  };

  for (let y = -ROW; y < HEIGHT; y += ROW) add(y);
  rows.forEach(place);

  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0;
  let last = 0;
  const step = (t) => {
    const dt = last ? Math.min(t - last, 50) : 16;
    last = t;
    while (rows[rows.length - 1].y < HEIGHT) add(rows[rows.length - 1].y + ROW);
    for (const row of rows) {
      row.y -= dt * SPEED;
      place(row);
    }
    while (rows[0].y < -ROW * 2) rows.shift().el.remove();
    raf = requestAnimationFrame(step);
  };
  const start = () => {
    if (raf || still.matches) return;
    last = 0;
    raf = requestAnimationFrame(step);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop())).observe(crawl);
  } else {
    start();
  }
  still.addEventListener('change', () => (still.matches ? stop() : start()));
}
