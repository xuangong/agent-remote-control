import { createHash } from 'node:crypto';
import { accessBrandMark, accessCopy, accessPageStyle } from './access-page.js';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Render Google callback failures without attempting the Gateway ticket exchange. */
export function authenticationFailure(origin: string, reason: 'denied' | 'unavailable' | 'capacity', returnPath?: string): Response {
  const state = reason === 'denied' ? 'expired' : 'unavailable';
  const copy = accessCopy[state];
  const description = reason === 'denied' ? 'This sign-in expired, was cancelled, or the account is not approved for this site. Sign in again with an approved account.'
    : reason === 'capacity' ? 'This site has reached its account capacity. Contact the site operator before trying again.' : copy.description;
  const target = returnPath && (returnPath === '/' || returnPath.startsWith('/?')) && returnPath.length <= 32768 ? returnPath : '/';
  const css = 'body{margin:0}' + accessPageStyle;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Sign in · Agent Remote</title><style>${css}</style></head><body>
<main class="arc-access" data-state="${state}">
  <header class="arc-access-brand">${accessBrandMark}Agent Remote</header>
  <section class="arc-access-body" aria-labelledby="access-title">
    <p class="arc-access-eyebrow">Sign-in interrupted</p>
    <h1 id="access-title">${copy.title}</h1>
    <p class="arc-access-description" role="alert">${description}</p>
    <div class="arc-access-actions"><a class="arc-access-action" href="${escape('/auth/login' + target.slice(1))}">Sign in again</a><a class="arc-access-secondary" href="/">Back to Agent Remote</a></div>
    <p class="arc-access-note">Use an account approved for this site.</p>
  </section>
  <footer class="arc-access-footer"><span>Agent Remote Control</span><span class="arc-access-host">${escape(new URL(origin).host)}</span></footer>
</main></body></html>`, { status: reason === 'denied' ? 401 : reason === 'capacity' ? 429 : 503, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; base-uri 'none'; frame-ancestors 'none'`,
  } });
}
