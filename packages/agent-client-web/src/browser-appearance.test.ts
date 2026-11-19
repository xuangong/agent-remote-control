// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { bindAppearance } from './browser.js';

beforeEach(() => {
  document.head.innerHTML = '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#000000">'
    + '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">';
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});
const chrome = (media: string) => document.querySelector(`meta[media="(prefers-color-scheme: ${media})"]`)!.getAttribute('content');

it('shows the stored choice at once and persists a new one across a rebind', () => {
  localStorage.setItem('agent-remote:appearance', 'dark');
  const binding = bindAppearance(document, localStorage);
  expect(binding.appearance).toBe('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect([chrome('light'), chrome('dark')]).toEqual(['#151517', '#151517']);
  binding.set('system');
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  expect([chrome('light'), chrome('dark')]).toEqual(['#f3efe9', '#151517']);
  binding.set('light');
  expect(bindAppearance(document, localStorage).appearance).toBe('light');
});

it('still shows a choice when storage refuses it', () => {
  const binding = bindAppearance(document, { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
  expect(binding.appearance).toBe('system');
  binding.set('dark');
  expect(document.documentElement.dataset.theme).toBe('dark');
});
