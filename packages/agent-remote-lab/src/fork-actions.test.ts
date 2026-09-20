import { afterEach, expect, it, vi } from 'vitest';
import { configureFork, forkActions } from './fork-actions.js';
import { ForkStore, forkDisplayState, contextPrefix } from './session-forks.js';
import { replicaState } from './test/fixtures.js';
import type { RemoteAgentTransport } from '@agent-remote-controller/agent-remote-web';

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
