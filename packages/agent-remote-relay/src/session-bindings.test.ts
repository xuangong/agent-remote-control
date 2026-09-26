import { expect, it } from 'vitest';
import { SessionBindings } from './session-bindings.js';

const target = { providerId: 'provider', nativeSessionId: 'native', agentId: 'public' };
it('reserves both identities before native attachment and joins compatible callers', async () => {
  const registry = new SessionBindings();
  let resume!: () => void;
  let opens = 0;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const first = registry.bind(target, { attach: async () => { opens++; await gate; } });
  const second = registry.bind({ ...target, agentId: 'alias' }, { attach: async () => { opens++; } });
  await expect(registry.bind({ ...target, parentNativeSessionId: 'other' }, { attach: async () => {} })).rejects.toMatchObject({ code: 'session_binding_conflict' });
  await expect(registry.bind({ ...target, nativeSessionId: 'other' }, { attach: async () => {} })).rejects.toMatchObject({ code: 'session_binding_conflict' });
  expect(registry.isReserved('public')).toBe(true);
  resume();
  expect(await second).toEqual(await first);
  expect(opens).toBe(1);
  expect(registry.getByAgent('alias')).toBeUndefined();
});
it('releases failed reservations but preserves a published identity across restore failure', async () => {
  const registry = new SessionBindings();
  await expect(registry.bind(target, { attach: async () => { throw new Error('open failed'); } })).rejects.toThrow('open failed');
  expect(registry.isReserved('public')).toBe(false);
  expect(registry.getByNative('provider', 'native')).toBeUndefined();
  const binding = await registry.bind(target, { attach: async () => {} });
  await expect(registry.bind({ ...target, agentId: 'new' }, { attach: async () => { throw new Error('restore failed'); } })).rejects.toThrow('restore failed');
  expect(registry.getByAgent('public')).toBe(binding);
});
it('rejects noncanonical aliases and parent changes without invoking native attachment', async () => {
  const registry = new SessionBindings();
  await registry.bind(target, { attach: async () => {} });
  let opens = 0;
  for (const request of [{ ...target, agentId: 'alias' }, { ...target, parentNativeSessionId: 'new' }]) {
    await expect(registry.bind(request, { canonical: false, attach: async () => { opens++; } })).rejects.toMatchObject({ code: 'session_binding_conflict' });
  }
  expect(opens).toBe(0);
});
it('discards an attachment that finishes after shutdown without publishing it', async () => {
  const registry = new SessionBindings();
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let discarded = 0;
  const attaching = registry.bind(target, { attach: () => gate, discard: async () => { discarded++; } });
  await Promise.resolve();
  registry.close(); resume();
  await expect(attaching).rejects.toMatchObject({ code: 'host_closed' });
  expect(discarded).toBe(1);
  expect(registry.getByAgent('public')).toBeUndefined();
});
it('does not start native attachment after shutdown wins the reservation race', async () => {
  const registry = new SessionBindings();
  let opens = 0;
  const pending = registry.bind(target, { attach: async () => { opens++; } });
  registry.close();
  await expect(pending).rejects.toMatchObject({ code: 'host_closed' });
  expect(opens).toBe(0);
});
