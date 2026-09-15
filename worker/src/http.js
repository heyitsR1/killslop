/** Request plumbing shared by the public API and the console. */

import { networkOf } from './policy.js';

export const MAX_BODY_BYTES = 16 * 1024;

/** The caller's network: an IPv4 address, or an IPv6 /64. */
export const clientNetwork = (request) =>
  networkOf(request.headers.get('cf-connecting-ip') || '0.0.0.0');

/**
 * True when this network has spent its budget on `binding`, one of the rate
 * limiters declared in wrangler.toml. Keyed by network rather than address,
 * so an IPv6 client cannot dodge a limit by rotating through its /64. A
 * missing binding (unit tests) or a limiter error lets the request through:
 * the limits are a brake on abuse, not a reason to go down.
 */
export async function overLimit(env, binding, request) {
  const limiter = env[binding];
  if (!limiter) return false;
  try {
    const { success } = await limiter.limit({ key: clientNetwork(request) });
    return !success;
  } catch {
    return false;
  }
}

/** The body as JSON, or null if it is malformed or over MAX_BODY_BYTES. */
export async function readJson(request) {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) return null;
  try {
    const text = await request.text();
    return text.length > MAX_BODY_BYTES ? null : JSON.parse(text);
  } catch {
    return null;
  }
}
