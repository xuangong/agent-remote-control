import { createHash } from 'node:crypto';
import { accessMark, accessPageStyle, accessWord, accessWordmark, type AccessLocale, type AccessPageState, type AccessView, type AccessWordKey } from './access-page.js';

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
export const htmlLang = (locale: AccessLocale) => locale === 'zh' ? 'zh-CN' : 'en';
export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64');

/** The panel of an access page: a wait (the mark and one sentence) or a card (the mark with the wordmark, title, description, actions, host). */
export function accessPanel(input: {
  state: AccessPageState | 'cli'; view: AccessView; host: string; actions?: string; extra?: string; after?: string;
  /** Render both the wait and the card, so the page's script can switch between them. */
  switching?: boolean; error?: boolean; noscript?: string;
}): string {
  const { view, host } = input;
  const wait = view.kind === 'wait';
  const brand = `<div class="arc-access-brand"><span class="arc-access-mark">${accessMark}</span><span class="arc-access-wordmark">${accessWordmark}</span></div>`;
  const sentence = wait || input.switching ? `<p class="arc-access-sentence" id="access-status" role="status">${escapeHtml(wait ? view.sentence : '')}</p>` : '';
  const detail = !wait || input.switching
    ? `<div class="arc-access-detail"><h1 id="access-title" tabindex="-1">${escapeHtml(wait ? '' : view.title)}</h1><p class="arc-access-description" id="access-description"${input.error ? ' role="alert"' : ''}>${escapeHtml(wait ? '' : view.description)}</p>${input.extra ?? ''}<div class="arc-access-actions" id="access-actions">${input.actions ?? ''}</div>${input.after ?? ''}<footer class="arc-access-footer">${escapeHtml(host)}</footer></div>`
    : '';
  return `<main class="arc-access" data-state="${input.state}" data-kind="${wait ? 'wait' : 'card'}"><div class="arc-access-panel">${brand}${sentence}${input.noscript ? `<noscript><p class="arc-access-note">${escapeHtml(input.noscript)}</p></noscript>` : ''}${detail}</div></main>`;
}

/** An access page's document and the hashes its Content-Security-Policy allows. */
export function accessDocument(input: { locale: AccessLocale; title: AccessWordKey; body: string; script?: string; noscript?: string }): { html: string; styleHash: string; scriptHash?: string } {
  const css = accessPageStyle;
  const { script } = input;
  const html = `<!doctype html><html lang="${htmlLang(input.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/app/icon-192.png"><title>${escapeHtml(accessWord(input.locale, input.title))}</title><style>${css}</style></head><body>${input.body}${script ? `<script>${script}</script>` : ''}</body></html>`;
  return { html, styleHash: sha256(css), ...(script ? { scriptHash: sha256(script) } : {}) };
}
