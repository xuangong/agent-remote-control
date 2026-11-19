// A Lab Menu inside the Orchard Sheet: a press on the backdrop closes the menu, not the sheet.
import { act, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { Menu } from './Menu.js';
import { Sheet } from '@orchardworks/agent-client-web/primitives';

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

it('closes only its open menu when the backdrop is pressed', async () => {
  const { dialog } = await opened(<Menu label="Window actions" items={[{ label: 'Rename', onSelect: vi.fn() }]} />);
  await act(async () => (dialog.querySelector('button[aria-label="Window actions"]') as HTMLButtonElement).click());
  expect(dialog.querySelector('[role="menu"]')).not.toBeNull();
  await press(dialog, 100);
  expect(dialog.querySelector('[role="menu"]')).toBeNull();
  expect(dialog.open).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
});
