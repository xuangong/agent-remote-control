import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionTransferDialog } from './SessionLink.js';

const { readQrImage } = vi.hoisted(() => ({ readQrImage: vi.fn() }));
vi.mock('./qr-image.js', async importOriginal => ({ ...await importOriginal<typeof import('./qr-image.js')>(), readQrImage }));

const link = (query: string) => `${window.location.origin}/?${query}`;
const screenshot = () => new File(['png'], 'qr.png', { type: 'image/png' });

beforeEach(() => {
  readQrImage.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn() });
});

async function scanner(onOpen = vi.fn().mockResolvedValue(true)) {
  await render(<SessionTransferDialog onOpen={onOpen} onClose={() => {}} />);
  return { onOpen, dialog: document.querySelector('dialog')! };
}
function paste(target: Element, data: { files?: File[]; text?: string }) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: data.files ?? [], items: [], getData: () => data.text ?? '' } });
  return act(async () => { target.dispatchEvent(event); });
}
function drop(target: Element, files: File[]) {
  const over = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(over, 'dataTransfer', { value: { files, items: [] } });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files, items: [] } });
  return act(async () => { target.dispatchEvent(over); target.dispatchEvent(event); });
}

it('opens the session of a QR screenshot pasted into the dialog, as a pasted link does', async () => {
  readQrImage.mockResolvedValue(link('host=desk&provider=claude&session=abc'));
  const { onOpen, dialog } = await scanner();
  await paste(dialog.querySelector('button')!, { files: [screenshot()] });
  expect(onOpen).toHaveBeenCalledWith({ hostId: 'desk', providerId: 'claude', nativeSessionId: 'abc' });
});

it('hands on what a pasted screenshot asks for, so that the page can ask the person', async () => {
  readQrImage.mockResolvedValue(link('host=desk&provider=claude&session=abc&as=bot&name=Reuse+test'));
  const { onOpen, dialog } = await scanner();
  await paste(dialog.querySelector('button')!, { files: [screenshot()] });
  expect(onOpen).toHaveBeenCalledWith({ hostId: 'desk', providerId: 'claude', nativeSessionId: 'abc', sessionUse: { kind: 'bot', name: 'Reuse test' } });
});

it('opens the session of a screenshot dropped on the dialog', async () => {
  readQrImage.mockResolvedValue(link('host=desk&provider=codex&session=thread'));
  const { onOpen, dialog } = await scanner();
  await drop(dialog, [screenshot()]);
  expect(onOpen).toHaveBeenCalledWith({ hostId: 'desk', providerId: 'codex', nativeSessionId: 'thread' });
});

it('opens the session of an image chosen from the files', async () => {
  readQrImage.mockResolvedValue(link('host=desk&provider=codex&session=thread'));
  const { onOpen, dialog } = await scanner();
  const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [screenshot()] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('says when an image has no QR code, and opens nothing', async () => {
  readQrImage.mockRejectedValue(Object.assign(new Error('none'), { messageKey: 'sessions.qrImage.none' }));
  const { onOpen, dialog } = await scanner();
  await paste(dialog.querySelector('button')!, { files: [screenshot()] });
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('No QR code was found in this image');
  expect(onOpen).not.toHaveBeenCalled();
});

it('says when the code is not a session link, and opens nothing', async () => {
  readQrImage.mockResolvedValue('https://example.com/other');
  const { onOpen, dialog } = await scanner();
  await paste(dialog.querySelector('button')!, { files: [screenshot()] });
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('another site');
  expect(onOpen).not.toHaveBeenCalled();
});

it('opens a session link pasted as text anywhere in the dialog', async () => {
  const { onOpen, dialog } = await scanner();
  await paste(dialog.querySelector('button')!, { text: link('host=desk&provider=pi&session=s1') });
  expect(onOpen).toHaveBeenCalledWith({ hostId: 'desk', providerId: 'pi', nativeSessionId: 's1' });
  expect(readQrImage).not.toHaveBeenCalled();
});

it('takes no image in the dialog that shows a session’s own QR code', async () => {
  await render(<SessionTransferDialog session={{ hostId: 'desk', agentId: 'a', providerId: 'pi', nativeSessionId: 's1', title: 'T' }} onClose={() => {}} />);
  const dialog = document.querySelector('dialog')!;
  await paste(dialog.querySelector('button')!, { files: [screenshot()] });
  expect(readQrImage).not.toHaveBeenCalled();
});
