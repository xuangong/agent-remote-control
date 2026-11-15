import { bodyFromRow, SessionJournal } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it, vi } from 'vitest';

import type { HostStreamOpener } from './journal-host-stream.js';
import { createJournalSessions } from './journal-sessions.js';

const headSnapshot = { id: 'native-id', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null, capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } }, pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-id', status: 'idle' } } as AgentSnapshotPayload;

function socket() {
  const closed: Array<[number | undefined, string | undefined]> = [];
  return { closed, client: { readyState: 1, bufferedAmount: 0, send: () => undefined, close: (code?: number, reason?: string) => { closed.push([code, reason]); } } };
}

describe('the journal sessions of a Relay', () => {
  it('tells only the waiting streams of the returned Host that it is back', async () => {
    const head = { snapshot: headSnapshot, observedAt: 1 };
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

  /** A session over a real journal whose bodies can be evicted, with fills and older reads that wait for the test. */
  async function journalSessions(options: { evict?: boolean } = {}) {
    const journal = SessionJournal.create('host-1:codex:thread-1');
    const { generation } = journal.claim('controller-1');
    let sequence = 0;
    const at = () => ({ publisherId: 'controller-1', generation, sequence: ++sequence });
    const row = (itemKey: string) => ({ itemKey, providerId: 'codex', sourceKey: itemKey, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item: { type: 'assistant_message' as const, text: itemKey, messageId: itemKey } });
    for (const key of ['k1', 'k2']) { journal.append(at(), row(key)); journal.complete(at(), key, 'a'.repeat(64)); }
    journal.setHead(at(), { snapshot: headSnapshot, observedAt: 1 });
    if (options.evict !== false) journal.evict(0);
    const fills: Array<{ keys: string[]; finish(): void }> = [];
    const olderReads: Array<{ answer(olderAvailable: boolean): void }> = [];
    const olderArguments: boolean[] = [];
    const sessions = createJournalSessions({
      journals: {
        status: async () => ({ cursor: journal.cursor, head: journal.head! }),
        page: async (_host, _key, request, olderBeyondJournal) => { olderArguments.push(olderBeyondJournal); return journal.page(request, { olderBeyondJournal }); },
      },
      requestFill: (_host, _key, keys) => new Promise(resolve => {
        fills.push({ keys, finish: () => { for (const key of keys) journal.fill(key, bodyFromRow(row(key)), 'a'.repeat(64)); resolve({ filled: keys, mismatched: [], unknown: [] }); } });
      }),
      requestOlder: () => new Promise(resolve => { olderReads.push({ answer: olderAvailable => resolve({ olderAvailable }) }); }),
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const open = async (limit: number, direction: 'tail' | 'before' = 'tail') => {
      const { client, closed } = socket();
      const sent: Array<Record<string, any>> = [];
      client.send = (data: string) => { sent.push(JSON.parse(data)); };
      const stream = sessions.attach({ hostId: 'host-1', sessionKey: 'codex:thread-1', publicAgentId: 'agent', client, hostStreams: { open: () => new Promise(() => undefined) } });
      stream.receive(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
      await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(3));
      stream.receive(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_request', payload: { requestId: `page-${limit}-${sent.length}`, agentId: 'agent', direction, limit, ...(direction === 'before' ? { cursor: { epoch: journal.epoch, seq: 1 } } : {}) } }));
      return { stream, sent, closed };
    };
    return { sessions, fills, olderReads, olderArguments, journal, open };
  }

  it('asks for the bodies of one session one fill at a time, each stream for its own items', async () => {
    const f = await journalSessions();
    const first = await f.open(1);
    await vi.waitFor(() => expect(f.fills).toHaveLength(1));
    const second = await f.open(2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.fills.map(fill => fill.keys)).toEqual([['k2']]);
    f.fills[0]!.finish();
    await vi.waitFor(() => expect(f.fills).toHaveLength(2));
    expect(f.fills[1]!.keys).toEqual(['k1', 'k2']);
    f.fills[1]!.finish();
    await vi.waitFor(() => expect(first.sent.at(-1)?.type).toBe('timeline_page'));
    await vi.waitFor(() => expect(second.sent.at(-1)?.type).toBe('timeline_page'));
  });

  it('keeps the shared state of a session while a fill is pending, so a reload waits for it', async () => {
    const f = await journalSessions();
    const first = await f.open(2);
    await vi.waitFor(() => expect(f.fills).toHaveLength(1));
    first.stream.close();
    const reloaded = await f.open(2);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.fills).toHaveLength(1);
    f.fills[0]!.finish();
    await vi.waitFor(() => expect(f.fills).toHaveLength(2));
    f.fills[1]!.finish();
    await vi.waitFor(() => expect(reloaded.sent.at(-1)?.type).toBe('timeline_page'));
  });

  it('does not mark a replaced journal as exhausted because of an answer about the one it replaced', async () => {
    const f = await journalSessions({ evict: false });
    await f.open(100, 'before');
    await vi.waitFor(() => expect(f.olderReads).toHaveLength(1));
    f.sessions.published('host-1', 'codex:thread-1', { events: [{ kind: 'replaced', epoch: 'epoch-2' }], watermark: 0 });
    f.olderReads[0]!.answer(false);
    await vi.waitFor(() => expect(f.olderArguments.length).toBeGreaterThanOrEqual(2));
    await f.open(100, 'before');
    await vi.waitFor(() => expect(f.olderArguments.at(-1)).toBe(true));
    expect(f.olderArguments.at(-1)).toBe(true);
  });
});
