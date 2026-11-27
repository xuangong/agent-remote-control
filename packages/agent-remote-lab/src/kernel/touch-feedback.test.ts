import { afterEach, expect, it } from 'vitest';
import { enableTouchPressedState } from './touch-feedback.js';

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; document.body.innerHTML = ''; });

function touch(target: Element, type: string, x = 5, y = 5): void {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: unknown[] };
  event.touches = type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }];
  target.dispatchEvent(event);
}
function page(): { button: HTMLButtonElement; icon: SVGElement; text: HTMLElement } {
  document.body.innerHTML = '<button type="button"><svg></svg></button><p>Message</p>';
  stop = enableTouchPressedState(document);
  return { button: document.querySelector('button')!, icon: document.querySelector('svg')!, text: document.querySelector('p')! };
}

it('marks the control under the finger at touchstart and clears it when the finger lifts', () => {
  const { button, icon } = page();
  touch(icon, 'touchstart');
  expect(button.hasAttribute('data-pressed')).toBe(true);
  touch(button, 'touchend');
  expect(button.hasAttribute('data-pressed')).toBe(false);
});

it('clears the press when the finger moves like a scroll or the touch is cancelled, and keeps it for a small movement', () => {
  const { button } = page();
  touch(button, 'touchstart'); touch(button, 'touchmove', 8, 5);
  expect(button.hasAttribute('data-pressed')).toBe(true);
  touch(button, 'touchmove', 5, 40);
  expect(button.hasAttribute('data-pressed')).toBe(false);
  touch(button, 'touchstart'); touch(button, 'touchcancel');
  expect(button.hasAttribute('data-pressed')).toBe(false);
});

it('leaves text and disabled controls unmarked', () => {
  const { button, text } = page();
  touch(text, 'touchstart');
  expect(document.querySelector('[data-pressed]')).toBeNull();
  button.disabled = true;
  touch(button, 'touchstart');
  expect(document.querySelector('[data-pressed]')).toBeNull();
});
