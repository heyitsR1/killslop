/** "Send feedback": a message and an optional email, straight to the maintainer. */

const $ = (id) => document.getElementById(id);

const send = (type, payload = {}) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res?.result ?? null);
    });
  });

/** Same rule as the server (isValidEmail in worker/src/policy.js). */
const isValidEmail = (s) =>
  s.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(s);

const HINTS = {
  bug: 'What happened, and what did you expect instead?',
  wrong: 'Say whether KillSlop hid something it should not have, or missed some slop.',
  idea: 'What would make KillSlop better for you?',
  other: '',
};

const ERRORS = {
  'rate limited': 'Too many messages from your network. Please try again later.',
  'bad email': 'That email address does not look right.',
  'message too long': 'That message is too long.',
  offline: 'Could not reach the server. Your message is still here, so you can try again.',
};

/** The YouTube, X or LinkedIn page the popup was opened on, if any. Nothing else is accepted. */
function pageFrom(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /^((www\.|m\.)?youtube\.com|x\.com|www\.linkedin\.com)$/.test(u.hostname)
      ? u.href
      : null;
  } catch {
    return null;
  }
}

const page = pageFrom(new URLSearchParams(location.search).get('from'));
let category = page ? 'wrong' : 'bug';

function paint() {
  for (const b of $('category').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.value === category));
  }
  $('category-hint').textContent = HINTS[category];
  $('count').textContent = $('message').value.length.toLocaleString('en');
  $('submit').disabled = !$('message').value.trim();
}

function showError(text) {
  $('error').textContent = text;
  $('error').hidden = !text;
}

$('category').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  category = b.dataset.value;
  paint();
});
$('message').addEventListener('input', () => {
  showError('');
  paint();
});
$('email').addEventListener('input', () => showError(''));

$('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = $('email').value.trim();
  let message = $('message').value.trim();
  if (!message) return;
  if (email && !isValidEmail(email)) {
    showError(ERRORS['bad email']);
    return;
  }
  if (page && $('attach').checked) message += `\n\nPage: ${page}`;

  $('submit').disabled = true;
  $('submit').textContent = 'Sending...';
  const res = await send('sendFeedback', { category, message, email });
  $('submit').textContent = 'Send feedback';

  if (res?.ok) {
    $('form').hidden = true;
    $('done').hidden = false;
    $('done-text').textContent = email
      ? `If there is something to follow up on, the reply goes to ${email}.`
      : 'You left no email, so there will be no reply, but it will be read.';
    return;
  }
  paint();
  showError(
    ERRORS[res?.error] ||
      (res ? `The server did not accept it (${res.error || res.status}).` : ERRORS.offline)
  );
});

$('again').addEventListener('click', () => {
  $('message').value = '';
  $('done').hidden = true;
  $('form').hidden = false;
  paint();
  $('message').focus();
});

if (page) {
  $('page').hidden = false;
  $('page-url').textContent = page;
}
paint();
$('message').focus();
