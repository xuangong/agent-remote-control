// The width separator of a pane (a dock, a primary group or an attached Side): the sizes its keyboard and double click ask for.
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { DockResize } from './SessionDock.js';

async function separator(width: number, props: { minimum?: number } = {}) {
  const onResize = vi.fn();
  const view = await render(<DockResize title="Side" width={width} onResize={onResize} {...props} />);
  return { onResize, element: view.querySelector<HTMLElement>('[role="separator"]')! };
}
const press = (element: HTMLElement, key: string, shiftKey = false) => act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true })); });

it('is named after its pane and reports its width and limits', async () => {
  const { element } = await separator(500);
  expect(element.getAttribute('aria-label')).toBe('Side width');
  expect([element.getAttribute('aria-valuemin'), element.getAttribute('aria-valuenow'), element.getAttribute('aria-valuemax')]).toEqual(['320', '500', '1600']);
});

it('moves by 10 pixels per arrow key and by 40 with Shift', async () => {
  const { element, onResize } = await separator(500);
  await press(element, 'ArrowLeft');
  await press(element, 'ArrowRight');
  await press(element, 'ArrowRight', true);
  await press(element, 'ArrowLeft', true);
  expect(onResize.mock.calls.map(call => call[0])).toEqual([490, 510, 540, 460]);
});

it('goes to its minimum on Home, and to the default width on Enter and on a double click', async () => {
  const { element, onResize } = await separator(700);
  await press(element, 'Home');
  await press(element, 'Enter');
  await act(async () => { element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
  expect(onResize.mock.calls.map(call => call[0])).toEqual([320, 440, 440]);
});

it('keeps every requested width between the minimum and the maximum, and ignores other keys', async () => {
  const { element, onResize } = await separator(330, { minimum: 300 });
  await press(element, 'ArrowLeft', true);
  await press(element, 'Tab');
  expect(onResize.mock.calls.map(call => call[0])).toEqual([300]);
  const wide = await separator(1590);
  await press(wide.element, 'ArrowRight', true);
  expect(wide.onResize.mock.calls.map(call => call[0])).toEqual([1600]);
});
