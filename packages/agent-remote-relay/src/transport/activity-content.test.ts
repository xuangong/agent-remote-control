import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AgentSession, ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AgentManager } from '../agent-manager.js';
import { createOperationCache } from '../operation-cache.js';
import { createOperationExecutor } from '../operation-settlement.js';
import type { AgentRemoteRelay } from '../relay.js';
import { attachAgentRemoteWebSocketStream } from './websocket-stream.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const row = (sourceKey: string, text: string, delivery: 'history' | 'live' = 'live'): ProviderObservation => ({
  type: 'observation', sourceKey, nativeRevision: 1, occurredAt: 1, delivery,
  event: { type: 'timeline', provider: 'fake', item: { type: 'assistant_message', messageId: sourceKey, text } },
});

async function fixture() {
  const pending: Array<ProviderStreamItem | undefined> = [];
  let waiting: ((value: ProviderStreamItem | undefined) => void) | undefined;
  const push = (value: ProviderStreamItem | undefined) => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(value); }
    else pending.push(value);
  };
  const session: AgentSession = {
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
      interactions: { question: false, planApproval: false, toolApproval: false } },
    runtimeInfo: async () => ({ providerId: 'fake', sessionId: 'native', status: 'idle' }),
    async *observe() {
      yield row('initial', 'Already read', 'history');
      yield { type: 'history_boundary', olderCursor: 'older' };
      while (true) {
        const value = pending.length ? pending.shift() : await new Promise<ProviderStreamItem | undefined>(resolve => { waiting = resolve; });
        if (!value) return;
        yield value;
      }
    },
    readTimelineHistory: async () => ({ observations: [row('older', 'Older history', 'history')] }),
    sendMessage: async () => {}, respondToInteraction: async () => {}, dispose: async () => { push(undefined); },
  };
  const manager = await AgentManager.attach({ agentId: 'tracked', epoch: 'original', provider: { providerId: 'fake', displayName: 'Fake' }, session });
  await manager.ready;
  cleanup.push(() => manager.close());
  const operations = createOperationCache();
  cleanup.push(() => operations.close());
  const server = createServer();
  const stream = attachAgentRemoteWebSocketStream(server, { requireAgent: () => manager,
    executeOperation: (scope: string) => createOperationExecutor(operations, scope) } as unknown as AgentRemoteRelay, {
    authorizer: { authenticate: () => ({ subject: 'test' }), authorize: () => true },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  cleanup.push(async () => { await stream.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/session-channel?observation=activity`);
    const messages: any[] = [];
    socket.on('message', raw => { messages.push(JSON.parse(raw.toString())); });
    await once(socket, 'open');
    await expect.poll(() => messages.some(item => item.type === 'ready'), { timeout: 1500 }).toBe(true);
    socket.send(JSON.stringify({ protocolVersion: '1.6.0', type: 'subscribe', subscriptionId: 1, agentId: 'tracked',
      message: { protocolVersion: '1.6.0', type: 'negotiate', observation: 'activity' } }));
    const activity = () => messages.filter(item => item.message?.type === 'agent_activity').map(item => item.message.payload);
    await expect.poll(() => activity().length, { timeout: 1500 }).toBe(1);
    return { socket, messages, activity };
  };
  return { manager, push, connect };
}

it('coalesces accepted timeline rows over a real socket without turning connection metadata or duplicates into content', async () => {
  const f = await fixture(); const c = await f.connect();
  expect(c.activity()).toEqual([{ agentId: 'tracked', status: 'idle', cursor: { epoch: 'original', seq: 1 } }]);
  for (const state of ['reconnecting', 'connected'] as const) f.push({
    type: 'observation', sourceKey: state, occurredAt: 2, delivery: 'live', event: { type: 'runtime_updated', provider: 'fake',
      runtimeInfo: { providerId: 'fake', sessionId: 'native', status: 'idle', connection: { state } } },
  });
  await f.manager.loadTimeline({ requestId: 'old', agentId: 'tracked', direction: 'before', cursor: { epoch: 'original', seq: 1 }, limit: 10 });
  await pause(600);
  expect(c.activity()).toHaveLength(1);
  const answer = row('answer', 'New answer');
  f.push(answer); f.push(answer);
  f.push({ ...row('thought', ''), event: { type: 'timeline', provider: 'fake', item: { type: 'reasoning', text: 'Reasoning is timeline content.' } } });
  f.push({ ...row('tool', ''), event: { type: 'timeline', provider: 'fake', item: {
    type: 'tool_call', callId: 'tool', name: 'command', detail: { type: 'shell', command: 'pwd' }, status: 'completed', error: null,
  } } });
  await expect.poll(() => f.manager.timelineCursor().seq, { timeout: 1500 }).toBe(4);
  await expect.poll(() => c.activity().length, { timeout: 1500 }).toBe(2);
  expect(c.activity().at(-1)).toEqual({ agentId: 'tracked', status: 'idle', cursor: { epoch: 'original', seq: 4 } });
  await pause(600);
  expect(c.activity()).toHaveLength(2);
  expect(c.messages.filter(item => item.message).map(item => item.message.type)).toEqual(['negotiated', 'agent_activity', 'agent_activity']);
  expect(JSON.stringify(c.messages)).not.toContain('New answer');
  c.socket.close(); await once(c.socket, 'close');
});

it('reconnects at the same content boundary and publishes one complete baseline for replacement history', async () => {
  const f = await fixture(); const first = await f.connect();
  first.socket.close(); await once(first.socket, 'close');
  const c = await f.connect();
  expect(c.activity()[0].cursor).toEqual({ epoch: 'original', seq: 1 });
  f.push({ type: 'timeline_replacement', observations: [row('initial', 'Already read', 'history'), row('restored', 'Recovered history', 'history')] });
  await expect.poll(() => c.activity().length, { timeout: 1500 }).toBe(2);
  const baseline = c.activity().at(-1).cursor;
  expect(baseline.epoch).not.toBe('original'); expect(baseline.seq).toBe(2);
  expect(c.activity().map(item => item.cursor.seq)).toEqual([1, 2]);
  f.push(row('restored', 'Recovered history'));
  await pause(600);
  expect(c.activity()).toHaveLength(2);
  f.push(row('after-recovery', 'Actual new content'));
  await expect.poll(() => c.activity().length, { timeout: 1500 }).toBe(3);
  expect(c.activity().at(-1).cursor).toEqual({ epoch: baseline.epoch, seq: 3 });
  c.socket.close(); await once(c.socket, 'close');
});

it('delivers the replacement baseline before immediately queued live content on the real activity socket', async () => {
  const f = await fixture(); const c = await f.connect();
  f.push({ type: 'timeline_replacement', observations: [row('initial', 'Already read', 'history'), row('restored', 'Recovered history', 'history')] });
  f.push(row('immediately-live', 'New content after recovery'));
  await expect.poll(() => c.activity().length, { timeout: 1500 }).toBe(3);
  const cursors = c.activity().map(item => item.cursor);
  expect(cursors[1].epoch).not.toBe('original');
  expect(cursors).toEqual([
    { epoch: 'original', seq: 1 }, { epoch: cursors[1].epoch, seq: 2 }, { epoch: cursors[1].epoch, seq: 3 },
  ]);
  c.socket.close(); await once(c.socket, 'close');
});
