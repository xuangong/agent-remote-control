import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { REMOTE_HOST_UPLINK_VERSION, type AgentSnapshotPayload, type RemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createHostJournals, type JournalPublished } from './host-journals.js';
import { createJournalConnection, JournalRequestError, type JournalHostMessage } from './journal-uplink.js';

const HOST = 'host-1';
const SESSION = 'codex:thread-1';
const snapshot: AgentSnapshotPayload = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
};
const wire = (message: Record<string, unknown>) => ({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, ...message }) as unknown as JournalHostMessage;

function fixture() {
  const journals = createHostJournals({ store: new MemoryJournalStore() });
  const sent: RemoteHostUplinkMessage[] = [];
  const published: Array<{ sessionKey: string; result: JournalPublished }> = [];
  const timers: Array<() => void> = [];
  const connection = createJournalConnection({
    hostId: HOST, journals, current: () => true, send: message => { sent.push(message); },
    scheduler: { setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: () => undefined },
    published: (sessionKey, result) => { published.push({ sessionKey, result }); },
  });
  const open = async (): Promise<number> => {
    await connection.receive(wire({ type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' }));
    const opened = sent.find(message => message.type === 'journal_opened');
    return (opened as { generation: number }).generation;
  };
  return { journals, connection, sent, published, open };
}

describe('the Controller\'s unserve and request refusals', () => {
  it('clears the head of a session the Controller gave up on, and tells the broker so its streams close', async () => {
    const { journals, connection, published, open } = fixture();
    const generation = await open();
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries: [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 5 } }] }));
    expect(journals.served(HOST, SESSION)).toBe(true);
    published.length = 0;
    await connection.receive(wire({ type: 'journal_unserve', sessionKey: SESSION, generation }));
    expect(journals.served(HOST, SESSION)).toBe(false);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ sessionKey: SESSION, result: { unserved: true, hasHead: false } });
  });

  it('ignores an unserve from a generation this connection did not open', async () => {
    const { journals, connection, published, open } = fixture();
    const generation = await open();
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries: [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 5 } }] }));
    published.length = 0;
    await connection.receive(wire({ type: 'journal_unserve', sessionKey: SESSION, generation: generation + 1 }));
    await connection.receive(wire({ type: 'journal_unserve', sessionKey: 'codex:other', generation }));
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(published).toEqual([]);
  });

  it('ignores an unserve for a session this connection never opened, whoever published its head', async () => {
    const { journals, connection, open } = fixture();
    const generation = await open();
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries: [{ sequence: 1, op: 'head', head: { snapshot, observedAt: 5 } }] }));
    const published: string[] = [];
    const other = createJournalConnection({ hostId: HOST, journals, current: () => true, send: () => undefined,
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined }, published: sessionKey => { published.push(sessionKey); } });
    await other.receive(wire({ type: 'journal_unserve', sessionKey: SESSION, generation }));
    expect(journals.served(HOST, SESSION)).toBe(true);
    expect(published).toEqual([]);
  });

  it('rejects a pending fill or older-history request at once when the Controller refuses it', async () => {
    const { connection, sent } = fixture();
    const fill = connection.requestFill(SESSION, ['m1']);
    const older = connection.requestOlder(SESSION, 20, 'm1');
    const ids = sent.flatMap(message => 'requestId' in message ? [[message.type, message.requestId] as const] : []);
    const fillId = ids.find(([type]) => type === 'journal_fill_request')![1];
    const olderId = ids.find(([type]) => type === 'journal_older_request')![1];
    await connection.receive(wire({ type: 'journal_request_refused', requestId: fillId, sessionKey: SESSION, reason: 'not_followed' }));
    await connection.receive(wire({ type: 'journal_request_refused', requestId: olderId, sessionKey: SESSION, reason: 'not_ready' }));
    await expect(fill).rejects.toMatchObject({ code: 'refused' });
    await expect(older).rejects.toBeInstanceOf(JournalRequestError);
  });

  it('accepts the entry that follows a refused one under the refused number, and does not take it for a duplicate', async () => {
    const { connection, sent, open } = fixture();
    const generation = await open();
    const row = (itemKey: string) => ({ itemKey, providerId: 'codex', sourceKey: `${itemKey}:1`, occurredAt: 1, item: { type: 'assistant_message', text: itemKey, messageId: itemKey } });
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries: [
      { sequence: 1, op: 'append', row: row('a') }, { sequence: 2, op: 'complete', itemKey: 'ghost', digest: 'd'.repeat(64) }, { sequence: 3, op: 'append', row: row('b') },
    ] }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'journal_ack', watermark: 1 }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'journal_refused', sequence: 2, reason: 'invalid' }));
    sent.length = 0;
    await connection.receive(wire({ type: 'journal_publish', sessionKey: SESSION, generation, entries: [{ sequence: 2, op: 'append', row: row('b') }] }));
    expect(sent).toEqual([expect.objectContaining({ type: 'journal_ack', watermark: 2, cursor: expect.objectContaining({ seq: 2 }) })]);
  });

  it('ignores a refusal that names no pending request of that session', async () => {
    const { connection, sent } = fixture();
    const fill = connection.requestFill(SESSION, ['m1']);
    const fillId = sent.flatMap(message => message.type === 'journal_fill_request' ? [message.requestId] : [])[0]!;
    await connection.receive(wire({ type: 'journal_request_refused', requestId: fillId, sessionKey: 'codex:other', reason: 'not_followed' }));
    await connection.receive(wire({ type: 'journal_request_refused', requestId: 'unknown', sessionKey: SESSION, reason: 'not_followed' }));
    connection.close();
    await expect(fill).rejects.toMatchObject({ code: 'closed' });
  });
});
