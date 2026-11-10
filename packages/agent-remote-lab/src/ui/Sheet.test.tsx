import { act, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { Menu } from './Menu.js';
import { Sheet } from './Sheet.js';

// jsdom has no modal dialogs. Like browsers, the stub ignores closing a closed dialog and queues the close event as a task.
const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
const close = vi.fn(function (this: HTMLDialogElement) {
  if (!this.open) return;
  this.removeAttribute('open');
  setTimeout(() => this.dispatchEvent(new Event('close')));
});
const onClose = vi.fn();
let setOpen: (open: boolean) => void = () => {};

beforeEach(() => {
  showModal.mockClear();
  close.mockClear();
  onClose.mockClear();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close });
});

/** Lets queued close events arrive. */
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

function Harness({ children = <p>Body</p> }: { children?: ReactNode }) {
  const [open, set] = useState(false);
  setOpen = set;
  return <><button type="button" onClick={() => set(true)}>Open</button>
    <Sheet open={open} title="Windows" detent="large" onClose={() => { onClose(); set(false); }}>{children}</Sheet></>;
}

async function opened(children?: ReactNode) {
  const container = await render(<Harness>{children}</Harness>);
  const dialog = container.querySelector('dialog')!;
  const openButton = container.querySelector('button')!;
  await act(async () => openButton.click());
  // jsdom lays nothing out: put the sheet in the lower half of an 800px viewport.
  dialog.getBoundingClientRect = () => ({ left: 0, right: 390, top: 400, bottom: 800, x: 0, y: 400, width: 390, height: 400, toJSON() {} }) as DOMRect;
  return { dialog, openButton };
}

const press = (target: Element, clientY: number) => act(async () => {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY }));
});

it('opens as a modal sheet named by its heading, and closes from its button', async () => {
  const container = await render(<Harness />);
  const dialog = container.querySelector('dialog')!;
  expect(dialog.open).toBe(false);
  await act(async () => container.querySelector('button')!.click());
  expect(dialog.open).toBe(true);
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Windows');
  expect(dialog.dataset.detent).toBe('large');
  await act(async () => (dialog.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click());
  await settle();
  expect(dialog.open).toBe(false);
  expect(onClose).toHaveBeenCalledOnce();
});

it('is half height unless asked otherwise', async () => {
  const container = await render(<Sheet open={false} title="Views" onClose={vi.fn()}><p>Body</p></Sheet>);
  expect(container.querySelector('dialog')!.dataset.detent).toBe('medium');
});

it('closes on Escape through its owner, once', async () => {
  const { dialog } = await opened();
  const cancel = new Event('cancel', { cancelable: true });
  await act(async () => { dialog.dispatchEvent(cancel); });
  await settle();
  expect(cancel.defaultPrevented).toBe(true);
  expect(dialog.open).toBe(false);
  expect(onClose).toHaveBeenCalledOnce();
});

it('closes on a press on the backdrop only, not beside its grabber or when a press inside ends there', async () => {
  const { dialog } = await opened();
  await press(dialog, 402);
  expect(dialog.open).toBe(true);
  // A text selection that starts in the body and ends on the backdrop clicks the dialog itself.
  await act(async () => {
    dialog.querySelector('p')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 500 }));
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }));
  });
  expect(dialog.open).toBe(true);
  await press(dialog, 100);
  await settle();
  expect(dialog.open).toBe(false);
  expect(onClose).toHaveBeenCalledOnce();
});

it('closes only its open menu when the backdrop is pressed', async () => {
  const { dialog } = await opened(<Menu label="Window actions" items={[{ label: 'Rename', onSelect: vi.fn() }]} />);
  await act(async () => (dialog.querySelector('button[aria-label="Window actions"]') as HTMLButtonElement).click());
  expect(dialog.querySelector('[role="menu"]')).not.toBeNull();
  await press(dialog, 100);
  expect(dialog.querySelector('[role="menu"]')).toBeNull();
  expect(dialog.open).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
});

it('tells its owner when the browser closes it on its own, and not when the owner closes it', async () => {
  const { dialog, openButton } = await opened();
  await act(async () => dialog.close());
  await settle();
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => openButton.click());
  expect(dialog.open).toBe(true);
  await act(async () => setOpen(false));
  await settle();
  expect(dialog.open).toBe(false);
  expect(onClose).toHaveBeenCalledOnce();
});

it('stays open when it is closed and opened again before the close event arrives', async () => {
  const { dialog } = await opened();
  await act(async () => { flushSync(() => setOpen(false)); flushSync(() => setOpen(true)); });
  await settle();
  expect(dialog.open).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
});

it('opens when it mounts open, and closes its dialog when it unmounts open', async () => {
  let unmount: () => void = () => {};
  function Owner() {
    const [shown, setShown] = useState(true);
    unmount = () => setShown(false);
    return shown ? <Sheet open title="Views" onClose={onClose}><p>Body</p></Sheet> : null;
  }
  const container = await render(<Owner />);
  expect(container.querySelector('dialog')!.open).toBe(true);
  await act(async () => unmount());
  await settle();
  expect(close).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
});
