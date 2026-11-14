import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { OUTBOX_LIMIT } from '@orchardworks/agent-remote-protocol';
import { decodeHostedSnapshot, encodeHostedSnapshot } from './record-codec.js';
import { createSessionOutbox, OutboxError } from './session-outbox.js';
import { createRelayState, emptyRelayState, MAX_OUTBOX, type HostedRelayState } from './state.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'session-outbox-test-secret-0123456789' };
const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const message = (index: number, hostId = 'host') => ({ id: uuid(index), hostId, providerId: 'codex', nativeSessionId: 'thread', text: `Message ${index}` });
function initialState(subjects = ['alice', 'bob']): HostedRelayState {
  const initial = emptyRelayState(auth);
  for (const subject of subjects) initial.tenants.push({ subject, namespace: createHash('sha256').update(JSON.stringify([auth.issuer, subject])).digest('hex'),
    broker: { keys: [], hosts: [], bindings: [], creations: [] } });
  return initial;
}
function fixture(initial = initialState(), canQueue = (subject: string, hostId: string) => subject !== 'bob' && hostId !== 'old-host') {
  let saved = initial, clock = 1_000;
  const ready: string[] = [];
  const state = createRelayState(auth, { initial, async commit(value) { saved = structuredClone(value); } }, () => {}, () => {});
  const outbox = createSessionOutbox(state, { now: () => clock, canQueue, ready: hostId => { ready.push(hostId); } });
  return { state, outbox, ready, saved: () => saved, advance: (ms: number) => { clock += ms; } };
}

it("keeps an account's messages for its own Hosts, idempotent by ID, and tells a connected Host", async () => {
  const f = fixture();
  expect(f.outbox.list('alice')).toEqual({ entries: [] });
  const entry = await f.outbox.create('alice', message(1));
  expect(entry).toEqual({ ...message(1), createdAt: 1_000, status: 'waiting' });
  expect(f.ready).toEqual(['host']);
  // The same request again returns the same entry; a different one with the same ID is refused.
  f.advance(5);
  expect(await f.outbox.create('alice', message(1))).toEqual(entry);
  await expect(f.outbox.create('alice', { ...message(1), text: 'Changed' })).rejects.toMatchObject({ status: 409, code: 'outbox_conflict' });
  // Only for a Host of the account whose Controller delivers from the outbox.
  await expect(f.outbox.create('bob', message(2))).rejects.toMatchObject({ status: 403, code: 'outbox_unavailable' });
  await expect(f.outbox.create('alice', message(3, 'old-host'))).rejects.toMatchObject({ status: 403, code: 'outbox_unavailable' });
  for (const body of [undefined, {}, { ...message(4), text: '' }, { ...message(4), id: 'nope' }]) await expect(f.outbox.create('alice', body)).rejects.toBeInstanceOf(OutboxError);
  expect(f.outbox.list('alice').entries.map(item => item.id)).toEqual([uuid(1)]);
  expect(f.outbox.list('bob')).toEqual({ entries: [] });
});

it('bounds the outbox per account and in all', async () => {
  const f = fixture();
  for (let index = 0; index < OUTBOX_LIMIT; index++) await f.outbox.create('alice', message(index));
  await expect(f.outbox.create('alice', message(OUTBOX_LIMIT))).rejects.toMatchObject({ status: 409, code: 'outbox_full' });
  const subjects = Array.from({ length: MAX_OUTBOX / OUTBOX_LIMIT + 1 }, (_, index) => `account-${index}`);
  const g = fixture(initialState(subjects), () => true);
  let next = 0;
  for (const subject of subjects.slice(0, -1)) for (let index = 0; index < OUTBOX_LIMIT; index++) await g.outbox.create(subject, message(next++));
  await expect(g.outbox.create(subjects.at(-1)!, message(next))).rejects.toMatchObject({ status: 409, code: 'outbox_full' });
});

it('lets the owner cancel a message until its Controller takes it, and retry one that was not delivered', async () => {
  const f = fixture();
  await f.outbox.create('alice', message(1)); await f.outbox.create('alice', message(2));
  await f.outbox.cancel('alice', uuid(2));
  expect(f.outbox.list('alice').entries.map(item => item.id)).toEqual([uuid(1)]);
  await expect(f.outbox.cancel('alice', uuid(2))).rejects.toMatchObject({ status: 404, code: 'outbox_missing' });
  await expect(f.outbox.cancel('bob', uuid(1))).rejects.toMatchObject({ status: 404 });
  await f.outbox.hostCall('host', { action: 'claim', id: uuid(1) });
  await expect(f.outbox.cancel('alice', uuid(1))).rejects.toMatchObject({ status: 409, code: 'outbox_delivering' });
  await f.outbox.hostCall('host', { action: 'settle', id: uuid(1), outcome: 'rejected', error: 'The session is not on this Host.' });
  expect(f.outbox.list('alice').entries).toEqual([{ ...message(1), createdAt: 1_000, status: 'failed', error: 'The session is not on this Host.' }]);
  f.ready.length = 0;
  expect(await f.outbox.retry('alice', uuid(1))).toEqual({ ...message(1), createdAt: 1_000, status: 'waiting' });
  expect(f.ready).toEqual(['host']);
  await f.outbox.cancel('alice', uuid(1));
  expect(f.outbox.list('alice')).toEqual({ entries: [] });
});

it("gives a Controller its Host's messages to claim once and settle", async () => {
  const f = fixture();
  await f.outbox.create('alice', message(1)); await f.outbox.create('alice', message(2, 'other-host'));
  expect(await f.outbox.hostCall('host', { action: 'poll' })).toEqual({ entries: [{ id: uuid(1), providerId: 'codex', nativeSessionId: 'thread', text: 'Message 1', createdAt: 1_000, status: 'waiting' }] });
  expect(await f.outbox.hostCall('host', { action: 'claim', id: uuid(1) })).toMatchObject({ id: uuid(1), status: 'delivering' });
  expect(f.outbox.list('alice').entries.find(item => item.id === uuid(1))?.status).toBe('delivering');
  await expect(f.outbox.hostCall('host', { action: 'claim', id: uuid(1) })).rejects.toMatchObject({ status: 409, code: 'outbox_not_waiting' });
  // Another Host never sees or takes it.
  await expect(f.outbox.hostCall('other-host', { action: 'claim', id: uuid(1) })).rejects.toMatchObject({ status: 404 });
  // A delivering message is still in a poll, so a Controller that restarted can settle it.
  expect((await f.outbox.hostCall('host', { action: 'poll' }) as { entries: Array<{ status: string }> }).entries.map(item => item.status)).toEqual(['delivering']);
  await f.outbox.hostCall('host', { action: 'settle', id: uuid(1), outcome: 'accepted' });
  expect(f.outbox.list('alice').entries.map(item => item.id)).toEqual([uuid(2)]);
  // Settling again after a lost answer is harmless.
  await expect(f.outbox.hostCall('host', { action: 'settle', id: uuid(1), outcome: 'accepted' })).resolves.toEqual({ ok: true });
  // A claim whose outcome was lost becomes unknown, never sent again on its own.
  await f.outbox.create('alice', message(3));
  await f.outbox.hostCall('host', { action: 'claim', id: uuid(3) });
  await f.outbox.hostCall('host', { action: 'settle', id: uuid(3), outcome: 'unknown', error: 'Check the conversation before sending it again.' });
  expect(f.outbox.list('alice').entries.find(item => item.id === uuid(3))).toMatchObject({ status: 'unknown', error: 'Check the conversation before sending it again.' });
  expect((await f.outbox.hostCall('host', { action: 'poll' }) as { entries: unknown[] }).entries).toEqual([]);
  await expect(f.outbox.hostCall('host', { action: 'settle', id: uuid(3), outcome: 'accepted' })).rejects.toMatchObject({ status: 409 });
});

it('survives a restart through the stored records', async () => {
  const f = fixture();
  await f.outbox.create('alice', message(1));
  const encoded = encodeHostedSnapshot(f.saved(), auth);
  const records = [...encoded.records.values()];
  const decoded = decodeHostedSnapshot(records.map(record => record.manifest), records.flatMap(record => record.chunks), auth);
  const restarted = createSessionOutbox(createRelayState(auth, { initial: decoded, async commit() {} }, () => {}, () => {}), { canQueue: () => true, ready: () => {} });
  expect(restarted.list('alice')).toEqual({ entries: [{ ...message(1), createdAt: 1_000, status: 'waiting' }] });
});
