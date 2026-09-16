import { afterEach, expect, it, vi } from 'vitest';
import { forkActions } from './fork-actions.js';
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
