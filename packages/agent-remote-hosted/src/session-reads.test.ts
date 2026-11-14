import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { SESSION_READ_LIMIT } from '@orchardworks/agent-remote-protocol';
import { decodeHostedSnapshot, encodeHostedSnapshot } from './record-codec.js';
import { createSessionReads, SessionReadsError } from './session-reads.js';
import { createRelayState, emptyRelayState, type HostedRelayState } from './state.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'session-read-test-secret-0123456789' };
const thread = (nativeSessionId: string, readAt: number) => ({ hostId: 'host', providerId: 'codex', nativeSessionId, readAt });
function initialState(): HostedRelayState {
  const initial = emptyRelayState(auth);
  for (const subject of ['alice', 'bob']) initial.tenants.push({ subject, namespace: createHash('sha256').update(JSON.stringify([auth.issuer, subject])).digest('hex'),
    broker: { keys: [], hosts: [], bindings: [], creations: [] } });
  return initial;
}
function fixture(initial = initialState()) {
  let saved = initial, commits = 0, clock = 1_000;
  const state = createRelayState(auth, { initial, async commit(value) { saved = structuredClone(value); commits++; } }, () => {}, () => {});
  return { state, reads: createSessionReads(state, () => clock), saved: () => saved, commits: () => commits, advance: (ms: number) => { clock += ms; } };
}

it('starts keeping positions on the first request and only ever advances them', async () => {
  const f = fixture();
  expect(f.reads.read('alice')).toEqual({ reads: [] });
  expect(await f.reads.mark('alice', { reads: [] })).toEqual({ since: 1_000, reads: [] });
  f.advance(500);
  await f.reads.mark('alice', { reads: [thread('one', 5), thread('two', 9)] });
  await f.reads.mark('alice', { reads: [thread('one', 3), thread('two', 12)] });
  expect(f.reads.read('alice')).toEqual({ since: 1_000, reads: [thread('one', 5), thread('two', 12)] });
  // Another account sees none of them and starts its own.
  expect(f.reads.read('bob')).toEqual({ reads: [] });
  expect(await f.reads.mark('bob', { reads: [thread('one', 1)] })).toEqual({ since: 1_500, reads: [thread('one', 1)] });
  // A request that advances nothing writes nothing.
  const commits = f.commits();
  await f.reads.mark('alice', { reads: [thread('one', 5)] });
  expect(f.commits()).toBe(commits);
});

it('rejects malformed requests', async () => {
  const f = fixture();
  for (const body of [undefined, {}, { reads: [{ ...thread('one', 1), readAt: -1 }] }, { reads: [thread('one', 1)], extra: 1 }]) {
    await expect(f.reads.mark('alice', body)).rejects.toBeInstanceOf(SessionReadsError);
  }
  expect(f.state.read().sessionReads).toBeUndefined();
});

it("keeps an account's most recent positions within its limit", async () => {
  const f = fixture();
  for (let start = 0; start <= SESSION_READ_LIMIT; start += 256) {
    await f.reads.mark('alice', { reads: Array.from({ length: Math.min(256, SESSION_READ_LIMIT + 1 - start) }, (_, index) => thread(`thread-${start + index}`, start + index + 1)) });
  }
  const kept = f.reads.read('alice').reads;
  expect(kept).toHaveLength(SESSION_READ_LIMIT);
  expect(kept.some(read => read.nativeSessionId === 'thread-0')).toBe(false);
  expect(kept.some(read => read.nativeSessionId === `thread-${SESSION_READ_LIMIT}`)).toBe(true);
});

it('survives a restart through the stored records', async () => {
  const f = fixture();
  await f.reads.mark('alice', { reads: [thread('one', 5)] });
  const encoded = encodeHostedSnapshot(f.saved(), auth);
  const records = [...encoded.records.values()];
  const decoded = decodeHostedSnapshot(records.map(record => record.manifest), records.flatMap(record => record.chunks), auth);
  expect(createSessionReads(createRelayState(auth, { initial: decoded, async commit() {} }, () => {}, () => {})).read('alice')).toEqual({ since: 1_000, reads: [thread('one', 5)] });
});
