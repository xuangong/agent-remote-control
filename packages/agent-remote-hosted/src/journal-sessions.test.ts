import { bodyFromRow, SessionJournal } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION, type AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it, vi } from 'vitest';

import type { HostStream, HostStreamOpener } from './journal-host-stream.js';
import { createJournalSessions, type JournalGate } from './journal-sessions.js';

const headSnapshot = { id: 'native-id', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null, capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } }, pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'native-id', status: 'idle' } } as AgentSnapshotPayload;

function socket() {
  const closed: Array<[number | undefined, string | undefined]> = [];
  const sent: Array<Record<string, any>> = [];
  const client = {
    readyState: 1, bufferedAmount: 0,
    send: (data: string) => { sent.push(JSON.parse(data)); },
    close: (code?: number, reason?: string) => { closed.push([code, reason]); },
  };
  return { closed, sent, client };
}

describe('the journal sessions of a Relay', () => {
  it('tells only the waiting streams of the returned Host that it is back', async () => {
    const head = { snapshot: headSnapshot, observedAt: 1 };
    const sessions = createJournalSessions({
      journals: { status: async () => ({ cursor: { epoch: 'e', seq: 0 }, head } as never), page: async () => undefined, unserve: () => undefined },
      gate: { readingEnabled: () => true, served: () => true, loadServed: async () => undefined },
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
      gate: { readingEnabled: () => true, served: () => true, loadServed: async () => undefined },
      journals: {
        unserve: () => undefined,
        status: async () => ({ cursor: journal.cursor, head: journal.head! }),
        page: async (_host, _key, request, olderBeyondJournal) => { olderArguments.push(olderBeyondJournal); return journal.page(request, { olderBeyondJournal }); },
      },
      requestFill: (_host, _key, keys, read) => new Promise(resolve => {
        fills.push({ keys, finish: () => { for (const key of keys) journal.fill(key, bodyFromRow(row(key)), 'a'.repeat(64)); resolve({ filled: keys, mismatched: [], unknown: [], page: journal.page(read.request, { olderBeyondJournal: read.olderBeyondJournal() }) }); } });
      }),
      requestOlder: () => new Promise(resolve => { olderReads.push({ answer: olderAvailable => resolve({ olderAvailable }) }); }),
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const open = async (limit: number, direction: 'tail' | 'before' = 'tail') => {
      const { client, closed, sent } = socket();
      const stream = sessions.attach({ hostId: 'host-1', sessionKey: 'codex:thread-1', publicAgentId: 'agent', client, hostStreams: { open: () => new Promise<HostStream>(() => undefined) } });
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

describe('whether a session is read from its journal', () => {
  function build(gate: Partial<JournalGate>) {
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const calls: string[] = [];
    const sessions = createJournalSessions({
      journals: { status: async () => undefined, page: async () => undefined, unserve: () => undefined },
      gate: {
        readingEnabled: () => { calls.push('enabled'); return true; },
        served: () => { calls.push('served'); return true; },
        loadServed: async () => { calls.push('load'); },
        ...gate,
      },
      requestFill: async () => ({}) as never,
      requestOlder: async () => ({ olderAvailable: false }),
      scheduler: { setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; }, clearTimeout: timer => { timers.delete(timer as number); } },
    });
    return { sessions, calls, timers };
  }

  it('is crude while the switch is off, without asking the index', async () => {
    const { sessions, calls } = build({ readingEnabled: () => false });
    expect(await sessions.serves('host-1', 'codex', 'codex:a')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('answers from the index without loading anything', async () => {
    const served = build({});
    expect(await served.sessions.serves('host-1', 'codex', 'codex:a')).toBe(true);
    const unserved = build({ served: () => false });
    expect(await unserved.sessions.serves('host-1', 'codex', 'codex:a')).toBe(false);
    expect(served.calls).not.toContain('load');
    expect(unserved.calls).not.toContain('load');
  });

  it('loads the Host once for every open that asks while it loads, and then answers', async () => {
    let loaded = false;
    let loads = 0;
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const { sessions } = build({ served: () => (loaded ? true : undefined), loadServed: async () => { loads += 1; await held; loaded = true; } });
    const answers = [sessions.serves('host-1', 'codex', 'codex:a'), sessions.serves('host-1', 'codex', 'codex:b'), sessions.serves('host-1', 'codex', 'codex:c')];
    finish();
    expect(await Promise.all(answers)).toEqual([true, true, true]);
    expect(loads).toBe(1);
  });

  it('serves crude when the load takes longer than the wait, on the broker\'s scheduler', async () => {
    const { sessions, timers } = build({ served: () => undefined, loadServed: () => new Promise<void>(() => undefined) });
    const answer = sessions.serves('host-1', 'codex', 'codex:a');
    expect(timers.size).toBe(1);
    [...timers.values()][0]!();
    expect(await answer).toBe(false);
  });

  it('serves crude when the load fails', async () => {
    const { sessions } = build({ served: () => undefined, loadServed: async () => { throw new Error('store unavailable'); } });
    expect(await sessions.serves('host-1', 'codex', 'codex:a')).toBe(false);
  });
});

describe('stopping journal-served streams', () => {
  function attached() {
    const sessions = createJournalSessions({
      journals: { status: async () => undefined, page: async () => undefined, unserve: () => undefined },
      gate: { readingEnabled: () => true, served: () => true, loadServed: async () => undefined },
      requestFill: async () => ({}) as never,
      requestOlder: async () => ({ olderAvailable: false }),
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const offline: HostStreamOpener = { open: async () => { throw Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' }); } };
    const attach = (hostId: string, sessionKey: string) => {
      const { client, closed } = socket();
      sessions.attach({ hostId, sessionKey, publicAgentId: 'agent', client, hostStreams: offline });
      return closed;
    };
    return { sessions, attach };
  }

  it('closes the streams of one provider of one Host with 1012 when its smart reading is turned off, and no others', () => {
    const { sessions, attach } = attached();
    const codex = attach('host-1', 'codex:a');
    const claude = attach('host-1', 'claude:a');
    const other = attach('host-2', 'codex:a');
    sessions.stopReading('host-1', 'codex');
    expect(codex).toEqual([[1012, 'Smart reading turned off']]);
    expect(claude).toEqual([]);
    expect(other).toEqual([]);
  });

  it('closes the streams of a session that a quota took out of serving', () => {
    const { sessions, attach } = attached();
    const taken = attach('host-1', 'codex:a');
    const kept = attach('host-1', 'codex:b');
    sessions.published('host-1', 'codex:a', { events: [], watermark: 4, unserved: true, hasHead: false });
    expect(taken).toEqual([[1012, 'Journal unavailable']]);
    expect(kept).toEqual([]);
  });
});

describe('a journal that has no head although the index said it had one', () => {
  it('is forgotten by the index before the stream closes with 1012, so the client\'s reconnect is read through the Controller', async () => {
    const unserved: string[] = [];
    const sessions = createJournalSessions({
      journals: { status: async () => undefined, page: async () => undefined, unserve: (hostId, sessionKey) => { unserved.push(`${hostId}/${sessionKey}`); } },
      gate: { readingEnabled: () => true, served: () => true, loadServed: async () => undefined },
      requestFill: async () => ({}) as never,
      requestOlder: async () => ({ olderAvailable: false }),
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const offline: HostStreamOpener = { open: async () => { throw Object.assign(new Error('The Remote Host is offline.'), { code: 'host_offline' }); } };
    const { client, closed } = socket();
    const stream = sessions.attach({ hostId: 'host-1', sessionKey: 'codex:a', publicAgentId: 'agent', client, hostStreams: offline });
    stream.receive(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(unserved).toEqual(['host-1/codex:a']);
    expect(closed).toEqual([[1012, 'Session journal unavailable']]);
  });
});
