import { act, useState } from 'react';
import { beforeEach, expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { Sheet } from './Sheet.js';

beforeEach(() => {
  // jsdom has no modal dialogs.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); } });
});

function Harness() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>Open</button>
    <Sheet open={open} title="Windows" detent="large" onClose={() => setOpen(false)}><p>Body</p></Sheet></>;
}

async function opened() {
  const container = await render(<Harness />);
  const dialog = container.querySelector('dialog')!;
  const openButton = container.querySelector('button')!;
  await act(async () => openButton.click());
  return { dialog, openButton };
}

it('opens as a named modal sheet and closes from its button', async () => {
  const container = await render(<Harness />);
  const dialog = container.querySelector('dialog')!;
  expect(dialog.open).toBe(false);
  await act(async () => container.querySelector('button')!.click());
  expect(dialog.open).toBe(true);
  expect(dialog.getAttribute('aria-label')).toBe('Windows');
  expect(dialog.dataset.detent).toBe('large');
  expect(dialog.querySelector('h2')?.textContent).toBe('Windows');
  await act(async () => (dialog.querySelector('button[aria-label="Close Windows"]') as HTMLButtonElement).click());
  expect(dialog.open).toBe(false);
});

it('closes on Escape through its owner', async () => {
  const { dialog } = await opened();
  const cancel = new Event('cancel', { cancelable: true });
  await act(async () => { dialog.dispatchEvent(cancel); });
  expect(cancel.defaultPrevented).toBe(true);
  expect(dialog.open).toBe(false);
});

it('closes on a press on the backdrop, but not when a press inside it ends there', async () => {
  const { dialog } = await opened();
  // A text selection that starts in the body and ends on the backdrop clicks the dialog itself.
  await act(async () => {
    dialog.querySelector('p')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(dialog.open).toBe(true);
  await act(async () => {
    dialog.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(dialog.open).toBe(false);
});

it('tells its owner when the browser closes it without a cancel event', async () => {
  const { dialog, openButton } = await opened();
  await act(async () => dialog.close());
  expect(dialog.open).toBe(false);
  // The owner's state followed, so opening again shows the sheet again.
  await act(async () => openButton.click());
  expect(dialog.open).toBe(true);
});
