import { describe, expect, it } from 'vitest';

import { createBoundSessions } from './bound-sessions.js';

interface FakeAgent { id: string }

function sessions(live: Record<string, FakeAgent> = {}) {
  const instance = createBoundSessions<FakeAgent>(agentId => live[agentId]);
  const bind = (agentId: string, nativeSessionId: string, parentNativeSessionId?: string, providerId = 'claude') =>
    instance.bind({ providerId, agentId, nativeSessionId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}) }, { attach: async () => undefined });
  return { instance, bind };
}

describe('bound sessions', () => {
  it('finds a binding by its agent id and by its native identity', async () => {
    const { instance, bind } = sessions();
    const binding = await bind('agent-1', 'native-1');
    expect(instance.byAgent('agent-1')).toBe(binding);
    expect(instance.byNative('claude', 'native-1')).toBe(binding);
    expect(instance.byNative('codex', 'native-1')).toBeUndefined();
    expect(instance.byAgent('agent-2')).toBeUndefined();
  });

  it('reserves the agent id of a bind in progress and marks its native session pending, then keeps only the reservation', async () => {
    const { instance, bind } = sessions();
    const pending = bind('agent-1', 'native-1');
    expect(instance.isPending('claude', 'native-1')).toBe(true);
    expect(instance.isReserved('agent-1')).toBe(true);
    await pending;
    expect(instance.isPending('claude', 'native-1')).toBe(false);
    expect(instance.isReserved('agent-1')).toBe(true);
    expect(instance.isReserved('agent-2')).toBe(false);
  });

  it('refuses a bind after close', async () => {
    const { instance, bind } = sessions();
    instance.close();
    await expect(bind('agent-1', 'native-1')).rejects.toMatchObject({ code: 'host_closed' });
    expect(instance.all()).toEqual([]);
  });

  it('lists bindings in the order they were made, as a snapshot', async () => {
    const { instance, bind } = sessions();
    const a = await bind('agent-1', 'native-1'), b = await bind('agent-2', 'native-2');
    const listed = instance.all();
    expect(listed).toEqual([a, b]);
    listed.length = 0;
    expect(instance.all()).toHaveLength(2);
  });

  it('returns a session\'s family: itself, its children and grandchildren in the order they were bound, of one provider only', async () => {
    const { instance, bind } = sessions();
    const root = await bind('agent-1', 'root');
    const child = await bind('agent-2', 'child', 'root');
    const grandchild = await bind('agent-3', 'grandchild', 'child');
    await bind('agent-4', 'other');
    const foreign = await bind('agent-5', 'child', 'root', 'codex');
    const family = instance.family('claude', 'root');
    expect(family).toEqual([root, child, grandchild]);
    expect(instance.family('claude', 'other')).toHaveLength(1);
    expect(instance.family('codex', 'root')).toEqual([foreign]);
  });

  it('returns the family of a session that is not bound as the children bound under it', async () => {
    const { instance, bind } = sessions();
    const child = await bind('agent-2', 'child', 'missing');
    expect(instance.family('claude', 'missing')).toEqual([child]);
    expect(instance.family('claude', 'nobody')).toEqual([]);
  });

  it('pairs a binding with its runtime and leaves out bindings with none', async () => {
    const running: FakeAgent = { id: 'running' };
    const { instance, bind } = sessions({ 'agent-1': running });
    const first = await bind('agent-1', 'native-1');
    await bind('agent-2', 'native-2');
    expect(instance.live()).toEqual([{ binding: first, agent: running }]);
  });

  it('finds the binding a runtime belongs to', async () => {
    const running: FakeAgent = { id: 'running' };
    const { instance, bind } = sessions({ 'agent-2': running });
    await bind('agent-1', 'native-1');
    const second = await bind('agent-2', 'native-2');
    expect(instance.bindingOf(running)).toBe(second);
  });

  it('throws the invalid_operation_target error for a runtime that has no binding', async () => {
    const { instance, bind } = sessions({ 'agent-1': { id: 'bound' } });
    await bind('agent-1', 'native-1');
    expect(() => instance.bindingOf({ id: 'stranger' })).toThrow('The native session binding is unavailable.');
    try { instance.bindingOf({ id: 'stranger' }); } catch (error) { expect(error).toMatchObject({ code: 'invalid_operation_target' }); }
  });
});
