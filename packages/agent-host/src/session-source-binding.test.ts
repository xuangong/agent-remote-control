import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import { SessionSuccessionStore } from './session-succession-store.js';
import { SessionSourceBindings } from './session-source-binding.js';
import { sourceSessionExtensions } from './session-reference.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });
const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'codex', nativeSessionId });
const workspace = { controllerId: 'host', canonicalCwd: '/workspace' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-source-binding-')); directories.push(directory);
  const store = new SessionSuccessionStore(directory); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace });
  const key = Buffer.alloc(32, 42);
  const resolver = new SessionSourceBindings(store, 'host', 'codex', key);
  let denied = '';
  const read = async (source: string, query: AgentHistoryQuery) => {
    if (source === denied) throw new Error('Source access revoked');
    return { entries: [{ id: `${source}:entry`, turnId: `${source}:turn`, role: 'assistant',
      text: `${source}:${query.cursor ?? 'first'}:${query.textOffset ?? 0}:${query.query ?? ''}:${query.turnId ?? ''}`,
      textOffset: query.textOffset ?? 0, totalChars: 10000 }], ...(query.cursor ? {} : { nextCursor: 'page-2' }) };
  };
  const tool = (target: string, original: string, bindings = resolver) => sourceSessionExtensions(original, read,
    query => bindings.read(target, original, query, read)).tools![0]!;
  async function commit(from = 'A', to = 'B', revision = 1) {
    const request = { roleId: 'role', operationId: `op-${revision}`, expectedRevision: revision, from: ref(from) };
    const participants = [{ relationId: 'ask', kind: 'ask' as const, before: ref('Q'), after: ref('Q') },
      { relationId: 'side', kind: 'side' as const, before: ref('S'), after: ref('S') }];
    const state = await store.setParticipants('role', revision, store.read('role').associationRevision, participants);
    await store.begin(request);
    await store.advance(request.operationId, 'preparing', { phase: 'quiescing', to: ref(to) });
    await store.advance(request.operationId, 'quiescing', { phase: 'transferring' });
    await store.advance(request.operationId, 'transferring', { phase: 'ready', prepared: {
      ...request, to: ref(to), associationRevision: state.associationRevision, workspace, participants,
      capture: { epoch: 'e', seq: 5, capturedAt: '2026-10-10T00:00:00.000Z' },
    } });
    await store.commit(request.operationId);
  }
  return { directory, store, resolver, tool, read, commit, key, deny: (id: string) => { denied = id; } };
}

test('an existing Ask tool follows committed successors without moving its native identity', async () => {
  const f = await fixture(), ask = f.tool('Q', 'A');
  expect(JSON.parse(await ask.execute({})).sourceSessionId).toBe('A');
  await f.commit();
  expect(JSON.parse(await ask.execute({}))).toMatchObject({ sourceSessionId: 'B', sourceRoleId: 'role', sourceRoleRevision: 2 });
  await f.commit('B', 'C', 2);
  expect(JSON.parse(await ask.execute({}))).toMatchObject({ sourceSessionId: 'C', sourceRoleRevision: 3 });
});

test('pins page cursors, long-text offsets and historical turn reads across succession', async () => {
  const f = await fixture(), ask = f.tool('Q', 'A');
  const page = JSON.parse(await ask.execute({ query: 'needle', limit: 1 }));
  await f.commit();
  const next = JSON.parse(await ask.execute({ cursor: page.nextCursor }));
  expect(next).toMatchObject({ sourceSessionId: 'A', entries: [{ text: 'A:page-2:0:needle:' }] });
  const offset = JSON.parse(await ask.execute({ sourceContext: page.sourceContext, query: 'needle', textOffset: 6000 }));
  expect(offset).toMatchObject({ sourceSessionId: 'A', entries: [{ text: 'A:first:6000:needle:' }] });
  const turn = JSON.parse(await ask.execute({ sourceContext: page.sourceContext, turnId: 'A:turn' }));
  expect(turn.sourceSessionId).toBe('A');
  await expect(ask.execute({ turnId: 'A:turn' })).rejects.toThrow(/context/i);
});

test('rejects tampering, cross-reader cursor reuse and query changes without reading another source', async () => {
  const f = await fixture(); await f.commit();
  const ask = f.tool('Q', 'A'), side = f.tool('S', 'A');
  const page = JSON.parse(await ask.execute({ query: 'needle' }));
  await expect(side.execute({ cursor: page.nextCursor })).rejects.toThrow(/cursor|context/i);
  await expect(ask.execute({ cursor: `${page.nextCursor}x` })).rejects.toThrow(/cursor|context/i);
  await expect(ask.execute({ cursor: page.nextCursor, query: 'other' })).rejects.toThrow(/query/i);
  await expect(ask.execute({ cursor: 'page-2' })).rejects.toThrow(/cursor/i);
  await expect(ask.execute({ sourceSessionId: 'unrelated' })).rejects.toThrow();
});

test('keeps unlinked readers and an Ask attached to Side scoped to their original source', async () => {
  const f = await fixture(); await f.commit();
  expect(JSON.parse(await f.tool('unlinked', 'A').execute({})).sourceSessionId).toBe('A');
  expect(JSON.parse(await f.tool('side-ask', 'S').execute({})).sourceSessionId).toBe('S');
});

test('rechecks source access and restores cursor bindings with persisted committed roles', async () => {
  const f = await fixture(); await f.commit();
  const page = JSON.parse(await f.tool('Q', 'A').execute({}));
  const restored = new SessionSuccessionStore(f.directory); await restored.ready;
  const bindings = new SessionSourceBindings(restored, 'host', 'codex', f.key);
  const ask = f.tool('Q', 'A', bindings);
  expect(JSON.parse(await ask.execute({ cursor: page.nextCursor })).sourceSessionId).toBe('B');
  f.deny('B');
  await expect(ask.execute({})).rejects.toThrow(/revoked/);
  await expect(ask.execute({ sourceContext: page.sourceContext })).rejects.toThrow(/revoked/);
});

test('newly linked readers follow the role and unlink takes effect without a second handoff', async () => {
  const f = await fixture(); await f.commit();
  const state = f.store.read('role');
  await f.store.setParticipants('role', 2, state.associationRevision, [
    ...state.participants.filter(item => item.relationId !== 'side'),
    { relationId: 'new-ask', kind: 'ask', before: ref('new-Q'), after: ref('new-Q') },
  ]);
  expect(JSON.parse(await f.tool('new-Q', 'B').execute({})).sourceRoleId).toBe('role');
  expect(JSON.parse(await f.tool('S', 'A').execute({})).sourceSessionId).toBe('A');
});

test('enrollment validates persisted grants including cold readers and excludes unlinked and nested readers', async () => {
  const f = await fixture();
  const grants = [{ nativeSessionId: 'cold-Q', sourceNativeSessionId: 'A' },
    { nativeSessionId: 'detached', sourceNativeSessionId: 'A' }, { nativeSessionId: 'nested', sourceNativeSessionId: 'S' }];
  await expect(f.resolver.enrollSources('role', 1, 0, [], grants)).rejects.toThrow(/incomplete/i);
  const relations = [{ relationId: 'cold', kind: 'ask' as const, nativeSessionId: 'cold-Q', sourceNativeSessionId: 'A', linked: true },
    { relationId: 'unlinked', kind: 'side' as const, nativeSessionId: 'detached', sourceNativeSessionId: 'A', linked: false }];
  await expect(f.resolver.enrollSources('role', 1, 0, [{ ...relations[0]!, sourceNativeSessionId: 'elsewhere' }, relations[1]!], grants)).rejects.toThrow(/grant/i);
  const state = await f.resolver.enrollSources('role', 1, 0, relations, grants);
  expect(state.participants).toEqual([{ relationId: 'cold', kind: 'ask', before: ref('cold-Q'), after: ref('cold-Q') }]);
  expect(state.associationRevision).toBe(1);
});

test('routes cross-provider successors by complete address and pins the original provider', async () => {
  const f = await fixture(); const old = await f.resolver.read('Q', 'A', {}, f.read);
  await f.commit();
  const state = f.store.read('role');
  const to = { ...ref('A'), providerId: 'claude' };
  const request = { operationId: 'cross', roleId: 'role', expectedRevision: 2, from: ref('B'), targetProviderId: 'claude' };
  await f.store.begin(request); await f.store.advance('cross', 'preparing', { phase: 'quiescing', to });
  await f.store.advance('cross', 'quiescing', { phase: 'transferring' });
  await f.store.advance('cross', 'transferring', { phase: 'ready', prepared: { ...request, to, workspace, participants: state.participants, associationRevision: state.associationRevision, capture: { epoch: 'e', seq: 3, capturedAt: '2026-10-10T00:00:00Z' } } });
  await f.store.commit('cross');
  await expect(f.resolver.read('Q', 'A', {}, f.read)).rejects.toThrow(/routed/i);
  const routed: string[] = [];
  const bindings = new SessionSourceBindings(f.store, 'host', 'codex', f.key, { readRouted: async (source, query) => { routed.push(source.providerId); return f.read(source.nativeSessionId, query); } });
  expect((await bindings.read('Q', 'A', {}, f.read)).sourceRef).toEqual(to);
  expect((await bindings.read('Q', 'A', { cursor: old.nextCursor }, f.read)).sourceRef).toEqual(ref('A'));
  expect(routed).toEqual(['claude', 'codex']);
});

test('attachment cursors remain pinned after materialization and authorize every actual read', async () => {
  const f = await fixture(); await f.commit();
  const { SessionSuccessionContextStore } = await import('./session-succession-context.js');
  const contexts = new SessionSuccessionContextStore(join(f.directory, 'contexts')); await contexts.ready;
  await contexts.attach({ operationId: 'op-1', roleId: 'role', roleRevision: 2, source: ref('A'), target: ref('B'), capturedAt: '2026-10-10T00:00:00Z', boundary: { epoch: 'e', seq: 5 }, text: '[{"role":"user","text":"captured old"}]', itemCount: 1 });
  let denied = false; let checks = 0;
  const bindings = new SessionSourceBindings(f.store, 'host', 'codex', f.key, { contexts, authorizeRead: async (_reader, source) => { checks++; expect(source).toEqual(ref('B')); if (denied) throw new Error('denied'); } });
  const pending = await bindings.read('Q', 'A', {}, f.read);
  expect(pending).toMatchObject({ sourceRepresentation: 'attachment', sourceProvenance: { source: ref('A') }, entries: [{ text: 'captured old' }] });
  await contexts.begin('op-1', { operationId: 'first', roleId: 'role', roleRevision: 2, target: ref('B'), text: 'new' });
  await contexts.settle('op-1', 'first', 'accepted');
  await contexts.reconcile('op-1', { operationId: 'first', target: ref('B'), roleRevision: 2, outcome: 'materialized', nativeEvidence: 'native-proof' });
  expect((await bindings.read('Q', 'A', {}, f.read)).sourceRepresentation).toBe('native');
  expect((await bindings.read('Q', 'A', { sourceContext: pending.sourceContext }, f.read)).entries[0]!.text).toBe('captured old');
  denied = true; await expect(bindings.read('Q', 'A', { sourceContext: pending.sourceContext }, f.read)).rejects.toThrow('denied'); expect(checks).toBe(7);
});

test('stored attachments require authorization and full reader identities cannot collide', async () => {
  const f = await fixture(); await f.commit();
  const { SessionSuccessionContextStore } = await import('./session-succession-context.js');
  const contexts = new SessionSuccessionContextStore(join(f.directory, 'contexts')); await contexts.ready;
  await contexts.attach({ operationId: 'op-1', roleId: 'role', roleRevision: 2, source: ref('A'), target: ref('B'), capturedAt: '2026-10-10T00:00:00Z', boundary: { epoch: 'e', seq: 5 }, text: '[{"role":"user","text":"old"}]', itemCount: 1 });
  const missingAuthorization = new SessionSourceBindings(f.store, 'host', 'codex', f.key, { contexts });
  await expect(missingAuthorization.read('Q', 'A', {}, f.read)).rejects.toThrow(/authorized/);
  const page = await f.resolver.read(ref('Q'), ref('A'), {}, f.read);
  await expect(f.resolver.read({ ...ref('Q'), providerId: 'claude' }, ref('A'), { sourceContext: page.sourceContext }, f.read)).rejects.toThrow(/another read/);
  await expect(f.resolver.read(ref('Q'), { ...ref('A'), controllerId: 'other' }, {}, f.read)).rejects.toThrow(/Controller/);
});

test('paginates captured rows and preserves raw history across another succession', async () => {
  const f = await fixture(); await f.commit();
  const { SessionSuccessionContextStore } = await import('./session-succession-context.js');
  const contexts = new SessionSuccessionContextStore(join(f.directory, 'contexts')); await contexts.ready;
  const raw = JSON.stringify([{ role: 'user', text: 'old needle' }, { role: 'assistant', text: 'x'.repeat(6500) }]);
  await contexts.attach({ operationId: 'op-1', roleId: 'role', roleRevision: 2, source: ref('A'), target: ref('B'), capturedAt: '2026-10-10T00:00:00Z', boundary: { epoch: 'e', seq: 5 }, text: raw, itemCount: 2 });
  const bindings = new SessionSourceBindings(f.store, 'host', 'codex', f.key, { contexts, authorizeRead: async () => {} });
  const first = await bindings.read('Q', 'A', { limit: 1 }, f.read);
  expect(first.entries[0]!.text.length).toBe(6000);
  expect((await bindings.read('Q', 'A', { sourceContext: first.sourceContext, textOffset: 6000, limit: 1 }, f.read)).entries[0]!.text.length).toBe(500);
  expect((await bindings.read('Q', 'A', { cursor: first.nextCursor }, f.read)).entries[0]!.text).toBe('old needle');
  await f.commit('B', 'C', 2);
  const previous = contexts.read('op-1');
  await contexts.attach({ operationId: 'op-2', roleId: 'role', roleRevision: 3, source: ref('B'), target: ref('C'), capturedAt: previous.capturedAt, boundary: previous.boundary, text: previous.text, itemCount: previous.itemCount });
  expect((await bindings.read('Q', 'A', { query: 'needle' }, f.read)).entries[0]!.text).toBe('old needle');
  expect((await bindings.read('Q', 'A', { cursor: first.nextCursor }, f.read)).sourceRef).toEqual(ref('B'));
  expect(contexts.read('op-2').text).toBe(raw);
});

test('a fixed current-B grant retains exact B attachment reads after unlink', async () => {
  const f = await fixture(); await f.commit();
  const { SessionSuccessionContextStore } = await import('./session-succession-context.js');
  const contexts = new SessionSuccessionContextStore(join(f.directory, 'fixed-b-contexts')); await contexts.ready;
  await contexts.attach({ operationId:'op-1',roleId:'role',roleRevision:2,source:ref('A'),target:ref('B'),capturedAt:'2026-10-10T00:00:00Z',boundary:{epoch:'e',seq:5},text:'[{"role":"user","text":"B attachment"}]',itemCount:1 });
  const bindings = new SessionSourceBindings(f.store,'host','codex',f.key,{contexts,authorizeRead:async()=>{}});
  await f.store.setParticipants('role',2,f.store.read('role').associationRevision,[{relationId:'fixed-B',kind:'side',before:ref('reader-B'),after:ref('reader-B')}]);
  const signed = await bindings.read('reader-B','B',{},f.read);
  await f.store.setParticipants('role',2,f.store.read('role').associationRevision,[]);
  expect((await bindings.read('reader-B','B',{sourceContext:signed.sourceContext},f.read)).entries[0]!.text).toBe('B attachment');
  expect((await bindings.read('reader-B','B',{},f.read)).entries[0]!.text).toBe('B attachment');
  await expect(bindings.read('reader-B','A',{sourceContext:signed.sourceContext},f.read)).rejects.toThrow();
});
