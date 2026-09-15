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
