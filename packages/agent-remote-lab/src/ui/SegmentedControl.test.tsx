import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
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

it('moves only the focus with the arrow keys under manual activation, and chooses on click', async () => {
  const onChange = vi.fn();
  function Manual() {
    const [value, setValue] = useState<'bots' | 'windows'>('bots');
    return <SegmentedControl label="Mode" activation="manual" value={value} onChange={next => { onChange(next); setValue(next); }}
      options={[{ value: 'bots', label: 'Bots' }, { value: 'windows', label: 'Windows' }]} />;
  }
  const container = await render(<Manual />);
  const [bots, windows] = [...container.querySelectorAll('button')];
  const stops = () => [bots!.tabIndex, windows!.tabIndex];
  expect(stops(), 'the chosen segment holds the Tab stop').toEqual([0, -1]);
  bots!.focus();
  await act(async () => bots!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(document.activeElement).toBe(windows);
  expect(bots!.getAttribute('aria-pressed')).toBe('true');
  expect(stops(), 'the focused segment holds the Tab stop').toEqual([-1, 0]);
  await act(async () => windows!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(document.activeElement).toBe(bots);
  await act(async () => bots!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  expect(document.activeElement).toBe(windows);
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => windows!.blur());
  expect(stops(), 'leaving returns the Tab stop to the chosen segment').toEqual([0, -1]);
  await act(async () => windows!.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith('windows');
  expect(windows!.getAttribute('aria-pressed')).toBe('true');
  expect(bots!.getAttribute('aria-pressed')).toBe('false');
});

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
