import { act, useState } from 'react';
import { render } from './setup.js';

export interface RenderedHook<T> { readonly result: { current: T }; rerender(): Promise<void> }

/** Mounts one hook on a probe component. `rerender` renders again, so a hook that reads a changed mock runs its effects again. */
export async function renderHook<T>(hook: () => T): Promise<RenderedHook<T>> {
  const result = { current: undefined as T };
  let bump: () => void = () => {};
  function Probe() {
    const [, set] = useState(0);
    bump = () => set(count => count + 1);
    result.current = hook();
    return null;
  }
  await render(<Probe />);
  return { result, rerender: () => act(async () => bump()) };
}

/** The scope a hook of `src/app` reads, built from the few facts a test sets. Everything else stays unset, so a read of it fails the test. */
export function mockScope<Hook extends (scope: never, ...rest: never[]) => unknown>(facts: object): Parameters<Hook>[0] {
  return facts as Parameters<Hook>[0];
}

export const lateScope = (): never => ({}) as never;

/** A session of a Window view, as the stack and the open-Window lists hold it. */
export function buildOpened(id: string, overrides: Record<string, unknown> = {}) {
  return { agentId: `agent-${id}`, providerId: 'codex', nativeSessionId: id, title: id, hostId: 'local', viewId: `view-${id}`, ...overrides };
}
