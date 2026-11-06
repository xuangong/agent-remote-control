import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { changeSessionRef, describeSessionRefs, pendingReferenceNote, SessionRefStore, type SessionRefContext } from './session-refs.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function context(grant?: string) {
  const root = await mkdtemp(join(tmpdir(), 'arc-session-refs-'));
  roots.push(root);
  let grantRemoved = false;
  const titles = new Map([['side', 'Side'], ['source', 'Source'], ['other', 'Other']]);
  const value: SessionRefContext = {
    store: new SessionRefStore(join(root, 'session-refs.json')),
    hostId: async () => 'host',
    async grantedSource(holder) { return grant && holder.nativeSessionId === 'side' ? { sourceNativeSessionId: grant, removed: grantRemoved } : undefined; },
    async setGrantRemoved(_holder, next) { grantRemoved = next; },
    async title(target) { return target.providerId === 'claude' ? titles.get(target.nativeSessionId) : undefined; },
  };
  return { value, path: join(root, 'session-refs.json'), grantRemoved: () => grantRemoved };
}
const side = { providerId: 'claude', nativeSessionId: 'side' };
const source = { providerId: 'claude', nativeSessionId: 'source' };

it('adopts a Side\'s granted source, removes and restores it like an added reference, and counts every change', async () => {
  const { value, grantRemoved } = await context('source');
  expect(await describeSessionRefs(side, value)).toEqual({ revision: 0, refs: [{ ...source, origin: 'source', title: 'Source' }], referencedBy: [] });
  // A Side's agent knows its source from its instructions.
  expect(await pendingReferenceNote(side, value)).toBeUndefined();
  expect(await describeSessionRefs(source, value)).toMatchObject({ referencedBy: [{ ...side, origin: 'source', title: 'Side' }] });
  const added = await changeSessionRef(side, 'add', { providerId: 'claude', nativeSessionId: 'other' }, value);
  expect(added.refs.map(ref => [ref.nativeSessionId, ref.origin])).toEqual([['source', 'source'], ['other', 'added']]);
  const withoutSource = await changeSessionRef(side, 'remove', source, value);
  expect(grantRemoved()).toBe(true);
  expect(withoutSource).toMatchObject({ revision: 2, refs: [{ nativeSessionId: 'other', origin: 'added' }] });
  expect((await describeSessionRefs(source, value)).referencedBy).toEqual([]);
  expect((await changeSessionRef(side, 'remove', source, value)).revision).toBe(2);
  expect(await pendingReferenceNote(side, value)).toEqual({ revision: 2, references: [{ address: 'host/claude/other', title: 'Other', origin: 'added' }] });
  await value.store.markDelivered(side, 2);
  expect(await pendingReferenceNote(side, value)).toBeUndefined();
  const restored = await changeSessionRef(side, 'add', source, value);
  expect(grantRemoved()).toBe(false);
  expect(restored.revision).toBe(3);
  expect(restored.refs[0]).toMatchObject({ nativeSessionId: 'source', origin: 'source' });
});

it('tells a session about a source it was not created with, and keeps references across restarts', async () => {
  const { value, path } = await context();
  await expect(changeSessionRef(side, 'add', side, value)).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(changeSessionRef(side, 'add', { providerId: 'claude', nativeSessionId: 'missing' }, value)).rejects.toMatchObject({ code: 'session_not_found' });
  await expect(changeSessionRef(side, 'add', { providerId: 'codex', nativeSessionId: 'other' }, value)).rejects.toMatchObject({ code: 'session_not_found' });
  await value.store.setSource(side, source, { tell: true });
  expect(await pendingReferenceNote(side, value)).toEqual({ revision: 1, references: [{ address: 'host/claude/source', title: 'Source', origin: 'source' }] });
  await changeSessionRef(side, 'add', { providerId: 'claude', nativeSessionId: 'other' }, value);
  expect(await describeSessionRefs(side, { ...value, store: new SessionRefStore(path) })).toMatchObject({ revision: 2, refs: [{ nativeSessionId: 'source' }, { nativeSessionId: 'other' }] });
});
