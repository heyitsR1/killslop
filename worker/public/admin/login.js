/* Shows why the last sign-in failed. The server says so in ?error=. */

'use strict';

const MESSAGES = {
  wrong: 'That password is not right.',
  rate: 'Too many attempts from your network. Wait a minute and try again.',
  origin: 'Sign in from this page rather than from a link or another site.',
};

const reason = new URLSearchParams(location.search).get('error');
if (reason && Object.hasOwn(MESSAGES, reason)) {
  const box = document.getElementById('error');
  box.textContent = MESSAGES[reason];
  box.hidden = false;
  history.replaceState(null, '', '/admin');
}
