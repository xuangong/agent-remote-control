import { expect, test } from 'vitest';
import { resolveAgentNativePrefixCapability, type AgentNativePrefixCapability, type AgentPersistenceHandle, type AgentSession } from '@orchardworks/agent-provider-sdk';
import { ownAdapter } from './owned-adapter.js';

const target = { nativeSessionId: 'source', turnId: 'turn', messageId: 'message' };
function fixture() {
  let disposals = 0, closed = 0;
  const handle = { providerId: 'fixture', sessionId: 'candidate', opaque: 'original' };
  const session: AgentSession = {
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } },
    async *observe() { yield { type: 'history_boundary' }; }, async sendMessage() {}, async respondToInteraction() {},
    async runtimeInfo() { return { providerId: 'fixture', sessionId: 'candidate', status: 'idle', persistence: handle }; },
    async dispose() { disposals++; },
  };
  class Capability implements AgentNativePrefixCapability {
    get createdSessionIdMaxLength() { return 36; }
    async validate() { expect(this).toBe(capability); }
    async create(_target: unknown, _extensions: unknown, checkpoint: (handle: AgentPersistenceHandle) => Promise<void>) {
      expect(this).toBe(capability); await checkpoint(handle); return session;
    }
    async verify() { expect(this).toBe(capability); }
  }
  const capability = new Capability();
  const adapter = { nativePrefix: capability, descriptor: { providerId: 'fixture', displayName: 'Fixture' },
    async createSession() { return session; }, async resumeSession() { return session; }, async dispose() { closed++; } };
  return { adapter, handle, disposals: () => disposals, closed: () => closed };
}

test('owns capability-created sessions, preserves receivers and disposes exactly once', async () => {
  const f = fixture(), owned = ownAdapter(f.adapter), capability = owned.adapter.nativePrefix!;
  await capability.validate(target);
  const session = await capability.create(target, {}, async handle => { expect(handle).toBe(f.handle); });
  await capability.verify(target, f.handle);
  await session.dispose(); await Promise.all([session.dispose(), owned.close(), owned.close()]);
  expect(f.disposals()).toBe(1); expect(f.closed()).toBe(1);
});

test('disposes a capability-created session when close wins during a held checkpoint', async () => {
  const f = fixture(), owned = ownAdapter(f.adapter);
  let release!: () => void, reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const pending = owned.adapter.nativePrefix!.create(target, {}, async handle => { expect(handle).toBe(f.handle); reached(); await gate; });
  const rejected = expect(pending).rejects.toThrow('stopped during provider startup');
  await entered; await owned.close(); expect(f.disposals()).toBe(0);
  release(); await rejected; await owned.close();
  expect(f.disposals()).toBe(1); expect(f.closed()).toBe(1);
});

test.each(['validate', 'create', 'verify', 'createdSessionIdMaxLength'])('does not manufacture complete support from malformed %s', async key => {
  const f = fixture(); Object.defineProperty(f.adapter.nativePrefix, key, { value: undefined });
  const owned = ownAdapter(f.adapter);
  expect(resolveAgentNativePrefixCapability(owned.adapter)).toBeUndefined();
  const session = await owned.adapter.createSession({ sessionId: 'ordinary' }); await session.sendMessage('hello');
  await owned.close(); expect(f.disposals()).toBe(1);
});
