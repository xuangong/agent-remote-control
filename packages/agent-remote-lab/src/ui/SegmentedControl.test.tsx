import { act, useState } from 'react';
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { SegmentedControl } from './SegmentedControl.js';
import { WorkbenchModeSwitch } from '../components/WorkbenchModeSwitch.js';

function Harness() {
  const [value, setValue] = useState<'bots' | 'windows'>('bots');
  return <SegmentedControl label="Mode" value={value} onChange={setValue} options={[{ value: 'bots', label: 'Bots' }, { value: 'windows', label: 'Windows' }]} />;
}

it('marks the chosen segment and changes on click', async () => {
  const container = await render(<Harness />);
  const [bots, windows] = [...container.querySelectorAll('button')];
  expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('Mode');
  expect(bots!.getAttribute('aria-pressed')).toBe('true');
  await act(async () => windows!.click());
  expect(windows!.getAttribute('aria-pressed')).toBe('true');
  expect(bots!.getAttribute('aria-pressed')).toBe('false');
});

it('moves the choice with the arrow keys, wrapping around', async () => {
  const container = await render(<Harness />);
  const [bots, windows] = [...container.querySelectorAll('button')];
  bots!.focus();
  await act(async () => bots!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(windows!.getAttribute('aria-pressed')).toBe('true');
  expect(document.activeElement).toBe(windows);
  await act(async () => windows!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(bots!.getAttribute('aria-pressed')).toBe('true');
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
