import { act, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { TeamViewScope, useTeamVisibility } from './useTeamVisibility.js';

afterEach(() => { localStorage.clear(); });
function Harness() {
  const view = useTeamVisibility();
  const [error, setError] = useState('');
  return <TeamViewScope.Provider value={view.execute}>
    <div data-testid="team" hidden={!view.visible}>Team</div>{view.controls}
    <input aria-label="Arguments" /><button onClick={() => void view.execute(document.querySelector<HTMLInputElement>('[aria-label="Arguments"]')!.value).catch(value => setError(value.message))}>Execute</button>{error}
  </TeamViewScope.Provider>;
}
async function command(container: HTMLElement, args: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Arguments"]')!;
  await act(async () => { input.value = args; });
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
}
const visible = (container: HTMLElement) => !container.querySelector<HTMLElement>('[data-testid="team"]')!.hidden;

it('shows the Team view by default and lets /team and the View switch change one retained preference', async () => {
  let container = await render(<Harness />);
  expect(visible(container)).toBe(true);
  await command(container, 'off'); expect(visible(container)).toBe(false);
  expect(container.querySelector<HTMLInputElement>('[aria-label="Team view"]')!.checked).toBe(false);
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Team view"]')!.click());
  expect(visible(container)).toBe(true);
  // A bare /team toggles; the aliases set.
  await command(container, ''); expect(visible(container)).toBe(false);
  await command(container, 'enable'); expect(visible(container)).toBe(true);
  await command(container, 'disable'); expect(visible(container)).toBe(false);
  await command(container, 'on'); expect(visible(container)).toBe(true);
  await command(container, 'off');
  await unmount(container);
  container = await render(<Harness />);
  expect(visible(container)).toBe(false);
  expect(container.querySelector<HTMLInputElement>('[aria-label="Team view"]')!.checked).toBe(false);
  await unmount(container);
});

it('refuses an unknown argument and keeps the choice', async () => {
  const container = await render(<Harness />);
  await command(container, 'sideways');
  expect(visible(container)).toBe(true);
  expect(container.textContent).toContain('Use /team');
  expect(localStorage.getItem('agent-remote:team-view')).toBeNull();
  await unmount(container);
});

it('keeps the preference usable when browser storage is unavailable', async () => {
  const container = await render(<Harness />);
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = () => { throw new Error('storage denied'); };
  try { await command(container, 'off'); expect(visible(container)).toBe(false); }
  finally { Storage.prototype.setItem = set; await unmount(container); }
});
