/* killslop.app/uninstall: why someone left, posted to the feedback endpoint.

   No identifier of any kind. The uninstall URL the extension registers carries
   the version and nothing else, so there is no install id here to attach and
   nothing that could join this page to anyone's votes. The server keeps the
   network only as a salted hash, to cap how much one network can send.

   It rides on /api/v1/feedback under a category of its own rather than getting
   an endpoint of its own: it is the same shape of thing, it lands in the same
   inbox, and it needs no new rate-limit binding to deploy. */

'use strict';

const API = 'https://api.killslop.app';

/** Which build they had. The extension puts it there; anything else is dropped. */
const raw = new URLSearchParams(location.search).get('v') || '';
const VERSION = /^[\w.+-]{1,32}$/.test(raw) ? raw : null;

const reasons = document.getElementById('reasons');
const more = document.getElementById('more');
const thanks = document.getElementById('thanks');
const detail = document.getElementById('detail');
const email = document.getElementById('email');
const send = document.getElementById('send');
const msg = document.getElementById('msg');

let chosen = null;

function say(text, error = false) {
  msg.textContent = text;
  msg.className = error ? 'signup__msg signup__msg--error' : 'signup__msg';
}

/** Fire and forget. `keepalive` so it survives the tab closing behind it. */
function post(body) {
  return fetch(`${API}/api/v1/feedback`, {
    method: 'POST',
    credentials: 'omit',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, category: 'uninstall', version: VERSION }),
  });
}

/**
 * Record the reason the instant it is pressed, before anything optional.
 *
 * Most people choose a reason and close the tab, so waiting for a Send button
 * would throw away the majority of the answers and quietly bias what is left
 * towards whoever had more to say.
 *
 * Writing detail therefore sends a second message carrying the same reason.
 * That is deliberate: with no identifier there is nothing to update a row by,
 * and at this volume a maintainer reading a pair in the inbox costs less than
 * losing every abandoned answer would.
 */
for (const button of reasons.querySelectorAll('.reason')) {
  button.addEventListener('click', () => {
    if (chosen) return;
    chosen = { key: button.dataset.reason, label: button.textContent.trim() };

    for (const other of reasons.querySelectorAll('.reason')) {
      other.disabled = true;
      other.classList.toggle('reason--chosen', other === button);
    }

    post({ message: `Uninstalled: ${chosen.label}` }).catch(() => {});

    thanks.textContent = 'Thanks, that is recorded.';
    more.hidden = false;
    detail.focus();
  });
}

more.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = detail.value.trim();
  const address = email.value.trim();
  if (!text && !address) {
    say('Add a note or an email address, or you are already done.');
    return;
  }

  send.disabled = true;
  say('Sending...');

  try {
    const res = await post({
      message: `Uninstalled: ${chosen.label}\n\n${text || '(no note)'}`,
      email: address || undefined,
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.ok === true) {
      more.hidden = true;
      thanks.textContent = address
        ? `Sent. If there is something to follow up on, the reply goes to ${address}.`
        : 'Sent. Thank you, it will be read.';
      thanks.hidden = false;
      return;
    }
    say(
      body?.error === 'bad email'
        ? 'That does not look like an email address.'
        : res.status === 429
          ? 'Too many messages from your network just now. Try again in a minute.'
          : 'Something went wrong at our end. Your note is still here, so you can try again.',
      true
    );
  } catch {
    say('Could not reach the server. Your note is still here, so you can try again.', true);
  }
  send.disabled = false;
});
