// @vitest-environment jsdom
import { act, useState } from 'react';
import { expect, it } from 'vitest';
import type { ProcessMode } from '@orchardworks/agent-client';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { render } from '../test/setup.js';
import { SessionViewOptions } from './SessionViewOptions.js';

function Options({ assistant = true }: { assistant?: boolean }) {
  const [own, setOwn] = useState<ProcessMode>('full');
  return <SessionViewOptions process={{ mode: own, device: 'concise', chooseForDevice: () => {}, ...(assistant ? { chooseForAssistant: setOwn } : {}) }} />;
}
const open = async (container: HTMLElement, label = 'Session view options') => act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
const group = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`[role="group"][aria-label="${name}"]`);
const pressed = (container: HTMLElement, name: string) => [...group(container, name)!.querySelectorAll('button')].find(button => button.getAttribute('aria-pressed') === 'true')?.textContent;

it('offers Concise, Process and Full for this assistant, and nothing for the device or letters, which Settings holds', async () => {
  const container = await render(<Options />);
  await open(container);
  expect([...group(container, 'This assistant')!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Concise', 'Process', 'Full']);
  expect(pressed(container, 'This assistant')).toBe('Full');
  await act(async () => [...group(container, 'This assistant')!.querySelectorAll('button')][1]!.click());
  expect(pressed(container, 'This assistant')).toBe('Process');
  expect(group(container, 'All assistants on this device')).toBeNull();
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
});

it('offers nothing for a view that is no assistant', async () => {
  const container = await render(<Options assistant={false} />);
  expect(container.querySelector('[aria-label="Session view options"]')).toBeNull();
});

it('speaks Chinese for a Chinese browser', async () => {
  const container = await render(<LocaleContext.Provider value="zh"><Options /></LocaleContext.Provider>);
  await open(container, '会话视图选项');
  expect([...group(container, '这个助手')!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['简洁', '过程', '完整']);
});

const panel = (container: HTMLElement) => container.querySelector('.lab-session-view-options-panel');
const trigger = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('[aria-label="Session view options"]')!;

it('applies a choice at once and keeps the panel open for the next one', async () => {
  const container = await render(<Options />);
  await open(container);
  await act(async () => [...group(container, 'This assistant')!.querySelectorAll('button')][0]!.click());
  expect(pressed(container, 'This assistant')).toBe('Concise');
  expect(panel(container)).not.toBeNull();
  expect(trigger(container).getAttribute('aria-expanded')).toBe('true');
});

it('closes on Escape and returns focus to its trigger', async () => {
  const container = await render(<Options />);
  await open(container);
  const first = group(container, 'This assistant')!.querySelector('button')!;
  first.focus();
  await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(panel(container)).toBeNull();
  expect(document.activeElement).toBe(trigger(container));
});

it('closes when focus leaves it for another control, and when a pointer presses outside it', async () => {
  const container = await render(<><Options /><button type="button" id="elsewhere">Elsewhere</button></>);
  await open(container);
  const first = group(container, 'This assistant')!.querySelector('button')!;
  first.focus();
  await act(async () => { container.querySelector<HTMLElement>('#elsewhere')!.focus(); });
  expect(panel(container)).toBeNull();
  await open(container);
  expect(panel(container)).not.toBeNull();
  await act(async () => { container.querySelector('#elsewhere')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  expect(panel(container)).toBeNull();
});
