// The page side of a smoke run: an observer injected before the page's scripts, and the conversion of what it saw into the
// PageSample and PageRow shapes the invariants read. The observer samples the conversation view whenever the document changes.
import type { PageRow, PageSample } from '../invariants/types.js';

export const observerSource = `(() => {
  const log = [];
  const unique = list => [...new Set(list)];
  const texts = selector => unique([...document.querySelectorAll(selector)].map(node => node.textContent.trim()).filter(Boolean));
  const read = () => {
    const editor = document.querySelector('[data-testid="prompt-input"]');
    return {
      labels: texts('.lab-conversation-status'),
      loading: texts('.lab-empty-state h3'),
      composer: !editor ? 'absent' : editor.getAttribute('aria-disabled') === 'true' || editor.getAttribute('contenteditable') === 'false' ? 'disabled' : 'enabled',
      messages: document.querySelectorAll('.agent-message').length,
      entries: document.querySelectorAll('.agent-timeline-entry').length,
      delivery: unique([...document.querySelectorAll('[data-delivery-state]')].map(node => node.getAttribute('data-delivery-state'))),
    };
  };
  let last = '', lastRun = 0, scheduled = false, firstRowAt = null;
  const sample = () => {
    scheduled = false; lastRun = performance.now();
    const state = read(), key = JSON.stringify(state);
    if (firstRowAt === null && state.entries > 0) firstRowAt = Date.now();
    if (key !== last) { last = key; log.push({ t: Date.now(), ...state }); }
  };
  const request = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(sample, Math.max(0, 8 - (performance.now() - lastRun)));
  };
  const start = () => {
    new MutationObserver(request).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    sample();
  };
  if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
  setInterval(request, 100);
  const scroller = () => {
    for (let at = document.querySelector('.agent-timeline-entry')?.parentElement; at; at = at.parentElement) if (at.scrollHeight > at.clientHeight && /auto|scroll/.test(getComputedStyle(at).overflowY)) return at;
    return document.scrollingElement;
  };
  window.__smoke = {
    log, read, firstRowAt: () => firstRowAt,
    rows: () => [...document.querySelectorAll('.agent-timeline-entry')].map(node => ({
      key: node.getAttribute('data-entry-key') || '',
      kind: node.querySelector('.agent-message-user') ? 'user_message' : node.querySelector('.agent-message-assistant') ? 'assistant_message' : node.querySelector('.agent-tool-chevron') ? 'tool_call' : 'other',
      text: (node.innerText || '').trim(),
    })),
    mark: () => { window.__smokeMarks = [...document.querySelectorAll('.agent-timeline-entry')]; return window.__smokeMarks.length; },
    survivors: () => ({ total: window.__smokeMarks?.length ?? 0, alive: (window.__smokeMarks ?? []).filter(node => node.isConnected).length }),
    scrollerSize: () => { const target = scroller(); return { scrollHeight: target.scrollHeight, clientHeight: target.clientHeight, scrollTop: target.scrollTop, rows: document.querySelectorAll('.agent-timeline-entry').length, className: target.className }; },
    scrollToMiddle: () => {
      const target = scroller();
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
      // The timeline is anchored at its bottom with a reversed column, where scrollTop is zero at the newest row and negative above it.
      const middle = Math.max(0, (target.scrollHeight - target.clientHeight) / 2);
      target.scrollTop = getComputedStyle(target).flexDirection === 'column-reverse' ? -middle : middle;
      target.dispatchEvent(new Event('scroll'));
      return Math.abs(target.scrollTop);
    },
    anchor: () => {
      const target = scroller(), top = target === document.scrollingElement ? 0 : target.getBoundingClientRect().top;
      const row = [...document.querySelectorAll('.agent-timeline-entry')].find(node => node.getBoundingClientRect().bottom > top + 1);
      return row ? { key: row.getAttribute('data-entry-key'), offset: Math.round((row.getBoundingClientRect().top - top) * 10) / 10 } : null;
    },
    composer: () => {
      const editor = document.querySelector('[data-testid="prompt-input"]');
      return editor ? { text: editor.textContent ?? '', focused: editor.contains(document.activeElement) || document.activeElement === editor } : null;
    },
    setHidden: hidden => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(hidden ? 'blur' : 'focus'));
    },
  };
})();`;

export interface RawSample { t: number; labels: string[]; loading: string[]; composer: 'absent' | 'disabled' | 'enabled'; messages: number; entries: number; delivery: string[] }

/** Observer samples to page samples on the run's clock (`origin` is the wall-clock time the run's clock started). */
export function toPageSamples(raw: RawSample[], origin: number): PageSample[] {
  return raw.map(item => ({ t: item.t - origin, labels: item.labels, loading: item.loading, messages: item.messages, entries: item.entries, composer: item.composer, delivery: item.delivery }));
}

export const toPageRows = (rows: Array<{ key: string; kind: string; text: string }>): PageRow[] => rows.map(row => ({ key: row.key, kind: row.kind, text: row.text }));
