import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { SESSION_DRAFT_BYTES, SESSION_DRAFT_LIMIT } from '@orchardworks/agent-remote-protocol';
import { decodeHostedSnapshot, encodeHostedSnapshot } from './record-codec.js';
import { createSessionDrafts, SessionDraftsError } from './session-drafts.js';
import { createRelayState, emptyRelayState, MAX_SESSION_DRAFTS, type HostedRelayState } from './state.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'session-draft-test-secret-0123456789' };
const ref = (nativeSessionId: string) => ({ hostId: 'host', providerId: 'codex', nativeSessionId });
function initialState(subjects = ['alice', 'bob']): HostedRelayState {
  const initial = emptyRelayState(auth);
  for (const subject of subjects) initial.tenants.push({ subject, namespace: createHash('sha256').update(JSON.stringify([auth.issuer, subject])).digest('hex'),
    broker: { keys: [], hosts: [], bindings: [], creations: [] } });
  return initial;
}
function fixture(initial = initialState()) {
  let saved = initial, commits = 0, clock = 1_000;
  const state = createRelayState(auth, { initial, async commit(value) { saved = structuredClone(value); commits++; } }, () => {}, () => {});
  return { state, drafts: createSessionDrafts(state, () => clock), saved: () => saved, commits: () => commits, advance: (ms: number) => { clock += ms; } };
}

it("keeps an account's draft per session with a revision that only grows", async () => {
  const f = fixture();
  expect(f.drafts.read('alice')).toEqual({ drafts: [] });
  expect(await f.drafts.save('alice', { ...ref('one'), text: 'Ship it' })).toEqual({ ...ref('one'), text: 'Ship it', revision: 1_000 });
  // Two saves within the same millisecond still order.
  expect(await f.drafts.save('alice', { ...ref('one'), text: 'Ship it today' })).toEqual({ ...ref('one'), text: 'Ship it today', revision: 1_001 });
  f.advance(500);
  // A cleared draft stays, empty, so devices that were away learn it.
  expect(await f.drafts.save('alice', { ...ref('one'), text: '' })).toEqual({ ...ref('one'), text: '', revision: 1_500 });
  expect(f.drafts.read('alice')).toEqual({ drafts: [{ ...ref('one'), text: '', revision: 1_500 }] });
  // Saving the same text writes nothing.
  const commits = f.commits();
  expect(await f.drafts.save('alice', { ...ref('one'), text: '' })).toEqual({ ...ref('one'), text: '', revision: 1_500 });
  expect(f.commits()).toBe(commits);
  // Another account sees none of them.
  expect(f.drafts.read('bob')).toEqual({ drafts: [] });
});

it('rejects malformed drafts and drafts over the byte bound', async () => {
  const f = fixture();
  for (const body of [undefined, {}, { ...ref('one') }, { ...ref('one'), text: 'x', extra: 1 }, { ...ref('one'), text: '草'.repeat(SESSION_DRAFT_BYTES / 2) }]) {
    await expect(f.drafts.save('alice', body)).rejects.toBeInstanceOf(SessionDraftsError);
  }
  expect(f.state.read().sessionDrafts).toBeUndefined();
});

it("keeps an account's drafts within its limit, letting cleared ones go first", async () => {
  const f = fixture();
  await f.drafts.save('alice', { ...ref('cleared'), text: '' });
  for (let index = 0; index < SESSION_DRAFT_LIMIT - 1; index++) { f.advance(1); await f.drafts.save('alice', { ...ref(`thread-${index}`), text: `Draft ${index}` }); }
  expect(f.drafts.read('alice').drafts).toHaveLength(SESSION_DRAFT_LIMIT);
  f.advance(1);
  await f.drafts.save('alice', { ...ref('newest'), text: 'Newest' });
  let kept = f.drafts.read('alice').drafts;
  expect(kept).toHaveLength(SESSION_DRAFT_LIMIT);
  expect(kept.some(draft => draft.nativeSessionId === 'cleared')).toBe(false);
  expect(kept.some(draft => draft.nativeSessionId === 'thread-0')).toBe(true);
  // Without cleared drafts, the oldest goes.
  f.advance(1);
  await f.drafts.save('alice', { ...ref('later'), text: 'Later' });
  kept = f.drafts.read('alice').drafts;
  expect(kept.some(draft => draft.nativeSessionId === 'thread-0')).toBe(false);
  expect(kept.some(draft => draft.nativeSessionId === 'later')).toBe(true);
});

it('refuses a new draft once the Relay keeps its most', async () => {
  const subjects = Array.from({ length: Math.ceil(MAX_SESSION_DRAFTS / SESSION_DRAFT_LIMIT) + 1 }, (_, index) => `account-${index}`);
  const f = fixture(initialState(subjects));
  let saved = 0;
  for (const subject of subjects) for (let index = 0; index < SESSION_DRAFT_LIMIT && saved < MAX_SESSION_DRAFTS; index++, saved++) {
    await f.drafts.save(subject, { ...ref(`thread-${index}`), text: 'Draft' });
  }
  const last = subjects.at(-1)!;
  await expect(f.drafts.save(last, { ...ref('one-more'), text: 'Draft' })).rejects.toMatchObject({ status: 409, code: 'drafts_limit' });
  // Changing a draft that exists still works.
  await expect(f.drafts.save('account-0', { ...ref('thread-0'), text: 'Changed' })).resolves.toMatchObject({ text: 'Changed' });
});

it('survives a restart through the stored records', async () => {
  const f = fixture();
  await f.drafts.save('alice', { ...ref('one'), text: 'Ship it' });
  const encoded = encodeHostedSnapshot(f.saved(), auth);
  const records = [...encoded.records.values()];
  const decoded = decodeHostedSnapshot(records.map(record => record.manifest), records.flatMap(record => record.chunks), auth);
  expect(createSessionDrafts(createRelayState(auth, { initial: decoded, async commit() {} }, () => {}, () => {})).read('alice')).toEqual({ drafts: [{ ...ref('one'), text: 'Ship it', revision: 1_000 }] });
});
