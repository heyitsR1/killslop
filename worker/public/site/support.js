/* killslop.app/support: the Send feedback form, on the website.

   The same message, the same endpoint and the same inbox as the form inside
   the extension, so someone who has already uninstalled, or who never got as
   far as opening the popup, still has a way to reach a person.

   No identifier of any kind. There is no install id on the web, and nothing
   here asks for one, so a message cannot be joined to anyone's votes. The
   server keeps the network only as a salted hash, to cap how much one network
   can send. The one field that can identify anyone is the email box, which is
   optional and exists only so a reply can be sent. */

'use strict';

const API = 'https://api.killslop.app';
const MAX = 3500;

/** Same rule as the server (isValidEmail in worker/src/policy.js). */
const isValidEmail = (s) =>
  s.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(s);

/** What to write about, per category. The wrong-call hint asks for the link,
    because without one a wrong call cannot be checked. */
const HINTS = {
  bug: 'What happened, and what did you expect instead?',
  wrong: 'Paste the link. Say whether it hid something it should not have, or missed slop.',
  idea: 'What would make KillSlop better for you?',
  other: '',
};

const $ = (id) => document.getElementById(id);

const form = $('form');
const cats = $('category');
const message = $('message');
const email = $('email');
const send = $('send');
const msg = $('msg');

let category = 'bug';

function say(text, error = false) {
  msg.textContent = text;
  msg.className = error ? 'signup__msg signup__msg--error' : 'signup__msg';
}

/** What each refusal means, in words someone can act on. */
function failure(status, error) {
  if (error === 'bad email') return 'That does not look like an email address.';
  if (error === 'message too long') return 'That message is too long to send.';
  if (status === 429) return 'Too many messages from your network just now. Try again in a minute.';
  return 'Something went wrong at our end. Your message is still here, so you can try again.';
}

function paint() {
  for (const button of cats.querySelectorAll('button')) {
    button.setAttribute('aria-checked', String(button.dataset.value === category));
  }
  $('hint').textContent = HINTS[category];
  $('count').textContent = message.value.length.toLocaleString('en');
}

cats.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  category = button.dataset.value;
  paint();
});

message.addEventListener('input', () => {
  if (msg.textContent) say('');
  paint();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = message.value.trim();
  const address = email.value.trim();

  if (!text) {
    say('Write a message first, and we will read it.', true);
    message.focus();
    return;
  }
  if (text.length > MAX) {
    say(failure(0, 'message too long'), true);
    return;
  }
  // Checked here as well as on the server so a typo costs a glance rather
  // than a round trip, and the message is never sent with an address that
  // cannot be replied to.
  if (address && !isValidEmail(address)) {
    say('That does not look like an email address.', true);
    email.focus();
    return;
  }

  send.disabled = true;
  say('Sending...');

  let sent = false;
  try {
    const res = await fetch(`${API}/api/v1/feedback`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category, message: text, email: address || undefined }),
    });
    const body = await res.json().catch(() => null);
    sent = res.ok && body?.ok === true;
    if (!sent) say(failure(res.status, body?.error), true);
  } catch {
    say('Could not reach the server. Your message is still here, so you can try again.', true);
  }

  if (!sent) {
    send.disabled = false;
    return;
  }
  // Done: clearing the box is what stops a second press sending a duplicate,
  // and the message says plainly whether a reply is even possible.
  form.hidden = true;
  say(
    address
      ? `Sent. If there is something to follow up on, the reply goes to ${address}.`
      : 'Sent. You left no email, so there will be no reply, but it will be read.'
  );
});

paint();
