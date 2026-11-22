import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../../test/setup.js';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { CachePrivacySettings } from './CachePrivacySettings.js';
import { clearCacheOnClose, setClearCacheOnClose, conversationLocalStorage } from '../../kernel/conversation-storage.js';

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
});
afterEach(async () => { await act(async () => { conversationLocalStorage.clear(); await setClearCacheOnClose(false); }); localStorage.clear(); vi.restoreAllMocks(); });
it('requires explicit confirmation before clearing content and leaves it intact when cancelled', async () => {
  localStorage.setItem('agent-remote:recovery:relay:workspace', 'saved chat');
  const view = await render(<CachePrivacySettings />);
  const toggle = view.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  await act(async () => toggle.click());
  const dialog = document.querySelector('dialog')!;
  expect(dialog.textContent).toContain('drafts');
  expect(dialog.textContent).toContain('sign out');
  expect(clearCacheOnClose()).toBe(false);
  await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click());
  expect(localStorage.getItem('agent-remote:recovery:relay:workspace')).toBe('saved chat');
  await act(async () => toggle.click());
  await act(async () => [...document.querySelectorAll('dialog button')].find(button => button.textContent === 'Enable protection')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(clearCacheOnClose()).toBe(true);
  expect(localStorage.getItem('agent-remote:recovery:relay:workspace')).toBeNull();
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(document.querySelector('dialog')).toBeNull();
  await act(async () => toggle.click());
  expect(clearCacheOnClose()).toBe(false);
  expect(document.querySelector('dialog')).toBeNull();
});

it('speaks Chinese when the device does', async () => {
  const view = await render(<LocaleContext.Provider value="zh"><CachePrivacySettings /></LocaleContext.Provider>);
  expect(view.querySelector('h3')?.textContent).toBe('这台设备上的隐私');
  expect(view.textContent).toContain('关闭时清除聊天缓存');
});
