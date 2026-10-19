import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionHeadingActions } from './SessionHeadingActions.js';

it('keeps explicit overflow actions collapsed until opened and restores focus on Escape', async () => {
  const action = vi.fn();
  const container = await render(<><button>Outside</button><SessionHeadingActions alwaysCollapsed>
    <button type="button" onClick={action}>Change session</button>
  </SessionHeadingActions></>);
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="More session actions"]')!;
  const panel = container.querySelector<HTMLDivElement>('.lab-session-heading-actions-panel')!;
  expect(panel.hidden).toBe(true);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  await act(async () => trigger.click());
  expect(panel.hidden).toBe(false);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  await act(async () => panel.querySelector('button')!.click());
  expect(action).toHaveBeenCalledOnce();
  await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(panel.hidden).toBe(true);
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  await act(async () => container.querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(panel.hidden).toBe(true);
});

it('closes an explicit overflow menu when its session changes', async () => {
  let change!: (key: string) => void;
  function Harness() {
    const [key, setKey] = useState('first'); change = setKey;
    return <SessionHeadingActions sessionKey={key} alwaysCollapsed><button>{key} actions</button></SessionHeadingActions>;
  }
  const container = await render(<Harness />);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More session actions"]')!.click());
  expect(container.querySelector<HTMLDivElement>('.lab-session-heading-actions-panel')!.hidden).toBe(false);
  await act(async () => change('second'));
  expect(container.querySelector<HTMLDivElement>('.lab-session-heading-actions-panel')!.hidden).toBe(true);
  expect(container.textContent).toContain('second actions');
});
