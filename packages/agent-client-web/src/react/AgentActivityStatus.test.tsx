// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';
import { AgentActivityStatus } from './AgentActivityStatus.js';
import { remoteSessionState, AgentReplica } from '@orchardworks/agent-client';

const snapshot = (): AgentSnapshotPayload => ({
  id: 'agent-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-1', status: 'idle' },
});
const restored = () => { const replica = new AgentReplica(); replica.restoreFromDevice({ snapshot: snapshot(), epoch: 'e1', nextSeq: 1, hasOlder: false, entries: [] }); return replica.getState(); };
const label = async (state: ReturnType<typeof restored> | undefined, connection: Parameters<typeof remoteSessionState>[1]) =>
  (await render(<AgentActivityStatus state={state} sessionState={remoteSessionState(state, connection)} />)).textContent;

it('says the last business label instead of the opening words while the rows are held from the device', async () => {
  for (const connection of ['connecting', 'catching_up'] as const) {
    const text = await label(restored(), connection);
    expect(text).toContain('Ready');
    expect(text).not.toMatch(/Opening session|Synchronizing|Checking access/);
  }
});

it('never hides a connection that broke, and keeps the opening words for a conversation with no rows', async () => {
  expect(await label(restored(), 'disconnected')).toContain('Reconnecting');
  expect(await label(restored(), 'unavailable')).toContain('Unavailable');
  expect(await label(undefined, 'connecting')).toContain('Opening session');
});
