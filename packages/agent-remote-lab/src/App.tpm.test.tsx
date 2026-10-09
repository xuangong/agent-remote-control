import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { replicaState } from './test/fixtures.js';
import { render } from './test/setup.js';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
it('runs TPM commands locally from the ordinary chatbox and exposes an independent View-menu choice', async () => {
  const sendMessage = vi.fn(async () => {});
  const container = await render(<App initialState={replicaState} initialSessionStatus="ready" actions={{ sendMessage }} />);
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="prompt-input"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '/tpm on');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  expect(container.querySelector<HTMLElement>('.lab-tpm-floating')?.hidden).toBe(false);
  expect(sendMessage).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click());
  const choice = container.querySelector<HTMLInputElement>('[aria-label="TPM view"]');
  expect(choice?.checked).toBe(true);
  await act(async () => choice!.click());
  expect(container.querySelector<HTMLElement>('.lab-tpm-floating')?.hidden).toBe(true);
  expect(localStorage.getItem('agent-remote:tpm-view')).toBe('false');
});
