// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { bindLanguage, bindMotion } from './browser.js';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('lang');
  delete document.documentElement.dataset.motion;
});

/** A window whose languages and reduced-motion query the test sets, and whose events it sends. */
function view(languages: readonly string[], systemReduces = false) {
  const target = new EventTarget();
  const query = Object.assign(new EventTarget(), { matches: systemReduces });
  return {
    addEventListener: target.addEventListener.bind(target) as Window['addEventListener'],
    navigator: { languages, language: languages[0] ?? 'en' } as unknown as Navigator,
    matchMedia: (() => query) as unknown as Window['matchMedia'],
    send: (event: Event) => target.dispatchEvent(event),
    setSystem: (reduces: boolean) => { query.matches = reduces; query.dispatchEvent(new Event('change')); },
  };
}

it('shows the browser\'s language until the device chooses one, and sets <html lang>', () => {
  const page = view(['en-US']);
  const language = bindLanguage(document, localStorage, page);
  expect([language.value, language.locale, document.documentElement.lang]).toEqual(['browser', 'en', 'en']);
  const heard = vi.fn();
  language.subscribe(heard);
  language.set('zh');
  expect([language.locale, document.documentElement.lang, localStorage.getItem('agent-remote:language')]).toEqual(['zh', 'zh-CN', 'zh']);
  language.set('browser');
  expect([language.locale, localStorage.getItem('agent-remote:language')]).toEqual(['en', null]);
  expect(heard).toHaveBeenCalledTimes(2);
});

it('a stored choice wins over the browser, and another tab\'s choice arrives', () => {
  localStorage.setItem('agent-remote:language', 'en');
  const page = view(['zh-CN']);
  const language = bindLanguage(document, localStorage, page);
  expect(language.locale).toBe('en');
  const heard = vi.fn();
  language.subscribe(heard);
  localStorage.setItem('agent-remote:language', 'zh');
  page.send(Object.assign(new Event('storage'), { key: 'agent-remote:language' }));
  expect([language.value, language.locale, document.documentElement.lang]).toEqual(['zh', 'zh', 'zh-CN']);
  expect(heard).toHaveBeenCalledTimes(1);
  page.send(Object.assign(new Event('storage'), { key: 'agent-remote:appearance' }));
  expect(heard).toHaveBeenCalledTimes(1);
});

it('reduces motion for the device\'s choice or the system\'s, and never adds motion the system refused', () => {
  const page = view(['en']);
  const motion = bindMotion(document, localStorage, page);
  expect([motion.value, motion.reduced, document.documentElement.dataset.motion]).toEqual(['system', false, undefined]);
  motion.set('reduce');
  expect([motion.reduced, document.documentElement.dataset.motion, localStorage.getItem('agent-remote:motion')]).toEqual([true, 'reduce', 'reduce']);
  motion.set('system');
  expect([motion.reduced, document.documentElement.dataset.motion, localStorage.getItem('agent-remote:motion')]).toEqual([false, undefined, null]);
  const heard = vi.fn();
  motion.subscribe(heard);
  page.setSystem(true);
  expect([motion.reduced, motion.systemReduced, document.documentElement.dataset.motion]).toEqual([true, true, 'reduce']);
  expect(heard).toHaveBeenCalledTimes(1);
});

it('keeps a choice for the page when storage refuses it', () => {
  const refusing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const language = bindLanguage(document, refusing, view(['en']));
  language.set('zh');
  expect(language.locale).toBe('zh');
});
