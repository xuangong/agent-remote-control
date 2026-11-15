import type { AgentProviderAdapter, AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import { createAgentRemoteRelay } from '../relay.js';
import { ResourceIngestor } from './resource-ingestor.js';
import { InMemoryResourceStore } from './resource-store.js';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=', 'base64'));
const otherPng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
const reader = (bytes: Uint8Array) => async () => ({ status: 'available' as const, bytes, mediaType: 'image/png' });

async function settle(ingestor: ResourceIngestor, agentId: string, locator: string, bytes: Uint8Array) {
  const acquisition = ingestor.acquire({ agentId, locator, reader: reader(bytes) });
  expect(acquisition?.binding.status).toBe('pending');
  return { provisional: acquisition!.binding.resourceId, settled: await acquisition!.settled };
}

describe('resource ids with a key', () => {
  it('are the same for the same agent, locator and bytes in another ingestor, as after a restart', async () => {
    const first = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-one' });
    const second = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-one' });
    const a = await settle(first, 'agent-1', 'shot.png', png);
    const b = await settle(second, 'agent-1', 'shot.png', png);
    expect(a.settled).toMatchObject({ locator: 'shot.png', status: 'available' });
    expect(a.settled.resourceId).toBe(b.settled.resourceId);
    expect(a.settled.resourceId).toMatch(/^rid_[A-Za-z0-9_-]{32}$/);
    expect(a.provisional).not.toBe(a.settled.resourceId);
  });

  it('are reused when the same resource settles again in one ingestor', async () => {
    const ingestor = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-one' });
    const a = await settle(ingestor, 'agent-1', 'shot.png', png);
    const b = await settle(ingestor, 'agent-1', 'shot.png', png);
    expect(b.settled.resourceId).toBe(a.settled.resourceId);
    expect(ingestor.readState('agent-1', a.settled.resourceId)).toMatchObject({ status: 'available' });
  });

  it('differ for other bytes, another locator, another agent and another key', async () => {
    const store = new InMemoryResourceStore();
    const ingestor = new ResourceIngestor({ store, resourceIdKey: 'secret-one' });
    const base = (await settle(ingestor, 'agent-1', 'shot.png', png)).settled.resourceId;
    expect((await settle(ingestor, 'agent-1', 'shot.png', otherPng)).settled.resourceId).not.toBe(base);
    expect((await settle(ingestor, 'agent-1', 'other.png', png)).settled.resourceId).not.toBe(base);
    expect((await settle(ingestor, 'agent-2', 'shot.png', png)).settled.resourceId).not.toBe(base);
    const rekeyed = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-two' });
    expect((await settle(rekeyed, 'agent-1', 'shot.png', png)).settled.resourceId).not.toBe(base);
  });

  it('still belong to one agent: another agent cannot read the resource', async () => {
    const ingestor = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-one' });
    const { settled } = await settle(ingestor, 'agent-1', 'shot.png', png);
    expect(ingestor.readState('agent-1', settled.resourceId)).toMatchObject({ status: 'available' });
    expect(ingestor.readState('agent-2', settled.resourceId)).toMatchObject({ status: 'unavailable' });
    expect(ingestor.readResponse('r', 'agent-2', settled.resourceId).payload.state).toMatchObject({ status: 'unavailable' });
  });

  it('keep random ids for a resource that did not settle as available', async () => {
    const ingestor = new ResourceIngestor({ store: new InMemoryResourceStore(), resourceIdKey: 'secret-one' });
    const acquisition = ingestor.acquire({ agentId: 'agent-1', locator: 'gone.png', reader: async () => ({ status: 'unavailable', reason: 'No such file.' }) })!;
    const settled = await acquisition.settled;
    expect(settled).toMatchObject({ status: 'unavailable', resourceId: acquisition.binding.resourceId });
    expect(settled.resourceId).not.toMatch(/^rid_/);
  });
});

describe('resource ids without a key', () => {
  it('are random, as before', async () => {
    const first = new ResourceIngestor({ store: new InMemoryResourceStore() });
    const second = new ResourceIngestor({ store: new InMemoryResourceStore() });
    const a = await settle(first, 'agent-1', 'shot.png', png);
    const b = await settle(second, 'agent-1', 'shot.png', png);
    expect(a.settled.resourceId).toBe(a.provisional);
    expect(a.settled.resourceId).not.toBe(b.settled.resourceId);
  });
});

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 10));

function imageProvider(journal: boolean, items: ProviderStreamItem[] = []): AgentProviderAdapter {
  const session = (): AgentSession => ({
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
    async *observe() {
      yield { type: 'observation', sourceKey: 'history:1', occurredAt: 1_725_000_000_000, delivery: 'history',
        event: { type: 'timeline', provider: 'fake', item: { type: 'assistant_message', text: 'See [shot](shot.png).', messageId: 'm1' } },
        ...(journal ? { itemIdentity: { key: 'm1', completes: true } } : {}) };
      yield { type: 'history_boundary' };
      yield* items;
    },
    async sendMessage() {}, async respondToInteraction() {},
    async readResource() { return { status: 'available', mediaType: 'image/png', bytes: png }; },
    async runtimeInfo() { return { providerId: 'fake', sessionId: 'session-1', status: 'idle', persistence: { providerId: 'fake', sessionId: 'session-1', opaque: 'resume-1' } }; },
    async dispose() {},
  });
  return { descriptor: { providerId: 'fake', displayName: 'Fake' }, ...(journal ? { journal: { itemIdentity: 1 as const } } : {}), createSession: async () => session(), resumeSession: async () => session() };
}

async function imageIdAfterStart(key: string | undefined, agentId: string): Promise<{ resourceId: string; read: string }> {
  const relay = createAgentRemoteRelay({ providers: [imageProvider(false)], ...(key === undefined ? {} : { resourceIdKey: key }) });
  await relay.createAgent({ protocolVersion: '1.8.0', type: 'create_agent', payload: { requestId: 'r', operationId: '00000000-0000-4000-8000-000000000001', agentId, providerId: 'fake', config: { sessionId: 'session-1' } } });
  const manager = relay.requireAgent(agentId);
  await flush();
  const page = manager.fetchTimeline({ requestId: 'h', agentId, direction: 'tail', limit: 10 });
  const resource = page.payload.entries[0]?.resources?.[0];
  const response = await manager.readResource('read', resource!.resourceId);
  await relay.close();
  return { resourceId: resource!.resourceId, read: response.payload.state.status };
}

describe('resource ids across a Controller restart', () => {
  it('give the image of a restored session the id it had, and the new Controller can read it', async () => {
    const before = await imageIdAfterStart('secret-one', 'agent-1');
    const after = await imageIdAfterStart('secret-one', 'agent-1');
    expect(before.resourceId).toMatch(/^rid_/);
    expect(after).toEqual(before);
    expect(after.read).toBe('available');
  });

  it('give another id under another secret or for another agent, and a random one without a secret', async () => {
    const base = await imageIdAfterStart('secret-one', 'agent-1');
    expect((await imageIdAfterStart('secret-two', 'agent-1')).resourceId).not.toBe(base.resourceId);
    expect((await imageIdAfterStart('secret-one', 'agent-2')).resourceId).not.toBe(base.resourceId);
    const first = await imageIdAfterStart(undefined, 'agent-1');
    expect(first.resourceId).not.toMatch(/^rid_/);
    expect((await imageIdAfterStart(undefined, 'agent-1')).resourceId).not.toBe(first.resourceId);
  });

  it('does not let one agent of a relay read the image of another, even though both know its id', async () => {
    const relay = createAgentRemoteRelay({ providers: [imageProvider(false)], resourceIdKey: 'secret-one' });
    const create = (agentId: string, n: number) => relay.createAgent({ protocolVersion: '1.8.0', type: 'create_agent', payload: { requestId: agentId, operationId: `00000000-0000-4000-8000-00000000000${n}`, agentId, providerId: 'fake', config: { sessionId: 'session-1' } } });
    await create('agent-1', 1);
    await create('agent-2', 2);
    await flush();
    const id = relay.requireAgent('agent-1').fetchTimeline({ requestId: 'h', agentId: 'agent-1', direction: 'tail', limit: 10 }).payload.entries[0]?.resources?.[0]?.resourceId;
    expect((await relay.requireAgent('agent-1').readResource('a', id!)).payload.state.status).toBe('available');
    expect((await relay.requireAgent('agent-2').readResource('b', id!)).payload.state.status).toBe('unavailable');
    await relay.close();
  });
});

describe('the journal contract of a provider that a relay owns', () => {
  it('reaches the agent manager, so a session that omits item identity is told to its taps', async () => {
    const relay = createAgentRemoteRelay({ providers: [imageProvider(true, [{ type: 'observation', sourceKey: 'stream:2', occurredAt: 1_725_000_000_001, delivery: 'live',
      event: { type: 'timeline', provider: 'fake', item: { type: 'assistant_message', text: 'No identity', messageId: 'm2' } } }])] });
    await relay.createAgent({ protocolVersion: '1.8.0', type: 'create_agent', payload: { requestId: 'r', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'agent-1', providerId: 'fake', config: { sessionId: 'session-1' } } });
    let told = 0;
    relay.requireAgent('agent-1').subscribeJournal({ event: () => undefined, closed: () => undefined, identityMissing: () => { told += 1; } });
    await flush();
    expect(told).toBe(1);
    await relay.close();
  });
});
