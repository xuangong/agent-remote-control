import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { WorkbenchModeSwitch } from './WorkbenchModeSwitch.js';

it('moves between the workbench modes with the arrow keys without choosing one, since choosing hides the switch', async () => {
  const onChange = vi.fn();
  const container = await render(<WorkbenchModeSwitch mode="window" onChange={onChange} />);
  const [windowMode, botMode] = [...container.querySelectorAll('button')];
  windowMode!.focus();
  await act(async () => windowMode!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(document.activeElement).toBe(botMode);
  expect(onChange).not.toHaveBeenCalled();
  expect(windowMode!.getAttribute('aria-pressed')).toBe('true');
});

it('keeps the mode switch names the page and its tests rely on', async () => {
  let mode: 'window' | 'bot' = 'window';
  const container = await render(<WorkbenchModeSwitch mode="window" onChange={next => { mode = next; }} />);
  expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('Workbench mode');
  expect(container.querySelector('nav')?.classList.contains('lab-workbench-mode')).toBe(true);
  const bot = [...container.querySelectorAll('button')].find(button => button.textContent === 'Bot mode')!;
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Window mode')?.getAttribute('aria-pressed')).toBe('true');
  await act(async () => bot.click());
  expect(mode).toBe('bot');
});
