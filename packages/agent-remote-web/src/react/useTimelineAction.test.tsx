import { expect, it, vi } from 'vitest';
import { render, rerender, unmount } from '../test/setup.js';
import { useTimelineAction } from './useTimelineAction.js';

it('uses current actions and rejects callbacks retained after a scope change, removal, or unmount', async () => {
  let action: (() => string) | undefined;
  function Controls({ scope, callback }: { scope: string; callback?: () => string }) {
    action = useTimelineAction(scope, callback);
    return null;
  }
  const first = vi.fn(() => 'first');
  const second = vi.fn(() => 'second');
  const container = await render(<Controls scope="one" callback={first} />);
  const retained = action!;
  await rerender(container, <Controls scope="one" callback={second} />);
  expect(action).toBe(retained);
  expect(retained()).toBe('second');
  expect(first).not.toHaveBeenCalled();
  await rerender(container, <Controls scope="two" callback={first} />);
  expect(retained).toThrow('no longer available');
  expect(action!()).toBe('first');
  const removed = action!;
  await rerender(container, <Controls scope="two" />);
  expect(action).toBeUndefined();
  expect(removed).toThrow('no longer available');
  await rerender(container, <Controls scope="two" callback={second} />);
  const unmounted = action!;
  await unmount(container);
  expect(unmounted).toThrow('no longer available');
});
