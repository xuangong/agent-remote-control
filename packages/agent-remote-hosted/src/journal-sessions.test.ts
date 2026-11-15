import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import type { HostStreamOpener } from './journal-host-stream.js';
import { createJournalSessions } from './journal-sessions.js';

function socket() {
  const closed: Array<[number | undefined, string | undefined]> = [];
  return { closed, client: { readyState: 1, bufferedAmount: 0, send: () => undefined, close: (code?: number, reason?: string) => { closed.push([code, reason]); } } };
}

describe('the journal sessions of a Relay', () => {
  it('tells only the waiting streams of the returned Host that it is back', async () => {
    const head = { snapshot: { id: 'native-id', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null, capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } }, pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-id', status: 'idle' } }, observedAt: 1 };
    const sessions = createJournalSessions({
      journals: { status: async () => ({ cursor: { epoch: 'e', seq: 0 }, head } as never), page: async () => undefined },
      requestFill: async () => ({}) as never,
      requestOlder: async () => ({ olderAvailable: false }),
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const offline: HostStreamOpener = { open: async () => { throw Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' }); } };
    const attach = (hostId: string, sessionKey: string) => {
      const { client, closed } = socket();
      const stream = sessions.attach({ hostId, sessionKey, publicAgentId: 'agent', client, hostStreams: offline });
      stream.receive(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
      return { stream, closed };
    };
    const first = attach('host-1', 'codex:a');
    const second = attach('host-1', 'codex:b');
    const other = attach('host-2', 'codex:a');
    await new Promise(resolve => setTimeout(resolve, 20));
    sessions.hostReturned('host-1');
    expect(first.closed).toEqual([[1012, 'Remote Host reconnected']]);
    expect(second.closed).toEqual([[1012, 'Remote Host reconnected']]);
    expect(other.closed).toEqual([]);
  });
});
