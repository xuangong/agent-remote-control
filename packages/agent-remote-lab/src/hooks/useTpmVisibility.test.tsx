import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { TpmViewScope, useTpmVisibility } from './useTpmVisibility.js';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
function Harness() {
  const view = useTpmVisibility();
  const [error, setError] = useState('');
  return <TpmViewScope.Provider value={view.execute}>
    <div data-testid="tpm" hidden={!view.visible}>TPM</div>{view.controls}
    <input aria-label="Arguments" /><button onClick={() => void view.execute(document.querySelector<HTMLInputElement>('[aria-label="Arguments"]')!.value).catch(value => setError(value.message))}>Execute</button>{error}
  </TpmViewScope.Provider>;
}
async function command(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Arguments"]')!;
  await act(async () => {
    input.value = value.replace('/tpm', '').trim();
  });
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
}
it.each([false, true])('defaults to coarse pointer=%s and preserves an explicit choice independently from Track', async coarse => {
  vi.stubGlobal('matchMedia', () => ({ matches: coarse, addEventListener() {}, removeEventListener() {} }));
  localStorage.setItem('agent-remote:track-view', String(!coarse));
  let container = await render(<Harness />);
  const visible = () => !container.querySelector<HTMLElement>('[data-testid="tpm"]')!.hidden;
  expect(visible()).toBe(coarse);
  await command(container, '/tpm');
  expect(visible()).toBe(!coarse);
  for (const arg of ['on', 'enable']) { await command(container, `/tpm ${arg}`); expect(visible()).toBe(true); }
  await command(container, '/tpm invalid');
  expect(visible()).toBe(true);
  expect(container.textContent).toContain('Use /tpm');
  for (const arg of ['off', 'disable']) { await command(container, `/tpm ${arg}`); expect(visible()).toBe(false); }
  expect(localStorage.getItem('agent-remote:track-view')).toBe(String(!coarse));
  await unmount(container);
  container = await render(<Harness />);
  expect(visible()).toBe(false);
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="TPM view"]')!.click());
  expect(visible()).toBe(true);
});
