import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionTransferDialog, SessionWorkspaceContext } from './SessionLink.js';

const { toDataURL } = vi.hoisted(() => ({ toDataURL: vi.fn() }));
vi.mock('qrcode', () => ({ toDataURL, default: { toDataURL } }));
const session = { hostId: 'host', agentId: 'agent', providerId: 'codex', nativeSessionId: 'session', title: 'Shared session' };
const failure = 'The QR code could not be generated. Copy the session link instead.';

beforeEach(() => {
  toDataURL.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

it('copies and encodes the explicit history selection without changing native identity', async () => {
  toDataURL.mockResolvedValue('data:image/png;base64,test');
  await render(<SessionTransferDialog session={session} sessionIntent="history" keepOriginal onClose={() => {}} />);
  const dialog = document.querySelector('dialog')!;
  const value = dialog.querySelector('input')!.value;
  const url = new URL(value);
  expect(url.searchParams.get('session')).toBe('session');
  expect(url.searchParams.get('intent')).toBe('history');
  expect(url.searchParams.get('keepOriginal')).toBe('1');
  await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Copy link')!.click());
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(value);
});

it('draws the QR code from the very link it shows and copies, which names the session and not the sharer\'s Window', async () => {
  history.replaceState(null, '', '/?window=sharer-window');
  toDataURL.mockResolvedValue('data:image/png;base64,test');
  await render(<SessionTransferDialog session={session} onClose={() => {}} />);
  await act(async () => { await vi.dynamicImportSettled(); });
  const dialog = document.querySelector('dialog')!;
  const value = dialog.querySelector('input')!.value;
  expect(toDataURL).toHaveBeenCalledWith(value, expect.anything());
  expect(new URL(value).searchParams.get('session')).toBe('session');
  expect(new URL(value).searchParams.has('window')).toBe(false);
  expect(dialog.querySelector('img')?.getAttribute('alt')).toBe('Session QR code');
  history.replaceState(null, '', '/');
});

async function showFailedQR() {
  toDataURL.mockRejectedValue(new Error('Rendering unavailable'));
  await render(<SessionTransferDialog session={session} onClose={() => {}} />);
  await act(async () => { await vi.dynamicImportSettled(); });
  return document.querySelector('dialog')!;
}

it('shows QR failure once and keeps it after copying the fallback link', async () => {
  const dialog = await showFailedQR();
  expect(dialog.textContent!.split(failure)).toHaveLength(2);
  const copy = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Copy link')!;
  await act(async () => copy.click());
  expect(copy.textContent).toBe('Copied');
  expect(dialog.textContent).toContain(failure);
  expect(dialog.textContent).not.toContain('Generating QR code');
});

it('retries QR generation without closing the dialog or losing the session link', async () => {
  const dialog = await showFailedQR();
  const url = dialog.querySelector('input')!.value;
  toDataURL.mockResolvedValue('data:image/png;base64,test');
  const retry = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Retry QR code');
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(dialog.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,test');
  expect(dialog.querySelector('input')!.value).toBe(url);
  expect(dialog.textContent).not.toContain(failure);
});

it.each([
  ['claude', '01a0ba06-321d-7600-9141-a1ad0779fc9f', `cd '/work/app' && agent-remote-controller session attach host/claude/01a0ba06-321d-7600-9141-a1ad0779fc9f`],
  ['claude', '01a0be55-d755-7d72-8463-5a04a193e20e', 'agent-remote-controller session attach host/claude/01a0be55-d755-7d72-8463-5a04a193e20e'],
  ['codex', '01a0ba06-321d-7600-9141-a1ad0779fc9f', 'agent-remote-controller session attach host/codex/01a0ba06-321d-7600-9141-a1ad0779fc9f'],
])('uses the displayed working directory only for %s session %s', async (providerId, nativeSessionId, command) => {
  toDataURL.mockResolvedValue('data:image/png;base64,test');
  await render(<SessionWorkspaceContext.Provider value={{ providerId: 'claude', nativeSessionId: '01a0ba06-321d-7600-9141-a1ad0779fc9f', cwd: '/work/app' }}>
    <SessionTransferDialog session={{ ...session, providerId, nativeSessionId }} onClose={() => {}} />
  </SessionWorkspaceContext.Provider>);
  const dialog = document.querySelector('dialog')!;
  expect([...dialog.querySelectorAll('summary')].map(summary => summary.textContent)).toContain('Open on Host');
  expect(dialog.querySelector<HTMLInputElement>('.lab-native-session-command input')?.value).toBe(command);
});

async function paste(link: string, onOpen: (target: unknown) => Promise<boolean>, onClose = () => {}) {
  await render(<SessionTransferDialog onOpen={onOpen as never} onClose={onClose} />);
  const input = document.querySelector<HTMLInputElement>('#session-transfer-paste')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, link); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  return [...document.querySelectorAll('dialog')].at(-1)!;
}
const own = (query: string) => `${window.location.origin}/?${query}`;

it('opens the session of a pasted link of this site and closes the scanner', async () => {
  const onOpen = vi.fn(async () => true), onClose = vi.fn();
  await paste(own('host=host&provider=codex&session=shared&window=sharer'), onOpen, onClose);
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host', providerId: 'codex', nativeSessionId: 'shared' }));
  expect(onClose).toHaveBeenCalled();
});

it('refuses a link of another site without opening anything, and says when the session could not be opened', async () => {
  const onOpen = vi.fn(async () => false), onClose = vi.fn();
  const foreign = await paste('https://elsewhere.example/?host=host&provider=codex&session=shared', onOpen, onClose);
  expect(onOpen).not.toHaveBeenCalled();
  expect(foreign.querySelector('[role="alert"]')).not.toBeNull();
  const failed = await paste(own('host=host&provider=codex&session=shared'), onOpen, onClose);
  expect(onOpen).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  expect(failed.querySelector('[role="alert"]')).not.toBeNull();
});
