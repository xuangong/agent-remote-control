import { describe, expect, it, vi } from 'vitest';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { useReplicaRetention } from './useReplicaRetention.js';

function scopeOf(facts: Record<string, unknown> = {}) {
  return mockScope<typeof useReplicaRetention>({
    addressSession: undefined, connections: { agentIds: ['conn-1'] }, primaryBinding: { current: undefined }, replicas: { retain: vi.fn() }, sideSessions: [], askActivitySessions: [], ...facts,
  });
}

describe('the replicas the page keeps', () => {
  it('are the connections of the page', async () => {
    const scope = scopeOf();
    await renderHook(() => useReplicaRetention(scope));
    expect((scope.replicas as unknown as { retain: ReturnType<typeof vi.fn> }).retain).toHaveBeenCalledWith(['conn-1']);
  });
  it('add the primary binding, the Sides, the visible Asks and the address session', async () => {
    const scope = scopeOf({
      primaryBinding: { current: { agentId: 'primary' } }, sideSessions: [buildOpened('s1'), buildOpened('s2')], addressSession: buildOpened('addr'),
      askActivitySessions: [{ session: { agentId: 'ask-shown' }, visible: true }, { session: { agentId: 'ask-hidden' }, visible: false }],
    });
    await renderHook(() => useReplicaRetention(scope));
    expect((scope.replicas as unknown as { retain: ReturnType<typeof vi.fn> }).retain).toHaveBeenCalledWith(['conn-1', 'primary', 'agent-s1', 'agent-s2', 'ask-shown', 'agent-addr']);
  });
  it('are kept again on every render', async () => {
    const scope = scopeOf();
    const { rerender } = await renderHook(() => useReplicaRetention(scope));
    await rerender();
    expect((scope.replicas as unknown as { retain: ReturnType<typeof vi.fn> }).retain).toHaveBeenCalledTimes(2);
  });
});
