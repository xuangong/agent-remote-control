import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../../test/setup.js';
import { useTrackedSessionDrag } from './useTrackedSessionDrag.js';

const keys = ['first', 'second', 'third'];

function Rows({ reorder }: { reorder: (key: string, target: string, placement: 'before' | 'after') => void }) {
  const drag = useTrackedSessionDrag(keys, reorder);
  return <ul ref={drag.list}>{keys.map(key => (
    <li key={key} data-tracked-key={key} data-drop={drag.drag?.target?.key === key ? drag.drag.target.placement : undefined}>
      <button type="button" data-row={key} onPointerDown={event => drag.start(event, key)} onClick={() => { if (!drag.consumeClick()) clicked(key); }}>{key}</button>
    </li>
  ))}</ul>;
}
const clicked = vi.fn();

function pointer(type: string, init: { pointerType?: string; x?: number; y?: number } = {}): Event {
  return Object.assign(new MouseEvent(type, { button: 0, clientX: init.x ?? 0, clientY: init.y ?? 0, bubbles: true, cancelable: true }),
    { pointerId: 1, pointerType: init.pointerType ?? 'mouse', isPrimary: true });
}

afterEach(() => { vi.restoreAllMocks(); clicked.mockClear(); });

/** The pointer is over the row with this key, in the upper or lower half of it. */
function pointerOver(view: HTMLElement, key: string): void {
  const row = view.querySelector<HTMLElement>(`[data-tracked-key="${key}"]`)!;
  row.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON() {} });
  document.elementFromPoint = () => row;
}

async function startDrag(view: HTMLElement, from: string, toKey: string, y: number): Promise<void> {
  const button = view.querySelector<HTMLButtonElement>(`[data-row="${from}"]`)!;
  button.setPointerCapture = vi.fn();
  await act(async () => { button.dispatchEvent(pointer('pointerdown', { x: 5, y: 5 })); });
  pointerOver(view, toKey);
  await act(async () => { document.dispatchEvent(pointer('pointermove', { x: 5, y })); });
}

it('reorders a row dragged anywhere on it onto the half of the row under the pointer', async () => {
  const reorder = vi.fn();
  const view = await render(<Rows reorder={reorder} />);
  await startDrag(view, 'third', 'first', 105);
  expect(view.querySelector('[data-drop="before"]')?.getAttribute('data-tracked-key')).toBe('first');
  await act(async () => { document.dispatchEvent(pointer('pointerup', { x: 5, y: 105 })); });
  expect(reorder).toHaveBeenCalledExactlyOnceWith('third', 'first', 'before');
  expect(view.querySelector('[data-drop]')).toBeNull();
  // The click that ends a drag does not open the row.
  await act(async () => view.querySelector<HTMLButtonElement>('[data-row="third"]')!.click());
  expect(clicked).not.toHaveBeenCalled();
  await act(async () => view.querySelector<HTMLButtonElement>('[data-row="third"]')!.click());
  expect(clicked).toHaveBeenCalledWith('third');
});

it('places a row after the target when the pointer is in its lower half', async () => {
  const reorder = vi.fn();
  const view = await render(<Rows reorder={reorder} />);
  await startDrag(view, 'first', 'third', 135);
  await act(async () => { document.dispatchEvent(pointer('pointerup', { x: 5, y: 135 })); });
  expect(reorder).toHaveBeenCalledExactlyOnceWith('first', 'third', 'after');
});

it('cancels a drag with Escape without reordering', async () => {
  const reorder = vi.fn();
  const view = await render(<Rows reorder={reorder} />);
  await startDrag(view, 'third', 'first', 105);
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  await act(async () => { document.dispatchEvent(pointer('pointerup', { x: 5, y: 105 })); });
  expect(reorder).not.toHaveBeenCalled();
  expect(view.querySelector('[data-drop]')).toBeNull();
});

it('keeps a touch swipe on a row as native scrolling', async () => {
  const reorder = vi.fn();
  const view = await render(<Rows reorder={reorder} />);
  const button = view.querySelector<HTMLButtonElement>('[data-row="third"]')!;
  button.setPointerCapture = vi.fn();
  await act(async () => { button.dispatchEvent(pointer('pointerdown', { pointerType: 'touch' })); });
  expect(button.setPointerCapture).not.toHaveBeenCalled();
});

it('treats a press that moves less than a drag threshold as a click', async () => {
  const reorder = vi.fn();
  const view = await render(<Rows reorder={reorder} />);
  const button = view.querySelector<HTMLButtonElement>('[data-row="second"]')!;
  button.setPointerCapture = vi.fn();
  await act(async () => { button.dispatchEvent(pointer('pointerdown', { x: 5, y: 5 })); });
  await act(async () => { document.dispatchEvent(pointer('pointermove', { x: 7, y: 7 })); });
  await act(async () => { document.dispatchEvent(pointer('pointerup', { x: 7, y: 7 })); });
  await act(async () => button.click());
  expect(reorder).not.toHaveBeenCalled();
  expect(clicked).toHaveBeenCalledWith('second');
});
