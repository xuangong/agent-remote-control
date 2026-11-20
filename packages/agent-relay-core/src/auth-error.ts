import { accessLocale, accessView, accessWord } from './access-page.js';
import { accessDocument, accessPanel, escapeHtml } from './auth-page.js';

/** Render Google callback failures without attempting the Gateway ticket exchange. */
export function authenticationFailure(origin: string, reason: 'denied' | 'unavailable' | 'capacity', returnPath?: string, languages?: string | null): Response {
  const locale = accessLocale(languages);
  const state = reason === 'denied' ? 'expired' : 'unavailable';
  const view = accessView(state, locale, { surface: 'relay', ...(reason === 'unavailable' ? {} : { failure: reason }) });
  if (view.kind !== 'card') throw new Error('A sign-in failure is a card.');
  const target = returnPath && (returnPath === '/' || returnPath.startsWith('/?')) && returnPath.length <= 32768 ? returnPath : '/';
  const actions = `<a class="arc-access-action" href="${escapeHtml('/auth/login' + target.slice(1))}">${escapeHtml(view.action)}</a><a class="arc-access-secondary" href="/">${escapeHtml(view.secondary ?? accessWord(locale, 'action.back'))}</a>`;
  const page = accessDocument({ locale, title: 'page.signIn', body: accessPanel({ state, view, host: new URL(origin).host, actions, error: true }) });
  return new Response(page.html, { status: reason === 'denied' ? 401 : reason === 'capacity' ? 429 : 503, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; style-src 'sha256-${page.styleHash}'; base-uri 'none'; frame-ancestors 'none'`,
  } });
}
