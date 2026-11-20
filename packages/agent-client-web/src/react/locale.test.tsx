// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import type { LanguageChoice, Locale } from '@orchardworks/agent-client';
import { LocaleProvider, useLanguageChoice, useTranslate, type LanguageSource } from './locale.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); document.body.innerHTML = ''; });

/** A language choice the test changes, as bindLanguage keeps one. */
function source(browser: Locale): LanguageSource {
  const listeners = new Set<() => void>();
  let value: LanguageChoice = 'browser';
  return {
    get value() { return value; }, get locale() { return value === 'browser' ? browser : value; },
    set(next) { value = next; for (const listener of listeners) listener(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

function Words() {
  const t = useTranslate();
  const language = useLanguageChoice();
  return <p data-choice={language?.value}>{t('approval.allow')}</p>;
}

it('renders every word again in the language the device chooses', () => {
  const language = source('en');
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host); roots.push(root);
  act(() => root.render(<LocaleProvider language={language}><Words /></LocaleProvider>));
  expect(host.textContent).toBe('Allow');
  act(() => language.set('zh'));
  expect(host.textContent).toBe('好的');
  expect(host.querySelector('p')!.dataset.choice).toBe('zh');
  act(() => language.set('browser'));
  expect(host.textContent).toBe('Allow');
});

it('speaks English without a provider', () => {
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host); roots.push(root);
  act(() => root.render(<Words />));
  expect(host.textContent).toBe('Allow');
});
