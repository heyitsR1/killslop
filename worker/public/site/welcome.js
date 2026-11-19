/**
 * killslop.app/welcome. Three small things, all decoration over a page that
 * reads fine without them: the live bot count, the looping demo thread, and
 * the AI SLOP button you can try. The site's CSP allows only this host's
 * scripts and requests to api.killslop.app.
 */

(() => {
  'use strict';

  document.documentElement.classList.add('js');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------------------------------------------------------- count */

  // The same rule the extension uses by default: everything except levelsio's
  // unreviewed silent blocks (flag 'b' on its own).
  const HIDES = /[clvk]/;

  function countUp(el, to) {
    const text = (n) => n.toLocaleString('en-US');
    if (still) {
      el.textContent = text(to);
      return;
    }
    const start = performance.now();
    const ms = 1400;
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 4);
      el.textContent = text(Math.round(to * eased));
      if (t < 1) requestAnimationFrame(step);
      else el.classList.add('is-done');
    };
    requestAnimationFrame(step);
  }

  async function loadCount() {
    const el = $('wl-count');
    if (!el) return;
    let n = null;
    try {
      const res = await fetch('https://api.killslop.app/api/v1/x-spam.json', { credentials: 'omit' });
      if (res.ok) {
        const data = await res.json();
        n = (data.accounts || []).filter((r) => Array.isArray(r) && HIDES.test(r[2] || '')).length || null;
      }
    } catch {
      /* offline: the fallback below */
    }
    countUp(el, n ?? Number(el.dataset.fallback.replace(/,/g, '')));
  }

  /* ----------------------------------------------------------------- demo */

  // Made-up replies. Bots sound like bots; people sound like people.
  const REPLIES = [
    { who: 'Jonas', at: '@jonasbuilds', av: 'h1', text: "Congrats! What did you build it with?" },
    { who: 'Insight Engine', at: '@insight_eng_88', av: 'bot', bot: true, text: 'This is a game-changer! Consistency truly is the key to unlocking success. Thanks for sharing!' },
    { who: 'Priya', at: '@priyacodes', av: 'h2', text: 'A year is a long time. Proud of you.' },
    { who: 'GrowthMind AI', at: '@growthmind_x', av: 'bot', bot: true, text: "Absolutely this. In today's fast-paced landscape, shipping is everything. What's your biggest takeaway?" },
    { who: 'Sam', at: '@samwrites', av: 'h3', text: 'link? want to try it tonight' },
    { who: 'Elevate Daily', at: '@elevate_dly', av: 'bot', bot: true, text: 'Love this perspective! Small steps lead to big results. Keep inspiring!' },
  ];

  function replyNode(r) {
    const li = document.createElement('li');
    li.className = 'wl-reply';
    li.innerHTML =
      '<div class="wl-reply__inner"><span class="wl-av"></span><div><p class="wl-name"></p><p class="wl-text"></p></div></div>';
    li.querySelector('.wl-av').classList.add(`wl-av--${r.av}`);
    const name = li.querySelector('.wl-name');
    name.textContent = r.who;
    const at = document.createElement('span');
    at.textContent = r.at;
    name.append(' ', at);
    li.querySelector('.wl-text').textContent = r.text;
    return li;
  }

  function cardNode() {
    const card = document.createElement('li');
    card.className = 'wl-card';
    card.innerHTML =
      '<span class="wl-card__dot"></span><span class="wl-card__text">On the AI reply spammer list</span>' +
      '<span class="wl-card__btn wl-card__btn--ghost">Why?</span><span class="wl-card__btn">Show</span>';
    return card;
  }

  async function runDemo() {
    const list = $('wl-thread');
    const tally = $('wl-tally');
    if (!list) return;
    const say = (n) => {
      tally.textContent = `${n} bot${n === 1 ? '' : 's'} caught`;
      tally.classList.remove('is-bump');
      void tally.offsetWidth;
      tally.classList.add('is-bump');
    };

    // Reduced motion: the finished picture, no loop.
    if (still) {
      for (const r of REPLIES) list.append(r.bot ? cardNode() : replyNode(r));
      say(REPLIES.filter((r) => r.bot).length);
      return;
    }

    for (;;) {
      list.replaceChildren();
      let caught = 0;
      tally.textContent = '0 bots caught';
      await sleep(600);
      for (const r of REPLIES) {
        const node = replyNode(r);
        list.append(node);
        await sleep(r.bot ? 900 : 650);
        if (!r.bot) continue;
        node.classList.add('is-caught');
        await sleep(700);
        node.classList.add('is-folded');
        await sleep(380);
        node.replaceWith(cardNode());
        say(++caught);
        await sleep(500);
      }
      await sleep(4200);
    }
  }

  /* ------------------------------------------------------------------ try */

  function burst(host, x, y) {
    const box = $('wl-burst');
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.replaceChildren();
    for (let i = 0; i < 14; i++) {
      const dot = document.createElement('i');
      const angle = (Math.PI * 2 * i) / 14 + Math.random() * 0.4;
      const dist = 26 + Math.random() * 30;
      dot.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
      dot.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
      box.append(dot);
    }
  }

  function wireTry() {
    const btn = $('wl-slop');
    const post = $('wl-post');
    const mine = $('wl-mine');
    const toast = $('wl-toast');
    const sandbox = $('wl-sandbox');
    if (!btn) return;
    let timer = 0;

    btn.addEventListener('click', async () => {
      btn.classList.add('is-pressed');
      const a = btn.getBoundingClientRect();
      const b = sandbox.getBoundingClientRect();
      if (!still) burst(sandbox, a.left - b.left + a.width / 2, a.top - b.top + a.height / 2);
      await sleep(still ? 0 : 260);
      post.classList.add('is-leaving');
      await sleep(still ? 0 : 320);
      post.hidden = true;
      mine.hidden = false;
      toast.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => (toast.hidden = true), 6000);
    });

    sandbox.addEventListener('click', (ev) => {
      if (ev.target?.dataset?.act !== 'undo') return;
      clearTimeout(timer);
      toast.hidden = true;
      mine.hidden = true;
      post.hidden = false;
      btn.classList.remove('is-pressed');
      requestAnimationFrame(() => post.classList.remove('is-leaving'));
    });
  }

  /* --------------------------------------------------------------- reveal */

  function wireReveal() {
    const els = document.querySelectorAll('.wl-reveal');
    if (still || !('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -10% 0px' }
    );
    els.forEach((el) => io.observe(el));
  }

  /* ------------------------------------------------------------------ pin */

  function wirePin() {
    document.querySelector('[data-act="pin-close"]')?.addEventListener('click', (ev) => {
      const tip = ev.currentTarget.closest('.wl-pin');
      tip.classList.add('is-gone');
      setTimeout(() => tip.remove(), 220);
    });
  }

  /* ------------------------------------------------------------ dashboard */

  // The extension opens this page with ?ext=<its id>. With it, the second
  // button opens that install's dashboard (a web-accessible page, reachable
  // from killslop.app only). Without it, the button stays a jump to the demo.
  function wireDashboard() {
    const btn = $('wl-dash');
    if (!btn) return;
    const fromUrl = new URLSearchParams(location.search).get('ext');
    let id = /^[a-p]{32}$/.test(fromUrl || '') ? fromUrl : null;
    try {
      if (id) localStorage.setItem('killslop-ext', id);
      else id = localStorage.getItem('killslop-ext');
    } catch {
      /* storage blocked: fine, just this visit */
    }
    if (!/^[a-p]{32}$/.test(id || '')) return;
    btn.href = `chrome-extension://${id}/src/dashboard/dashboard.html`;
    btn.textContent = 'Open your dashboard';
  }

  function start() {
    wireDashboard();
    wireReveal();
    wireTry();
    wirePin();
    loadCount();
    runDemo();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
