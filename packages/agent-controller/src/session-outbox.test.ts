import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';
import type { OutboxDelivery, OutboxHostCall } from '@orchardworks/agent-remote-protocol';
import type { RemoteHostSessionLease } from '@orchardworks/agent-session-runtime';
import { SessionOutbox, type OutboxAccess } from './session-outbox.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function receiptsFile() {
  const directory = await mkdtemp(join(tmpdir(), 'session-outbox-')); directories.push(directory);
  return join(directory, 'state', 'outbox-receipts.json');
}
const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const message = (index: number, status: OutboxDelivery['status'] = 'waiting', nativeSessionId = 'thread'): OutboxDelivery =>
  ({ id: uuid(index), providerId: 'codex', nativeSessionId, text: `Message ${index}`, createdAt: 1_000, status });

/** A Relay that keeps the outbox as the hosted one does, for one Host. */
function relay(initial: OutboxDelivery[]) {
  const entries = new Map(initial.map(entry => [entry.id, { ...entry }]));
  const settled: Array<{ id: string; outcome: string; error?: string }> = [];
  const calls: OutboxHostCall[] = [];
  let failNext: string | undefined;
  return {
    entries, settled, calls,
    failNext(action: string) { failNext = action; },
    async request(call: OutboxHostCall): Promise<unknown> {
      calls.push(call);
      if (failNext === call.action) { failNext = undefined; throw new Error('The outbox connection closed.'); }
      if (call.action === 'poll') return { entries: [...entries.values()].filter(entry => entry.status === 'waiting' || entry.status === 'delivering') };
      const entry = entries.get(call.id);
      if (call.action === 'claim') {
        if (!entry || entry.status !== 'waiting') throw Object.assign(new Error('This message is not waiting.'), { status: 409, code: 'outbox_not_waiting' });
        entry.status = 'delivering'; return { ...entry };
      }
      if (!entry) return { ok: true };
      settled.push({ id: call.id, outcome: call.outcome, ...(call.error ? { error: call.error } : {}) });
      if (call.outcome === 'accepted') entries.delete(call.id); else (entry as { status: string }).status = call.outcome === 'rejected' ? 'failed' : 'unknown';
      return { ok: true };
    },
  };
}

type Payload = ReturnType<RemoteHostSessionLease['agent']['snapshot']>['payload'];
function session(status: 'idle' | 'running' = 'idle', options: { queue?: boolean; refuse?: Error } = {}) {
  const sent: Array<{ text: string; delivery?: string }> = [];
  let released = 0;
  const payload = { status, activeTurn: status === 'running' ? { turnId: 'turn' } : null, pendingInteractions: [],
    capabilities: { sendMessage: true, queueMessage: options.queue ?? false, steer: true, cancel: true, history: true, readResource: false, interactions: { question: false, toolApproval: false, planApproval: false } },
    runtimeInfo: { connection: { state: 'connected' } } } as unknown as Payload;
  const lease = {
    agent: { snapshot: () => ({ payload }), sendMessage: async (text: string, value?: { delivery?: string }) => {
      if (options.refuse) throw options.refuse;
      sent.push({ text, ...(value?.delivery ? { delivery: value.delivery } : {}) });
    } },
    release: () => { released++; },
  } as unknown as RemoteHostSessionLease;
  return { lease, sent, released: () => released };
}
function access(sessions: Record<string, ReturnType<typeof session> | Error>, routes: Record<string, string> = {}): OutboxAccess & { acquired: string[] } {
  const acquired: string[] = [];
  return {
    acquired,
    available: () => true,
    route: target => ({ providerId: target.providerId, nativeSessionId: routes[target.nativeSessionId] ?? target.nativeSessionId }),
    async acquire(_providerId, nativeSessionId) {
      acquired.push(nativeSessionId);
      const value = sessions[nativeSessionId];
      if (!value) throw new Error('Session not found.');
      if (value instanceof Error) throw value;
      return value.lease;
    },
  };
}

it('delivers a waiting message as a new turn, settles it accepted and forgets its receipt', async () => {
  const file = await receiptsFile(), host = relay([message(1)]), thread = session('idle');
  const outbox = new SessionOutbox({ file, access: access({ thread }), request: call => host.request(call) });
  outbox.setAvailable(true);
  await outbox.idle();
  expect(thread.sent).toEqual([{ text: 'Message 1', delivery: 'immediate' }]);
  expect(host.settled).toEqual([{ id: uuid(1), outcome: 'accepted' }]);
  expect(host.entries.size).toBe(0);
  expect(thread.released()).toBe(1);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, receipts: {} });
  await outbox.close();
});

it('sends to the session that runs the conversation now, and waits for a running turn only when it cannot queue', async () => {
  const file = await receiptsFile();
  const host = relay([message(1, 'waiting', 'before'), message(2, 'waiting', 'busy')]);
  const after = session('idle'), busy = session('running', { queue: false });
  const outbox = new SessionOutbox({ file, access: access({ after, busy }, { before: 'after' }), request: call => host.request(call) });
  outbox.setAvailable(true);
  await outbox.idle();
  expect(after.sent).toEqual([{ text: 'Message 1', delivery: 'immediate' }]);
  // A running session that cannot queue keeps its message waiting, unclaimed, for a later pass.
  expect(busy.sent).toEqual([]);
  expect(host.entries.get(uuid(2))?.status).toBe('waiting');
  expect(busy.released()).toBe(1);
  await outbox.close();
  // One that can queue takes it as its next turn.
  const queued = session('running', { queue: true }), again = relay([message(3)]);
  const next = new SessionOutbox({ file, access: access({ thread: queued }), request: call => again.request(call) });
  next.setAvailable(true);
  await next.idle();
  expect(queued.sent).toEqual([{ text: 'Message 3', delivery: 'next_turn' }]);
  await next.close();
});

it('reports a message the session refused, or whose session is gone, as not delivered with the reason', async () => {
  const file = await receiptsFile();
  const host = relay([message(1, 'waiting', 'refusing'), message(2, 'waiting', 'gone')]);
  const refusing = session('idle', { refuse: new AgentOperationRejectedError('session_read_only', 'This session is read-only.') });
  const outbox = new SessionOutbox({ file, access: access({ refusing }), request: call => host.request(call) });
  outbox.setAvailable(true);
  await outbox.idle();
  expect(host.settled).toEqual([
    { id: uuid(1), outcome: 'rejected', error: 'This session is read-only.' },
    { id: uuid(2), outcome: 'rejected', error: 'Session not found.' },
  ]);
  await outbox.close();
});

it('never sends twice: a claim without a receipt, or one cut off mid-send, becomes unknown, and a lost settlement is repeated', async () => {
  const file = await receiptsFile();
  await mkdir(dirname(file), { recursive: true });
  // A previous run claimed 2 and was cut off while sending it; it had delivered 3 but lost the answer to its settlement.
  await writeFile(file, JSON.stringify({ version: 1, receipts: { [uuid(2)]: { status: 'dispatching' }, [uuid(3)]: { status: 'accepted' } } }));
  const host = relay([message(1, 'delivering'), message(2, 'delivering'), message(3, 'delivering')]);
  const thread = session('idle');
  const outbox = new SessionOutbox({ file, access: access({ thread }), request: call => host.request(call) });
  outbox.setAvailable(true);
  await outbox.idle();
  expect(thread.sent).toEqual([]);
  expect(host.settled).toEqual([
    { id: uuid(1), outcome: 'unknown', error: 'The Controller restarted while delivering this message. Check the conversation before sending it again.' },
    { id: uuid(2), outcome: 'unknown', error: 'The Controller restarted while delivering this message. Check the conversation before sending it again.' },
    { id: uuid(3), outcome: 'accepted' },
  ]);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, receipts: {} });
  await outbox.close();
});

it('keeps the outcome when its settlement fails and settles it on the next pass, polls again when woken, and stops when unavailable', async () => {
  const file = await receiptsFile(), host = relay([message(1)]), thread = session('idle');
  const outbox = new SessionOutbox({ file, access: access({ thread }), request: call => host.request(call), intervalMs: 60_000 });
  host.failNext('settle');
  outbox.setAvailable(true);
  await outbox.idle();
  expect(thread.sent).toHaveLength(1);
  expect(host.settled).toEqual([]);
  expect(JSON.parse(await readFile(file, 'utf8')).receipts).toEqual({ [uuid(1)]: { status: 'accepted' } });
  outbox.wake();
  await outbox.idle();
  expect(host.settled).toEqual([{ id: uuid(1), outcome: 'accepted' }]);
  expect(thread.sent).toHaveLength(1);
  // A message that arrives later is delivered when the Relay says so.
  host.entries.set(uuid(2), message(2));
  outbox.wake();
  await outbox.idle();
  expect(thread.sent.map(item => item.text)).toEqual(['Message 1', 'Message 2']);
  outbox.setAvailable(false);
  host.entries.set(uuid(3), message(3));
  const polls = host.calls.filter(call => call.action === 'poll').length;
  outbox.wake();
  await outbox.idle();
  expect(host.calls.filter(call => call.action === 'poll').length).toBe(polls);
  await outbox.close();
});
