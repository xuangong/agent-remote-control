import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { clearConversationRecovery } from '../conversation-recovery.js';
import { readWorkspaceSnapshot } from '../workspace-cache.js';
import { useWorkspaceDisplayCache } from './useWorkspaceDisplayCache.js';

const scope = 'display-cache';
const target = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id });
const snapshot = (id: string) => ({ ...replicaState, agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: id } } });
afterEach(() => { vi.useRealTimers(); clearConversationRecovery(scope); });
it('retains the previous session on rebind and flushes the current session on pagehide', async () => {
  vi.useFakeTimers();
  let change: (id: string) => void = () => {};
  function Harness() {
    const [id, setId] = useState('first'); change = setId;
    useWorkspaceDisplayCache(scope, target(id), snapshot(id), true); return null;
  }
  const mounted = await render(<Harness />);
  expect(readWorkspaceSnapshot(scope, target('first'))).toBeUndefined();
  await act(async () => change('second'));
  expect(readWorkspaceSnapshot(scope, target('first'))?.agent?.runtimeInfo.sessionId).toBe('first');
  window.dispatchEvent(new Event('pagehide'));
  expect(readWorkspaceSnapshot(scope, target('second'))?.agent?.runtimeInfo.sessionId).toBe('second');
  await unmount(mounted);
});
it('does not write cached state back after recovery data was cleared', async () => {
  vi.useFakeTimers();
  function Harness() { useWorkspaceDisplayCache(scope, target('first'), snapshot('first'), true); return null; }
  const mounted = await render(<Harness />);
  clearConversationRecovery(scope);
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  await unmount(mounted);
  expect(readWorkspaceSnapshot(scope, target('first'))).toBeUndefined();
});
