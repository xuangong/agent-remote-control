import { act, useContext, useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { AskViewScope, useAskVisibility } from './useAskVisibility.js';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); vi.unstubAllGlobals(); });

function CommandInput() {
  const execute = useContext(AskViewScope)!;
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');
  return <>
    <input aria-label="Arguments" ref={input} />
    <button onClick={() => void execute(input.current!.value).then(result => setMessage(result.text ?? '')).catch(error => setMessage(error.message))}>Execute</button>
    <output>{message}</output>
  </>;
}

function Harness() {
  const view = useAskVisibility();
  return <AskViewScope.Provider value={view.execute}>
    <div data-testid="ask" hidden={!view.visible}>Ask</div>
    {view.controls}<CommandInput />
  </AskViewScope.Provider>;
}

function visible(container: HTMLElement): boolean {
  return !container.querySelector<HTMLElement>('[data-testid="ask"]')!.hidden;
}

async function command(container: HTMLElement, args: string) {
  container.querySelector<HTMLInputElement>('[aria-label="Arguments"]')!.value = args;
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
}

it.each([false, true])('keeps Ask hidden by default for coarse pointer=%s independently from other views', async coarse => {
  vi.stubGlobal('matchMedia', () => ({ matches: coarse, addEventListener() {}, removeEventListener() {} }));
  localStorage.setItem('agent-remote:track-view', 'true');
  localStorage.setItem('agent-remote:tpm-view', 'true');
  const container = await render(<Harness />);
  expect(visible(container)).toBe(false);
  await command(container, '');
  expect(visible(container)).toBe(true);
  await command(container, '');
  expect(visible(container)).toBe(false);
  expect(localStorage.getItem('agent-remote:track-view')).toBe('true');
  expect(localStorage.getItem('agent-remote:tpm-view')).toBe('true');
}, 10000);

it('handles visibility aliases through the global scope and rejects source-bound question text', async () => {
  const container = await render(<Harness />);
  for (const [args, expected] of [[' ON ', true], ['off', false], ['enable', true], [' DISABLE ', false]] as const) {
    await command(container, args);
    expect(visible(container)).toBe(expected);
    expect(localStorage.getItem('agent-remote:ask-view')).toBe(String(expected));
  }
  await command(container, 'on');
  await command(container, 'explain this conversation');
  expect(visible(container)).toBe(true);
  expect(localStorage.getItem('agent-remote:ask-view')).toBe('true');
  expect(container.querySelector('output')!.textContent).toContain('Use /ask');
}, 10000);

it('persists the settings control choice across remounts', async () => {
  let container = await render(<Harness />);
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Ask view"]')!.click());
  expect(visible(container)).toBe(true);
  expect(localStorage.getItem('agent-remote:ask-view')).toBe('true');
  await unmount(container);
  container = await render(<Harness />);
  expect(visible(container)).toBe(true);
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Ask view"]')!.click());
  await unmount(container);
  container = await render(<Harness />);
  expect(visible(container)).toBe(false);
}, 10000);

it.each(['storage', 'focus'])('refreshes the global preference on %s and resets a cleared choice to hidden', async event => {
  const container = await render(<Harness />);
  await act(async () => {
    localStorage.setItem('agent-remote:ask-view', 'true');
    window.dispatchEvent(new Event(event));
  });
  expect(visible(container)).toBe(true);
  await act(async () => {
    localStorage.removeItem('agent-remote:ask-view');
    window.dispatchEvent(new Event(event));
  });
  expect(visible(container)).toBe(false);
}, 10000);

it('keeps the page preference usable when browser storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  const container = await render(<Harness />);
  expect(visible(container)).toBe(false);
  await command(container, 'on');
  expect(visible(container)).toBe(true);
  await command(container, 'off');
  expect(visible(container)).toBe(false);
}, 10000);
