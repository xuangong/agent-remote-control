import { act, useState } from 'react';
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { SessionAskHome, SessionAskSurface, SessionAskSurfaceProvider } from './SessionAskSurface.js';
import { SessionDockProvider, SessionDockRail, SessionViewPlacement } from './SessionDock.js';

it('keeps a docked session mounted when the source pane changes and returns its floating home later', async () => {
  let navigate!: (value: string) => void;
  function Harness() {
    const [source, setSource] = useState('one'); navigate = setSource;
    return <SessionAskSurfaceProvider><SessionDockProvider enabled>
      <SessionAskSurface id="one"><SessionViewPlacement id="ask" title="Ask" visible>{({ controls }) => <>{controls}<input defaultValue="Retained draft" /></>}</SessionViewPlacement></SessionAskSurface>
      <SessionDockRail><section data-source={source}><SessionAskHome key={source} id={source} /></section></SessionDockRail>
    </SessionDockProvider></SessionAskSurfaceProvider>;
  }
  const view = await render(<Harness />);
  const input = view.querySelector('input')!;
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Dock Ask"]')!.click());
  await act(async () => navigate('two'));
  expect(view.querySelector('[data-dock-id="ask"] input')).toBe(input);
  expect(input.value).toBe('Retained draft');
  await act(async () => navigate('one'));
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Float Ask"]')!.click());
  expect(view.querySelector('[data-source="one"] input')).toBe(input);
});
