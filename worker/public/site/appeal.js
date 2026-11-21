/* killslop.app/appeal: look an X account up on the lists KillSlop uses, show
   what each says, and send an appeal. Both calls go to api.killslop.app
   (worker/src/appeal.js); the page itself talks to nobody else. */

'use strict';

(() => {
  const API = 'https://api.killslop.app/api/v1/appeal';
  const HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
  const isValidEmail = (s) => s.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(s);
  const $ = (id) => document.getElementById(id);
  let current = null;

  const say = (el, text, error = false) => {
    el.textContent = text;
    el.classList.toggle('signup__msg--error', error);
  };

  const LEVELS = {
    confirmed: 'confirmed. He blocked it for an AI reply and kept the reply as evidence.',
    likely: 'likely. He blocked it, and the account was created in 2023 or later. No reply is on record.',
    blocked: 'blocked, not reviewed. He blocked it at some point, with no reply or reason on record.',
  };

  function li(html) {
    const el = document.createElement('li');
    el.append(...html);
    return el;
  }

  function b(text) {
    const el = document.createElement('b');
    el.textContent = text;
    return el;
  }

  function render(d) {
    current = d;
    $('who').textContent = `@${d.handle}`;
    const verdict = $('verdict');
    verdict.className = 'appeal__verdict';
    const sources = $('sources');
    sources.replaceChildren();

    if (!d.listed) {
      verdict.textContent = 'This account is not on any list KillSlop uses. Nothing is hidden. You do not need to do anything.';
      verdict.classList.add('appeal__verdict--ok');
      $('steps').hidden = true;
      $('result').hidden = false;
      return;
    }
    if (d.cleared) {
      verdict.textContent =
        'An appeal for this account was upheld. KillSlop does not hide it, whatever the other lists say.';
      verdict.classList.add('appeal__verdict--ok');
    } else if (d.hiddenByDefault) {
      verdict.textContent = 'KillSlop hides this account’s replies for everyone who uses it.';
      verdict.classList.add('appeal__verdict--hidden');
    } else {
      verdict.textContent =
        'KillSlop does not hide this account by default. Only people who switched on “Include unreviewed blocks” see it hidden.';
      verdict.classList.add('appeal__verdict--opt');
    }

    if (d.levelsio) {
      const item = li([b('levelsio: '), LEVELS[d.levelsio.status] || d.levelsio.status]);
      for (const e of d.levelsio.evidence) {
        if (!e.text) continue;
        const q = document.createElement('blockquote');
        q.textContent = `${e.date ? e.date + ': ' : ''}${e.text}`;
        item.append(q);
      }
      sources.append(item);
    }
    if (d.clankwall) sources.append(li([b('Clankwall: '), 'flagged by @ryanvogel’s Clankwall.']));
    if (d.killslop) sources.append(li([b('KillSlop: '), 'on our own list, after a maintainer reviewed it.']));

    $('steps').hidden = false;
    $('step-ours').hidden = d.cleared;
    $('step-levels').hidden = !d.levelsio;
    $('step-levels').querySelector('.guide-step__n').textContent = d.cleared ? 'Next' : 'Step 2';
    if (d.levelsio) $('levels-link').href = d.levelsio.appeal;
    $('appeal').hidden = false;
    $('send').disabled = false;
    say($('appeal-msg'), '');
    $('result').hidden = false;
  }

  async function lookup(ev) {
    ev.preventDefault();
    const m = HANDLE.exec($('handle').value.trim());
    const msg = $('lookup-msg');
    if (!m) return say(msg, 'Enter an X username, like @username.', true);
    $('check').disabled = true;
    say(msg, 'Checking…');
    try {
      const res = await fetch(`${API}?handle=${encodeURIComponent(m[1])}`, { credentials: 'omit' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'failed');
      say(msg, '');
      history.replaceState(null, '', `?u=${encodeURIComponent(m[1])}`);
      render(d);
    } catch {
      say(msg, 'Could not check right now. Try again in a minute.', true);
    } finally {
      $('check').disabled = false;
    }
  }

  async function appeal(ev) {
    ev.preventDefault();
    if (!current) return;
    const msg = $('appeal-msg');
    const email = $('email').value.trim();
    if (email && !isValidEmail(email)) return say(msg, 'That email address does not look right.', true);
    $('send').disabled = true;
    say(msg, 'Sending…');
    try {
      const res = await fetch(API, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: current.handle, note: $('note').value.trim(), email }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not send it. Try again in a minute.');
      say(msg, d.cleared
        ? 'This account is already cleared. Nothing more to do here.'
        : 'Sent. A person will read it. If it is upheld, KillSlop stops hiding your account for everyone.');
    } catch (err) {
      $('send').disabled = false;
      say(msg, err.message, true);
    }
  }

  function start() {
    $('lookup').addEventListener('submit', lookup);
    $('appeal').addEventListener('submit', appeal);
    const u = new URLSearchParams(location.search).get('u');
    if (u && HANDLE.test(u)) {
      $('handle').value = `@${u.replace(/^@/, '')}`;
      $('lookup').requestSubmit();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
