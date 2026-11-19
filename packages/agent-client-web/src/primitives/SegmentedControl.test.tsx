// @vitest-environment jsdom
import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SegmentedControl } from './SegmentedControl.js';

function Harness() {
  const [value, setValue] = useState<'bots' | 'windows'>('bots');
  return <SegmentedControl label="Mode" value={value} onChange={setValue} options={[{ value: 'bots', label: 'Bots' }, { value: 'windows', label: 'Windows' }]} />;
}

it('marks the chosen segment and changes on click', async () => {
  const container = await render(<Harness />);
  const [bots, windows] = [...container.querySelectorAll('button')];
  expect(container.querySelector('nav')).toBeNull();
  expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Mode');
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
