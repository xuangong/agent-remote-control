import { act, useState } from 'react';
import { expect, it } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { useWindowConnections } from './useWindowConnections.js';

it('defaults to all connected and persists only explicit view choices within the current user scope', async () => {
  let preferences!: ReturnType<typeof useWindowConnections>, changeScope!: (scope: string) => void;
  function Harness() {
    const [scope, setScope] = useState('connection-user-a'); changeScope = setScope;
    preferences = useWindowConnections(scope);
    return null;
  }
  let view = await render(<Harness />);
  expect(preferences.enabled('window', 'one')).toBe(true);
  await act(async () => preferences.setEnabled('window', 'one', false));
  expect(preferences.enabled('window', 'one')).toBe(false);
  expect(preferences.enabled('window', 'two')).toBe(true);
  expect(preferences.enabled('another-window', 'one')).toBe(true);
  await unmount(view); view = await render(<Harness />);
  expect(preferences.enabled('window', 'one')).toBe(false);
  await act(async () => changeScope('connection-user-b'));
  expect(preferences.enabled('window', 'one')).toBe(true);
  await act(async () => changeScope('connection-user-a'));
  expect(preferences.enabled('window', 'one')).toBe(false);
  await act(async () => preferences.setEnabled('window', 'one', true));
  await unmount(view); await render(<Harness />);
  expect(preferences.enabled('window', 'one')).toBe(true);
});
