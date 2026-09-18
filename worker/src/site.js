/**
 * The public website at killslop.app, and the static files every surface
 * shares: /ui/base.css and the Geist fonts under /fonts/.
 *
 * One worker answers both hosts. killslop.app gets the site; api.killslop.app
 * gets the API and the console at /admin. Keeping the console off the site's
 * host means nothing on a public page is ever same-origin with /admin.
 */

export const SITE_HOST = 'killslop.app';
const WWW_HOST = `www.${SITE_HOST}`;
/** Chrome resolves *.localhost to loopback, so `wrangler dev` can show the site. */
const SITE_HOSTS = new Set([SITE_HOST, WWW_HOST, 'site.localhost']);

const PAGES = {
  '/': '/site/index.html',
  '/privacy': '/site/privacy.html',
  // Opened once, on install, by the service worker.
  '/welcome': '/site/welcome.html',
};
/**
 * Where "Get KillSlop" goes. Every button on the site links to /get, so the
 * day the Chrome Web Store listing is live this is the one line to change.
 */
export const INSTALL_URL = 'https://github.com/heyitsR1/killslop#install';
const SITE_FILE = /^\/site\/[a-z0-9-]+\.(?:html|css|js|svg|png|txt)$/;
const SHARED_FILE = /^\/(?:ui\/base\.css|fonts\/(?:Geist-Variable|GeistMono-Variable)\.woff2|fonts\/OFL\.txt)$/;

const SITE_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
    "connect-src https://api.killslop.app; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
};

const isRead = (request) => request.method === 'GET' || request.method === 'HEAD';

export const isSiteHost = (url) => SITE_HOSTS.has(url.hostname);

/** The asset at `path` with our headers, or null if there is no such file. */
async function asset(env, request, path, { status = 200, headers = {} } = {}) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: request.method }));
  if (!res.ok) return null;
  const out = new Response(res.body, { status, headers: res.headers });
  for (const [key, value] of Object.entries(headers)) out.headers.set(key, value);
  return out;
}

/**
 * /ui/base.css and the fonts, on every host: the console's pages need them as
 * much as the site does. Fonts never change under a name, so they cache for a
 * year; the stylesheet changes with a deploy, so it gets an hour.
 */
export async function handleShared(request, env, url) {
  if (!isRead(request) || !SHARED_FILE.test(url.pathname)) return null;
  const cache = url.pathname.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  return asset(env, request, url.pathname, {
    headers: { 'cache-control': cache, 'x-content-type-options': 'nosniff' },
  });
}

export async function handleSite(request, env, url) {
  if (url.hostname === WWW_HOST) {
    return Response.redirect(`https://${SITE_HOST}${url.pathname}${url.search}`, 301);
  }
  if (!isRead(request)) {
    return new Response('Method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const shared = await handleShared(request, env, url);
  if (shared) return shared;

  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
  if (path === '/get') return Response.redirect(INSTALL_URL, 302);
  // no-transform stops Cloudflare injecting its Web Analytics beacon into the
  // pages, which a zone can have switched on without anyone asking. The site
  // promises no analytics, so that promise must not rest on a dashboard toggle.
  const file = Object.hasOwn(PAGES, path) ? PAGES[path] : SITE_FILE.test(path) ? path : null;
  const page =
    file &&
    (await asset(env, request, file, { headers: { ...SITE_HEADERS, 'cache-control': 'public, max-age=300, no-transform' } }));
  if (page) return page;

  const missing = await asset(env, request, '/site/404.html', {
    status: 404,
    headers: { ...SITE_HEADERS, 'cache-control': 'no-store, no-transform' },
  });
  return missing || new Response('Not found\n', { status: 404, headers: SITE_HEADERS });
}
