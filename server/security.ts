import type { RequestHandler } from 'express';
import { HttpError } from './errors.js';

export function localUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, 'invalid_backend_url', 'Enter a local http://127.0.0.1:port address.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new HttpError(400, 'nonlocal_backend', 'This version connects only to keyless local ComfyUI and its local proxy. Remote/provider URLs are disabled.');
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}
export type FetchLike = typeof fetch;
export function guardedFetch(base: string, transport: FetchLike = fetch): FetchLike {
  const origin = new URL(localUrl(base)).origin;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const candidate = new URL(input instanceof Request ? input.url : String(input));
    if (candidate.origin !== origin) throw new HttpError(502, 'foreign_backend_link', 'The backend returned a link outside the configured local service.');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    headers.delete('authorization');
    headers.delete('cookie');
    const response = await transport(input, { ...init, headers, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new HttpError(502, 'backend_redirect_blocked', 'Local backend redirects are not allowed.'); }
    return response;
  }) as FetchLike;
}
export function requestGuard(allowedOrigins: string[] = []): RequestHandler {
  const additional = new Set(allowedOrigins.map(origin => {
    const u = new URL(origin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.protocol !== 'http:') throw new Error('Allowed origins must be local HTTP origins.');
    return u.origin;
  }));
  return (req, res, next) => {
    const remote = req.socket.remoteAddress;
    if (!remote || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return next(new HttpError(403, 'local_only', 'The API accepts loopback connections only.'));
    let host: URL;
    try { host = new URL(`http://${req.headers.host || ''}`); } catch { return next(new HttpError(403, 'invalid_host', 'Invalid Host header.')); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) || host.username || host.password) return next(new HttpError(403, 'invalid_host', 'Only loopback Host headers are accepted.'));
    const origin = req.headers.origin;
    if (origin) {
      let valid = false;
      try { valid = origin === host.origin || additional.has(new URL(origin).origin) && origin === new URL(origin).origin; } catch { /* rejected below */ }
      if (!valid) return next(new HttpError(403, 'cross_origin', 'Cross-origin access is blocked. Open the local application URL.'));
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return next(new HttpError(403, 'cross_site', 'Cross-site access is blocked.'));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['content-type'] && !/^(application\/json|multipart\/form-data)(;|$)/i.test(req.headers['content-type'])) return next(new HttpError(415, 'unsupported_content_type', 'Use JSON or multipart/form-data.'));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
