import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionTransferDialog } from './SessionLink.js';

const { toDataURL } = vi.hoisted(() => ({ toDataURL: vi.fn() }));
vi.mock('qrcode', () => ({ toDataURL, default: { toDataURL } }));
const session = { hostId: 'host', agentId: 'agent', providerId: 'codex', nativeSessionId: 'session', title: 'Shared session' };
const failure = 'The QR code could not be generated. Copy the session link instead.';

beforeEach(() => {
  toDataURL.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
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
