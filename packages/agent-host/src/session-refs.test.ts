import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { changeSessionRef, describeSessionRefs, SessionRefStore, type SessionRefContext } from './session-refs.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function context(source?: string) {
  const root = await mkdtemp(join(tmpdir(), 'arc-session-refs-'));
  roots.push(root);
  let removed = false;
  const titles = new Map([['side', 'Side'], ['source', 'Source'], ['other', 'Other']]);
  const value: SessionRefContext = {
    store: new SessionRefStore(join(root, 'session-refs.json')),
    async source() { return source ? { sourceNativeSessionId: source, removed } : undefined; },
    async setSourceRemoved(_holder, next) { const changed = removed !== next; removed = next; return changed; },
    async title(target) { return target.providerId === 'claude' ? titles.get(target.nativeSessionId) : undefined; },
  };
  return { value, path: join(root, 'session-refs.json'), removed: () => removed };
}
const side = { providerId: 'claude', nativeSessionId: 'side' };

it('lists the source first, removes and restores it like an added reference, and counts every change', async () => {
  const { value, removed } = await context('source');
  expect(await describeSessionRefs(side, value)).toEqual({ revision: 0, refs: [{ providerId: 'claude', nativeSessionId: 'source', origin: 'source', title: 'Source' }] });
  const added = await changeSessionRef(side, 'add', { providerId: 'claude', nativeSessionId: 'other' }, value);
  expect(added.refs.map(ref => [ref.nativeSessionId, ref.origin])).toEqual([['source', 'source'], ['other', 'added']]);
  const withoutSource = await changeSessionRef(side, 'remove', { providerId: 'claude', nativeSessionId: 'source' }, value);
  expect(removed()).toBe(true);
  expect(withoutSource).toMatchObject({ revision: 2, refs: [{ nativeSessionId: 'other', origin: 'added' }] });
  expect((await changeSessionRef(side, 'remove', { providerId: 'claude', nativeSessionId: 'source' }, value)).revision).toBe(2);
  const restored = await changeSessionRef(side, 'add', { providerId: 'claude', nativeSessionId: 'source' }, value);
  expect(removed()).toBe(false);
  expect(restored.revision).toBe(3);
  expect(restored.refs[0]).toMatchObject({ nativeSessionId: 'source', origin: 'source' });
});

it('rejects references to itself and to sessions the Host does not list, and keeps references across restarts', async () => {
  const { value, path } = await context();
  await expect(changeSessionRef(side, 'add', side, value)).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(changeSessionRef(side, 'add', { providerId: 'claude', nativeSessionId: 'missing' }, value)).rejects.toMatchObject({ code: 'session_not_found' });
  await expect(changeSessionRef(side, 'add', { providerId: 'codex', nativeSessionId: 'other' }, value)).rejects.toMatchObject({ code: 'session_not_found' });
  await changeSessionRef(side, 'add', { providerId: 'claude', nativeSessionId: 'other' }, value);
  expect(await describeSessionRefs(side, { ...value, store: new SessionRefStore(path) })).toMatchObject({ revision: 1, refs: [{ nativeSessionId: 'other' }] });
});
