// @vitest-environment jsdom
import { act, useState } from 'react';
import { expect, it } from 'vitest';
import type { ProcessMode } from '@orchardworks/agent-client';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { render } from '../test/setup.js';
import { SessionViewOptions } from './SessionViewOptions.js';

function Options({ assistant = true }: { assistant?: boolean }) {
  const [own, setOwn] = useState<ProcessMode>('full');
  const [device, setDevice] = useState<ProcessMode>('concise');
  const [letters, setLetters] = useState(true);
  return <SessionViewOptions process={{ mode: own, device, chooseForDevice: setDevice, ...(assistant ? { chooseForAssistant: setOwn } : {}) }}
    lettersVisible={letters} onLettersVisibleChange={setLetters} />;
}
const open = async (container: HTMLElement) => act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Session view options"]')!.click());
const group = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`[role="group"][aria-label="${name}"]`);
const pressed = (container: HTMLElement, name: string) => [...group(container, name)!.querySelectorAll('button')].find(button => button.getAttribute('aria-pressed') === 'true')?.textContent;

it('offers Concise, Process and Full for this assistant and for the device, and shows each choice', async () => {
  const container = await render(<Options />);
  await open(container);
  expect([...group(container, 'This assistant')!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Concise', 'Process', 'Full']);
  expect(pressed(container, 'This assistant')).toBe('Full');
  expect(pressed(container, 'All assistants on this device')).toBe('Concise');
  await act(async () => [...group(container, 'All assistants on this device')!.querySelectorAll('button')][1]!.click());
  expect(pressed(container, 'All assistants on this device')).toBe('Process');
  expect(container.querySelector('input[type="radio"]')).toBeNull();
  const letters = container.querySelector<HTMLInputElement>('input[aria-label="Show letters"]')!;
  await act(async () => letters.click());
  expect(letters.checked).toBe(false);
});

it('offers only the device default for a view that is no assistant', async () => {
  const container = await render(<Options assistant={false} />);
  await open(container);
  expect(group(container, 'This assistant')).toBeNull();
  expect(group(container, 'All assistants on this device')).not.toBeNull();
});

it('speaks Chinese for a Chinese browser', async () => {
  const container = await render(<LocaleContext.Provider value="zh"><Options /></LocaleContext.Provider>);
  await open(container);
  expect([...group(container, '这个助手')!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['简洁', '过程', '完整']);
  expect(group(container, '这台设备上的所有助手')).not.toBeNull();
});
