/* killslop.app/waitlist: one email field, posted to the API.

   No tracking of any kind. The only request this page ever makes is the one
   you cause by pressing the button, and it carries the address you typed and
   nothing else. A launch link may name itself with ?from=<slug> so the console
   can tell which post an address came from; it is a short slug we chose, never
   anything about you, and it is dropped unless it matches that shape. */

'use strict';

const API = 'https://api.killslop.app';

/** The ?from=<slug> on a launch link, if it is one of ours. */
const source = new URLSearchParams(location.search).get('from') || '';
const SOURCE = /^[a-z0-9-]{1,24}$/.test(source.toLowerCase()) ? source.toLowerCase() : null;

const form = document.getElementById('signup');
const email = document.getElementById('email');
const submit = document.getElementById('signup-submit');
const msg = document.getElementById('msg');

function say(text, error = false) {
  msg.textContent = text;
  msg.className = error ? 'signup__msg signup__msg--error' : 'signup__msg';
}

/** What each refusal means, in words someone can act on. */
function failure(status, error) {
  if (error === 'bad email') return 'That does not look like an email address.';
  if (status === 429) return 'Too many sign-ups from your network just now. Try again in a minute.';
  return 'Something went wrong at our end. Try again in a moment.';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const address = email.value.trim();
  if (!address || submit.disabled) return;

  submit.disabled = true;
  say('Adding you to the list...');

  let added = false;
  try {
    const res = await fetch(`${API}/api/v1/waitlist`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SOURCE ? { email: address, source: SOURCE } : { email: address }),
    });
    const body = await res.json().catch(() => null);
    added = res.ok && body?.ok === true;
    if (!added) say(failure(res.status, body?.error), true);
  } catch {
    say('Could not reach the server. Check your connection and try again.', true);
  }

  if (!added) {
    submit.disabled = false;
    return;
  }
  // Done: the field and the button have nothing left to do, and the message
  // repeats the address so a typo is visible while it can still be fixed.
  email.disabled = true;
  submit.hidden = true;
  say(`You are on the list. We will email ${address} once, on the day the listing goes live.`);
});
