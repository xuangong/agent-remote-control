import { afterEach, expect, it, vi } from 'vitest';
import { AgentReplica, type RemoteAgentTransport } from '@orchardworks/agent-client';
import { ConversationConnections } from './conversation-connections.js';
import { clearConversationRecovery } from './conversation-recovery.js';
import { readStoredDisplay, saveStoredDisplay } from './stored-display.js';
import { deviceStore } from '@orchardworks/agent-client/device-store';
import { replicaState } from './test/fixtures.js';

const scope = 'display-cache';
const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'recorded-session' };
const transport = { onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  connect: () => ({ close() {}, send() {} }) } as unknown as RemoteAgentTransport;
const connections: ConversationConnections[] = [];
function update(replica: AgentReplica, text: string, seq: number, epoch = 'epoch') {
  replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: {
    ...replicaState.agent!, status: 'running', activeTurn: { turnId: 'working', startedAt: '2026-10-17T00:00:00Z' },
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, status: 'running' },
  } });
  replica.applyHistory({ protocolVersion: '1.8.0', type: 'timeline_page', payload: {
    requestId: 'history', agentId: 'agent-1', epoch, direction: 'tail', reset: false, staleCursor: false, gap: false, error: null,
    window: { minSeq: 1, maxSeq: seq, nextSeq: seq + 1 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false,
    entries: [{ providerId: 'recorded', seqStart: seq, seqEnd: seq, timestamp: '2026-10-17T00:00:00Z', sourceSeqRanges: [], resources: [], collapsed: [],
      item: { type: 'assistant_message', text } }],
  } });
}
function setup() {
  vi.useFakeTimers();
  const replica = new AgentReplica();
  update(replica, 'Previous turn', 1);
  saveStoredDisplay(scope, target, replica.getState());
  const pool = new ConversationConnections(transport, scope);
  connections.push(pool);
  const lease = pool.acquire('agent-1', replica, target);
  return { pool, lease, replica };
}
function cachedText() { return readStoredDisplay(scope, target)?.timeline.entries.map(entry => entry.item).filter(item => item.type === 'assistant_message').map(item => item.text).join(''); }
afterEach(async () => {
  for (const pool of connections.splice(0)) pool.clear();
  vi.useRealTimers(); vi.restoreAllMocks(); clearConversationRecovery(scope); await deviceStore.purge();
});

it.each(['pagehide', 'hidden', 'close'] as const)('keeps the working content a page confirmed before connection readiness, through %s', async event => {
  const { pool, lease, replica } = setup();
  update(replica, 'Latest visible working content', 2);
  expect(lease.client.getSessionState().connection).not.toBe('ready');
  if (event === 'close') pool.clear();
  else if (event === 'hidden') {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  } else window.dispatchEvent(new Event('pagehide'));
  expect(cachedText()).toContain('Latest visible working content');
  const display = readStoredDisplay(scope, target)!;
  expect(display.agent?.activeTurn).toBeNull();
  expect(display.timeline.nextSeq).toBe(0);
  expect(display.pendingInteractions).toEqual([]);
  expect(display.sessionControl).toBeUndefined();
});

it('keeps content at a confirmed page and at the end of a turn, and nothing in between', async () => {
  const { replica } = setup();
  const put = vi.spyOn(deviceStore, 'put');
  for (let seq = 2; seq <= 5; seq++) {
    update(replica, `Working content ${seq}`, seq);
    // update() applies a snapshot with a running turn and then a page: the page is confirmed, so it is kept.
  }
  expect(put.mock.calls.length).toBe(4);
  put.mockClear();
  // Live frames alone are not kept.
  replica.applyStream({ protocolVersion: '1.8.0', type: 'agent_stream', payload: { agentId: 'agent-1', epoch: 'epoch', seq: 6, timestamp: '2026-10-17T00:00:00Z',
    event: { type: 'timeline', providerId: 'recorded', item: { type: 'assistant_message', text: 'Streaming' }, resources: [] } } } as never);
  expect(put).not.toHaveBeenCalled();
  // The turn ends.
  replica.applySnapshot({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: { ...replicaState.agent!, status: 'idle', activeTurn: null } });
  expect(put).toHaveBeenCalledTimes(1);
  expect(cachedText()).toContain('Streaming');
});

it('keeps caching a retained session after its last view closes and shares one writer across views', async () => {
  const { pool, lease, replica } = setup();
  const write = vi.spyOn(deviceStore, 'put');
  pool.retainSessions('window', [target]);
  const second = pool.acquire('agent-1', new AgentReplica(), target);
  expect(second.replica).toBe(replica);
  lease.release(); second.release();
  await Promise.resolve();
  update(replica, 'Background working content', 2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(cachedText()).toContain('Background working content');
  expect(write).toHaveBeenCalledTimes(1);
});

it('keeps the last complete display while replacement history has not arrived', () => {
  const { replica } = setup();
  update(replica, 'Latest visible working content', 2);
  replica.replaceTimeline('new-epoch');
  window.dispatchEvent(new Event('pagehide'));
  expect(cachedText()).toContain('Latest visible working content');
  update(replica, 'Confirmed replacement history', 1, 'new-epoch');
  window.dispatchEvent(new Event('pagehide'));
  expect(cachedText()).toBe('Confirmed replacement history');
});

it('starts persistence when a shared connection gains its native identity', () => {
  vi.useFakeTimers();
  const replica = new AgentReplica();
  const pool = new ConversationConnections(transport, scope); connections.push(pool);
  pool.acquire('agent-1', replica);
  update(replica, 'Bound working content', 1);
  pool.acquire('agent-1', new AgentReplica(), target);
  window.dispatchEvent(new Event('pagehide'));
  expect(cachedText()).toBe('Bound working content');
  pool.acquire('agent-1', replica, { ...target, nativeSessionId: 'other-session' });
  update(replica, 'Content still from the original session', 2);
  window.dispatchEvent(new Event('pagehide'));
  expect(readStoredDisplay(scope, { ...target, nativeSessionId: 'other-session' })).toBeUndefined();
  expect(cachedText()).toBe('Bound working content');
});

it('does not recreate display data after recovery storage is cleared', async () => {
  const { pool, replica } = setup();
  update(replica, 'Latest visible working content', 2);
  clearConversationRecovery(scope);
  update(replica, 'Late content after clear', 3);
  await vi.advanceTimersByTimeAsync(2100);
  window.dispatchEvent(new Event('pagehide')); pool.clear();
  expect(readStoredDisplay(scope, target)).toBeUndefined();
});

it('does not store rows that no connection has confirmed, and stores them once the first page did', async () => {
  const seeded = new AgentReplica();
  update(seeded, 'Stored earlier', 1);
  saveStoredDisplay(scope, target, seeded.getState());
  const replica = new AgentReplica();
  const pool = new ConversationConnections(transport, scope); connections.push(pool);
  const put = vi.spyOn(deviceStore, 'put');
  pool.acquire('agent-1', replica, target);
  // The record seeded this replica; its rows are display until a page confirms them.
  expect(replica.getState().timeline.restoredFromDevice).toBe(true);
  window.dispatchEvent(new Event('pagehide'));
  expect(put).not.toHaveBeenCalled();
  update(replica, 'Confirmed by the first page', 2);
  window.dispatchEvent(new Event('pagehide'));
  expect(put).toHaveBeenCalledTimes(1);
  expect(readStoredDisplay(scope, target)?.timeline.entries.map(entry => entry.item).filter(item => item.type === 'assistant_message').map(item => item.text).join('')).toContain('Confirmed by the first page');
});
