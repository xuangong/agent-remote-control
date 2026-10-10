import { afterEach, expect, it, vi } from 'vitest';
import { configureFork, forkActions } from './fork-actions.js';
import { ForkStore, forkDisplayState, contextPrefix } from './session-forks.js';
import { replicaState } from './test/fixtures.js';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';

const source = { agentId: 'source', nativeSessionId: 'native-source', providerId: 'codex', title: 'Source' };
afterEach(() => localStorage.clear());
it('inherits settings once and respects subsequent explicit changes', async () => {
  const store = new ForkStore('settings');
  const record = store.prepare({ source, text: '[]', itemCount: 0, capturedAt: new Date().toISOString(), boundary: { epoch: 'one', seq: 0 } }, {}, [{ id: 'sandbox', value: 'read-only' }]);
  store.bind(record.id, { ...source, agentId: 'target', nativeSessionId: 'native-target' });
  const sendMessage = vi.fn(async () => {});
  const setSessionSetting = vi.fn(async () => {});
  const transport = { fetchSnapshot: vi.fn(async () => ({ payload: { runtimeInfo: { settings: [{ id: 'sandbox', value: 'workspace-write', mutable: true, scope: 'session' }] } } })) } as unknown as RemoteAgentTransport;
  const actions = forkActions({ sendMessage, setSessionSetting }, store, store.get(record.id), transport);
  await actions.sendMessage!('first');
  expect(setSessionSetting).toHaveBeenCalledExactlyOnceWith('sandbox', 'read-only');
  await actions.sendMessage!('second');
  expect(setSessionSetting).toHaveBeenCalledTimes(1);
  expect(sendMessage.mock.calls).toHaveLength(2);
});
it('hides only the exact attachment in the conversation view while preserving the replica', () => {
  const store = new ForkStore('display');
  const record = store.prepare({ source, text: '[]', itemCount: 0, capturedAt: new Date().toISOString(), boundary: { epoch: 'one', seq: 0 } });
  const state = { ...replicaState, timeline: { ...replicaState.timeline, entries: [{ providerId: 'codex', item: { type: 'user_message' as const, text: contextPrefix(record) + 'question' }, seqStart: 1, seqEnd: 1, timestamp: record.capturedAt, sourceSeqRanges: [], collapsed: [], resources: [] }] } };
  expect(forkDisplayState(state, record)!.timeline.entries[0]!.item).toMatchObject({ text: 'question' });
  expect(state.timeline.entries[0]!.item.text).toContain('<session-context');
});
it('prepends first-branch context once without changing ordered image parts', async () => {
  const store = new ForkStore('image-fork');
  const record = store.prepare({ source, text: '[]', itemCount: 0, capturedAt: new Date().toISOString(), boundary: { epoch: 'one', seq: 0 } });
  store.bind(record.id, { ...source, agentId: 'target', nativeSessionId: 'native-target' });
  const sendMessageContent = vi.fn(async () => {});
  const actions = forkActions({ sendMessageContent }, store, store.get(record.id), {} as RemoteAgentTransport);
  const content = [{ type: 'text' as const, text: 'Compare ' }, { type: 'image' as const, attachmentId: 'a', label: 'image #1' }];
  await actions.sendMessageContent!(content);
  expect(sendMessageContent).toHaveBeenLastCalledWith([{ type: 'text', text: contextPrefix(record) }, ...content], undefined);
  await actions.sendMessageContent!(content);
  expect(sendMessageContent).toHaveBeenLastCalledWith(content, undefined);
});


it('releases the preparation subscription when Ask is disabled before readiness', async () => {
  const store = new ForkStore('cancel-preparation');
  const record = store.prepare({ source, text: '[]', itemCount: 0, capturedAt: new Date().toISOString(), boundary: { epoch: 'one', seq: 0 } }, {}, [{ id: 'sandbox', value: 'read-only' }]);
  store.bind(record.id, { ...source, agentId: 'target', nativeSessionId: 'native-target' });
  const close = vi.fn();
  const transport: RemoteAgentTransport = {
    fetchSnapshot: async () => { throw new Error('No snapshot should be fetched before readiness'); },
    fetchTimeline: async () => { throw new Error('No history should be fetched before readiness'); },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect: (_agentId, listener) => {
      queueMicrotask(() => listener.onOpen());
      return { send: () => {}, close };
    },
  };
  const abort = new AbortController();
  const preparation = configureFork(transport, store, store.get(record.id), abort.signal);
  const rejected = expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  await rejected;
  expect(close).toHaveBeenCalledOnce();
  expect(store.get(record.id).configured).toBeFalsy();
});


it('checks uncertain echo at the original recipient after current-source projection', async () => {
  const store = new ForkStore('original-echo');
  const original = { ...source, hostId: 'host' };
  const target = { ...original, agentId: 'X-agent', nativeSessionId: 'X' };
  const record = store.prepare({ source: original, text: '[]', itemCount: 0, capturedAt: '2026-10-10T00:00:00.000Z', boundary: { epoch: 'one', seq: 0 } });
  store.bind(record.id, target);
  await expect(store.send(record.id, 'question', async () => { throw new Error('lost receipt'); }, async () => false)).rejects.toThrow('lost receipt');
  store.setSharedRelations([{ id: record.id, kind: 'side', createdAt: record.capturedAt, source: { ...original, providerId: 'claude', nativeSessionId: 'B', agentId: 'B-agent' }, target,
    nativeSourceRef: { controllerId: 'installation', providerId: original.providerId, nativeSessionId: original.nativeSessionId }, hostLocator: { hostId: 'host', controllerId: 'installation' } }]);
  const recipients: string[] = [];
  let echoed = false;
  const transport = { fetchTimeline: async (agentId: string) => {
    recipients.push(agentId);
    return { payload: { epoch: 'one', window: { maxSeq: 1 }, hasOlder: false, entries: echoed ? [{ seqStart: 1, seqEnd: 1, item: { type: 'user_message', text: contextPrefix(record) + 'question' } }] : [] } };
  } } as unknown as RemoteAgentTransport;
  const sent: string[] = [];
  const actions = forkActions({ sendMessage: async input => { sent.push(input); } }, store, store.get(record.id), transport);
  await expect(actions.sendMessage!('question')).rejects.toThrow('unknown delivery status');
  expect(sent).toEqual([]);
  echoed = true;
  await actions.sendMessage!('question');
  expect(sent).toEqual([]);
  expect(recipients).toEqual(['X-agent', 'X-agent']);
  expect(new ForkStore('original-echo').get(record.id)).toMatchObject({ source: original, target, delivery: 'sent' });
});


it.each(['read denied', 'missing', 'malformed'] as const)('fences a known uncertain local delivery when raw storage is %s', async failure => {
  let denied = false;
  const storage = { getItem(key: string) {
    if (denied) {
      if (failure === 'read denied') throw new Error('Read denied');
      return failure === 'missing' ? null : '{invalid';
    }
    return localStorage.getItem(key);
  },
    setItem(key: string, value: string) { localStorage.setItem(key, value); } } as unknown as Storage;
  const store = new ForkStore('denied-local-input', storage);
  const record = store.prepare({ source, text: '[]', itemCount: 0, capturedAt: '2026-10-10T00:00:00.000Z', boundary: { epoch: 'one', seq: 0 } });
  store.bind(record.id, { ...source, agentId: 'X-agent', nativeSessionId: 'X' });
  await expect(store.send(record.id, 'unknown question', async () => { throw new Error('lost receipt'); }, async () => false)).rejects.toThrow('lost receipt');
  const known = store.get(record.id);
  const sent: string[] = [];
  denied = true;
  const actions = forkActions({ sendMessage: async input => { sent.push(input); } }, store, known, {} as RemoteAgentTransport);
  denied = true;
  await expect(actions.sendMessage!('unknown question')).rejects.toThrow('unavailable');
  expect(sent).toEqual([]);
  denied = false;
  expect(store.getLocal(record.id)).toEqual(known);
});


it('rejects known-local configuration before connection when its record is missing', async () => {
  const store = new ForkStore('missing-configure');
  const record = store.prepare({ source, text: '[]', itemCount: 0, capturedAt: '2026-10-10T00:00:00.000Z', boundary: { epoch: 'one', seq: 0 } }, {}, [{ id: 'sandbox', value: 'read-only' }]);
  store.bind(record.id, { ...source, agentId: 'X-agent', nativeSessionId: 'X' });
  const known = store.get(record.id);
  localStorage.clear();
  const connections: string[] = [];
  const transport = { connect: (agentId: string) => { connections.push(agentId); throw new Error('Unexpected connection'); } } as unknown as RemoteAgentTransport;
  await expect(configureFork(transport, store, known)).rejects.toThrow('unavailable');
  expect(connections).toEqual([]);
});

it('keeps proven shared-only action sending plain without acquiring a local ledger', async () => {
  const store = new ForkStore('shared-action');
  store.setSharedRelations([{ id: 'shared', kind: 'side', createdAt: '2026-10-10T00:00:00.000Z', source: { ...source, hostId: 'host' },
    target: { ...source, hostId: 'host', agentId: 'X-agent', nativeSessionId: 'X' } }]);
  const sent: string[] = [];
  const actions = forkActions({ sendMessage: async input => { sent.push(input); } }, store, store.get('shared'), {} as RemoteAgentTransport);
  await actions.sendMessage!('ordinary question');
  expect(sent).toEqual(['ordinary question']);
  expect(store.allLocal()).toEqual([]);
});


it('keeps a known-local send fenced when its record disappears after the configuration check', async () => {
  let missing = false;
  let checkedReads = 0;
  const storage = { getItem(key: string) { return missing ? null : localStorage.getItem(key); },
    setItem(key: string, value: string) { localStorage.setItem(key, value); } } as unknown as Storage;
  const store = new ForkStore('vanished-local-input', storage);
  const record = store.prepare({ source, text: '[]', itemCount: 0, capturedAt: '2026-10-10T00:00:00.000Z', boundary: { epoch: 'one', seq: 0 } });
  const target = { ...source, hostId: 'host', agentId: 'X-agent', nativeSessionId: 'X' };
  store.bind(record.id, target); store.markConfigured(record.id);
  store.setSharedRelations([{ id: record.id, kind: 'side', createdAt: record.capturedAt, source: { ...source, hostId: 'host' }, target }]);
  const known = store.get(record.id);
  const sent: string[] = [];
  const actions = forkActions({ sendMessage: async input => { sent.push(input); } }, store, known, {} as RemoteAgentTransport);
  const read = store.getLocalForEffect.bind(store);
  vi.spyOn(store, 'getLocalForEffect').mockImplementation(id => {
    const value = read(id);
    if (++checkedReads === 1) missing = true;
    return value;
  });
  await expect(actions.sendMessage!('question')).rejects.toThrow('unavailable');
  expect(sent).toEqual([]);
});
