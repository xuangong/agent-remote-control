import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { NativeSessionCommand, NativeDaemonRecovery, nativeOpenCommand } from './NativeSessionCommands.js';

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

it('copies the Copilot resume command using its Host profile', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}});
  const id = '01a0ba06-321d-7600-9141-a1ad0779fc9f';
  const container = await render(<NativeSessionCommand providerId="copilot" nativeSessionId={id} />);
  expect(container.textContent).toContain('Copilot profile');
  await act(async () => container.querySelector('button')!.click());
  expect(writeText).toHaveBeenCalledWith(`agent-remote-controller copilot resume ${id}`);
  expect(container.textContent).not.toContain('socket');
});

it('opens the session from its working directory on the Host', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const id = '01a0ba06-321d-7600-9141-a1ad0779fc9f';
  const container = await render(<NativeSessionCommand providerId="claude" nativeSessionId={id} workspace="/Users/me/my project" />);
  expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Open on Host');
  expect(container.textContent).toContain('asks before interrupting');
  expect(container.textContent).not.toContain('working directory');
  await act(async () => container.querySelector('button')!.click());
  expect(writeText).toHaveBeenCalledWith(`cd '/Users/me/my project' && agent-remote-controller claude resume ${id}`);
});

it.each([
  ['/tmp/it\'s $(touch x)', `cd '/tmp/it'\\''s $(touch x)' && agent-remote-controller codex resume 01a0ba06-321d-7600-9141-a1ad0779fc9f`],
  ['C:\\Users\\me\\it\'s', `Set-Location -LiteralPath 'C:\\Users\\me\\it''s' -ErrorAction Stop; agent-remote-controller codex resume 01a0ba06-321d-7600-9141-a1ad0779fc9f`],
  ['\\\\server\\share\\a\u2019b', `Set-Location -LiteralPath '\\\\server\\share\\a\u2019\u2019b' -ErrorAction Stop; agent-remote-controller codex resume 01a0ba06-321d-7600-9141-a1ad0779fc9f`],
  ['relative/path', 'agent-remote-controller codex resume 01a0ba06-321d-7600-9141-a1ad0779fc9f'],
  [`/tmp/a${String.fromCharCode(10)}rm -rf ~`, 'agent-remote-controller codex resume 01a0ba06-321d-7600-9141-a1ad0779fc9f'],
])('quotes the working directory %j for the Host shell', (workspace, command) => {
  expect(nativeOpenCommand('codex', '01a0ba06-321d-7600-9141-a1ad0779fc9f', workspace)).toBe(command);
});

it('asks to run from the working directory when it is unknown', async () => {
  const container = await render(<NativeSessionCommand providerId="opencode" nativeSessionId="ses_0123456789abcdefghijklmnop" />);
  expect(container.querySelector('input')?.value).toBe('agent-remote-controller opencode resume ses_0123456789abcdefghijklmnop');
  expect(container.textContent).toContain('Run it from the session’s working directory.');
});

it.each([
  ['dsh', '01a0ba06-321d-7600-9141-a1ad0779fc9f'],
  ['claude', '$(touch /tmp/unsafe)'],
  ['opencode', '01a0ba06-321d-7600-9141-a1ad0779fc9f'],
  ['opencode', 'ses_$(touch)'],
  ['codex', '$(touch /tmp/unsafe)'],
  ['codex', '--help'],
  ['copilot', '$(touch /tmp/unsafe)'],
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
