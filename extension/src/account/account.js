/**
 * Check an account: what each list KillSlop uses says about one X account,
 * the evidence on record, and an appeal. Same API as killslop.app/appeal
 * (worker/src/appeal.js). Only the username typed here is sent, and only
 * when Check is pressed; the block list itself is still matched locally.
 *
 * Opened from the dashboard, the popup, or a hidden reply's "Why?" button,
 * which passes ?u=<handle> so the check runs at once.
 */

const API = 'https://api.killslop.app/api/v1/appeal';
const HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
const isValidEmail = (s) => s.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(s);
const $ = (id) => document.getElementById(id);
let current = null;

const say = (el, text, error = false) => {
  el.textContent = text;
  el.classList.toggle('msg--error', error);
};

const LEVELS = {
  confirmed: 'confirmed, with an AI reply on record.',
  likely: 'likely. New account, no reply on record.',
  blocked: 'blocked, not reviewed.',
};

function li(...parts) {
  const el = document.createElement('li');
  el.append(...parts);
  return el;
}

function b(text) {
  const el = document.createElement('b');
  el.textContent = text;
  return el;
}

export function verdictFor(d) {
  if (!d.listed) return { cls: 'ok', text: 'Not on any list KillSlop uses. Nothing from this account is hidden.' };
  if (d.cleared) return { cls: 'ok', text: 'An appeal for this account was upheld. KillSlop does not hide it, whatever the other lists say.' };
  if (d.hiddenByDefault) return { cls: 'hidden', text: 'KillSlop hides this account’s replies for everyone who uses it.' };
  return { cls: 'opt', text: 'Not hidden by default. Only people who switched on “Include unreviewed blocks” see it hidden.' };
}

function render(d) {
  current = d;
  $('who').textContent = `@${d.handle}`;
  const v = verdictFor(d);
  const verdict = $('verdict');
  verdict.className = `verdict verdict--${v.cls}`;
  verdict.textContent = v.text;

  const sources = $('sources');
  sources.replaceChildren();
  if (d.levelsio) {
    const item = li(b('levelsio: '), LEVELS[d.levelsio.status] || d.levelsio.status);
    const replies = d.levelsio.evidence.filter((e) => e.text);
    for (const e of replies) {
      const q = document.createElement('blockquote');
      q.textContent = `${e.date ? e.date + ': ' : ''}${e.text}`;
      item.append(q);
    }
    if (!replies.length) {
      const none = document.createElement('p');
      none.className = 'none';
      none.textContent = 'No replies on record.';
      item.append(none);
    }
    sources.append(item);
  }
  if (d.clankwall) sources.append(li(b('Clankwall: '), 'flagged.'));
  if (d.killslop) sources.append(li(b('KillSlop: '), 'on our reviewed list.'));

  $('evidence-block').hidden = !d.listed;
  $('appeal-card').hidden = !d.listed || d.cleared;
  $('levels-card').hidden = !d.levelsio;
  if (d.levelsio) $('levels-link').href = d.levelsio.appeal;
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
      ? 'This account is already cleared. Nothing more to do.'
      : 'Sent. A person will read it. If it is upheld, KillSlop stops hiding the account for everyone.');
  } catch (err) {
    $('send').disabled = false;
    say(msg, err.message, true);
  }
}

if (typeof document !== 'undefined' && $('lookup')) {
  $('lookup').addEventListener('submit', lookup);
  $('appeal').addEventListener('submit', appeal);
  const u = new URLSearchParams(location.search).get('u');
  if (u && HANDLE.test(u)) {
    $('handle').value = `@${u.replace(/^@/, '')}`;
    $('lookup').requestSubmit();
  } else {
    $('handle').focus();
  }
}
