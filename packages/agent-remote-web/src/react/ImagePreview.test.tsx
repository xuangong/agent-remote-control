import { act } from 'react';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { ImagePreview } from './ImagePreview.js';

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; } },
  });
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: vi.fn(() => 'blob:preview') },
    revokeObjectURL: { configurable: true, value: vi.fn() },
  });
});
beforeEach(() => vi.clearAllMocks());

it('offers image zoom controls without losing upload actions and restores focus on close', async () => {
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  const close = vi.fn();
  const container = await render(<ImagePreview blob={new Blob(['image'], { type: 'image/png' })} label="Screenshot"
    status="Ready to send" actions={<button type="button">Remove</button>} onClose={close} />);
  const dialog = document.querySelector('dialog')!;
  expect(dialog.querySelector('[aria-label="Zoom in"]')).not.toBeNull();
  expect(dialog.querySelector('[aria-label="Zoom out"]')).not.toBeNull();
  expect(dialog.querySelector('[aria-label="Reset zoom"]')).not.toBeNull();
  expect(dialog.querySelector('.agent-image-preview-status [role="status"]')?.textContent).toBe('Ready to send');
  expect(dialog.textContent).toContain('Remove');
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(close).toHaveBeenCalledOnce();
  await unmount(container);
  expect(document.activeElement).toBe(trigger);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  trigger.remove();
});

it('reuses caller-owned image bytes and handles Escape without closing the parent preview', async () => {
  const parentKey = vi.fn(); const close = vi.fn();
  const container = await render(<div onKeyDown={parentKey}><ImagePreview src="blob:caller-owned" onClose={close} /></div>);
  const dialog = document.querySelector('dialog')!;
  expect(dialog.querySelector('img')?.src).toBe('blob:caller-owned');
  await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(close).toHaveBeenCalledOnce();
  expect(parentKey).not.toHaveBeenCalled();
  await unmount(container);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
});

it('leaves close available and disables image gestures when decoding fails', async () => {
  await render(<ImagePreview src="data:image/png;base64,AA==" onClose={() => {}} />);
  const dialog = document.querySelector('dialog')!;
  await act(async () => dialog.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('This image cannot be previewed.');
  expect(dialog.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')?.disabled).toBe(true);
  expect(dialog.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')?.disabled).toBe(false);
});

it('keeps preview focus and gestures out of the surrounding conversation', async () => {
  const timelineInteraction = vi.fn();
  await render(<div onFocus={timelineInteraction} onTouchMove={timelineInteraction} onWheel={timelineInteraction} onKeyDown={timelineInteraction}>
    <ImagePreview src="blob:caller-owned" onClose={() => {}} />
  </div>);
  const dialog = document.querySelector('dialog')!;
  await act(async () => {
    dialog.querySelector<HTMLButtonElement>('button')!.focus();
    dialog.dispatchEvent(new Event('touchmove', { bubbles: true }));
    dialog.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 10 }));
    dialog.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  });
  expect(timelineInteraction).not.toHaveBeenCalled();
});
