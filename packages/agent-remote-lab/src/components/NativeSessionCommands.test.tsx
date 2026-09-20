import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { NativeSessionCommand, NativeDaemonRecovery } from './NativeSessionCommands.js';

it('copies a native resume command and identifies the Host computer', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const id = '01a0ba06-321d-7600-9141-a1ad0779fc9f';
  const container = await render(<NativeSessionCommand providerId="codex" nativeSessionId={id} />);
  expect(container.textContent).toContain('Host computer');
  await act(async () => container.querySelector('button')!.click());
  expect(writeText).toHaveBeenCalledWith(`agent-remote-controller codex resume ${id}`);
  expect(container.textContent).toContain('Copied');
});

it.each([
  ['claude', '01a0ba06-321d-7600-9141-a1ad0779fc9f'],
  ['codex', '$(touch /tmp/unsafe)'],
  ['codex', '--help'],
])('does not suggest commands for unsupported or untrusted identities', async (providerId, nativeSessionId) => {
  const container = await render(<NativeSessionCommand providerId={providerId} nativeSessionId={nativeSessionId} />);
  expect(container.textContent).toBe('');
});

it('reveals restart risks before offering a command and never performs a restart', async () => {
  const container = await render(<NativeDaemonRecovery />);
  const details = container.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain('all sessions');
  expect(details.textContent).toContain('interrupted');
  expect(details.textContent).toContain('will not be resent');
  expect(container.querySelector('input')?.value).toBe('agent-remote-controller codex daemon restart');
  expect(container.querySelector('button')?.textContent).toBe('Copy restart command');
});

it('keeps the command selectable when clipboard access fails', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  const container = await render(<NativeDaemonRecovery />);
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Select and copy');
  expect(container.querySelector('input')?.readOnly).toBe(true);
});
