// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clearConversationRecovery } from './conversation-recovery.js';
import { readSessionComposition, saveSessionComposition, type SessionComposition } from './session-composition.js';
import type { OpenedSession } from './directory-client.js';
import { sessionKey } from './session-tree.js';
import { clearCacheOnClose } from './conversation-storage.js';

const source: OpenedSession = { hostId: 'desk', providerId: 'codex', nativeSessionId: 'main', agentId: 'old-main-binding', title: 'Main' };
const side: OpenedSession = { ...source, nativeSessionId: 'side', agentId: 'old-side-binding', title: 'Side' };
const sourceKey = '["desk","codex","main"]';
const sideKey = '["desk","codex","side"]';
const storageKey = (scope: string) => `agent-remote:recovery:${scope}:composition`;
const composition = (): SessionComposition => ({ path: [source, side], focus: sideKey, anchor: sideKey, addressKey: sideKey });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureImageDraftPersistence(() => !clearCacheOnClose());
  clearConversationRecovery();
  sessionStorage.clear(); localStorage.clear();
});

it('restores the saved side address and preserves old bindings only as metadata', () => {
  saveSessionComposition('alice', composition());
  expect(readSessionComposition('alice', side)).toEqual({
    path: [source, side], focus: sideKey, anchor: sideKey, addressKey: sideKey,
  });
  expect(localStorage.getItem(storageKey('alice'))).toBeNull();
});

it('does not replace another explicit link or another workspace with the saved composition', () => {
  saveSessionComposition('alice', composition());
  expect(readSessionComposition('alice', source)).toBeUndefined();
  expect(readSessionComposition('alice', { ...side, nativeSessionId: 'other' })).toBeUndefined();
  expect(readSessionComposition('bob', side)).toBeUndefined();
  expect(readSessionComposition('alice', undefined)).toBeUndefined();
  expect(readSessionComposition('alice', { hostId: 'desk', providerId: 'codex' })).toBeUndefined();
});

it('replaces the full path after the side is closed instead of reviving its old selection', () => {
  saveSessionComposition('alice', composition());
  saveSessionComposition('alice', { path: [source], focus: sourceKey, anchor: sourceKey, addressKey: sourceKey });
  expect(readSessionComposition('alice', source)).toEqual({ path: [source], focus: sourceKey, anchor: sourceKey, addressKey: sourceKey });
  expect(readSessionComposition('alice', side)).toBeUndefined();
});

it('keeps Host and Provider identity separate even when native IDs and old bindings match', () => {
  const otherHost = { ...source, hostId: 'laptop' };
  saveSessionComposition('alice', { path: [source, otherHost], addressKey: '["laptop","codex","main"]' });
  expect(readSessionComposition('alice', otherHost)?.path).toEqual([source, otherHost]);
  expect(readSessionComposition('alice', source)).toBeUndefined();
  expect(readSessionComposition('alice', { ...otherHost, providerId: 'claude' })).toBeUndefined();
});

it('keeps sessions from different Providers distinct within a saved path', () => {
  const otherProvider = { ...source, providerId: 'claude' };
  saveSessionComposition('alice', { path: [source, otherProvider], addressKey: '["desk","claude","main"]' });
  expect(readSessionComposition('alice', otherProvider)?.path).toEqual([source, otherProvider]);
});

it('normalizes an omitted local Host only for identity matching', () => {
  const local = { providerId: 'codex', nativeSessionId: 'main', agentId: 'old-local-binding', title: 'Local' };
  saveSessionComposition('alice', { path: [local], addressKey: '["local","codex","main"]' });
  expect(readSessionComposition('alice', { ...local, hostId: 'local' })?.path).toEqual([local]);
});

it('persists only session metadata and snapshots it before the queued write', () => {
  const entry = { ...source, parentAgentId: 'old-parent-binding', parentNativeSessionId: 'parent', createdAt: '2026-10-08T00:00:00Z', secret: 'discard', timeline: ['discard'] };
  const value = { path: [entry], addressKey: sourceKey, draft: 'discard' };
  saveSessionComposition('alice', value);
  entry.title = 'Changed after saving';
  const restored = readSessionComposition('alice', source);
  expect(restored).toEqual({ path: [{ ...source, parentAgentId: 'old-parent-binding', parentNativeSessionId: 'parent', createdAt: '2026-10-08T00:00:00Z' }], addressKey: sourceKey });
  expect(sessionStorage.getItem(storageKey('alice'))).not.toContain('discard');
});

it('does not expose extra fields from an otherwise valid stored composition', () => {
  sessionStorage.setItem(storageKey('alice'), JSON.stringify({ path: [{ ...source, secret: 'discard', timeline: ['discard'] }], addressKey: sourceKey, draft: 'discard' }));
  expect(readSessionComposition('alice', source)).toEqual({ path: [source], addressKey: sourceKey });
});

it.each([
  ['invalid JSON', '{'],
  ['non-object', 'null'],
  ['missing path', JSON.stringify({ addressKey: sourceKey })],
  ['non-array path', JSON.stringify({ path: source, addressKey: sourceKey })],
  ['empty path', JSON.stringify({ path: [], addressKey: sourceKey })],
  ['null session', JSON.stringify({ path: [null], addressKey: sourceKey })],
  ['invalid binding metadata', JSON.stringify({ path: [{ ...source, agentId: false }], addressKey: sourceKey })],
  ['invalid title metadata', JSON.stringify({ path: [{ ...source, title: [] }], addressKey: sourceKey })],
  ['empty Provider identity', JSON.stringify({ path: [{ ...source, providerId: '' }], addressKey: sourceKey })],
  ['missing native identity', JSON.stringify({ path: [{ ...source, nativeSessionId: undefined }], addressKey: sourceKey })],
  ['empty native identity', JSON.stringify({ path: [{ ...source, nativeSessionId: '' }], addressKey: sourceKey })],
  ['invalid Host', JSON.stringify({ path: [{ ...source, hostId: 3 }], addressKey: sourceKey })],
  ['invalid optional metadata', JSON.stringify({ path: [{ ...source, parentNativeSessionId: false }], addressKey: sourceKey })],
  ['repeated native identity', JSON.stringify({ path: [source, { ...source, agentId: 'new-binding' }], addressKey: sourceKey })],
  ['cyclic selected path', JSON.stringify({ path: [source, side, source], addressKey: sideKey })],
  ['focus outside the path', JSON.stringify({ ...composition(), focus: 'another-session' })],
  ['anchor outside the path', JSON.stringify({ ...composition(), anchor: 'another-session' })],
  ['address outside the path', JSON.stringify({ path: [source], addressKey: sideKey })],
])('ignores corrupt composition data: %s', (_name, saved) => {
  sessionStorage.setItem(storageKey('alice'), saved);
  expect(readSessionComposition('alice', source)).toBeUndefined();
  expect(readSessionComposition('alice', side)).toBeUndefined();
});

it('accepts a bounded path and rejects an oversized saved path', () => {
  const path = Array.from({ length: 100 }, (_, index) => ({ ...source, nativeSessionId: `session-${index}` }));
  saveSessionComposition('alice', { path, addressKey: '["desk","codex","session-0"]' });
  expect(readSessionComposition('alice', path[0])?.path).toHaveLength(100);
  sessionStorage.setItem(storageKey('alice'), JSON.stringify({ path: [...path, side], addressKey: '["desk","codex","session-0"]' }));
  expect(readSessionComposition('alice', path[0])).toBeUndefined();
});

it('clears stored and queued compositions only for the signed-out workspace', () => {
  saveSessionComposition('alice', composition());
  expect(readSessionComposition('alice', side)).toBeDefined();
  saveSessionComposition('alice', { path: [source], addressKey: sourceKey });
  saveSessionComposition('bob', composition());
  sessionStorage.setItem('unrelated', 'keep');
  clearConversationRecovery('alice');
  window.dispatchEvent(new Event('pagehide'));
  expect(readSessionComposition('alice', source)).toBeUndefined();
  expect(readSessionComposition('alice', side)).toBeUndefined();
  expect(readSessionComposition('bob', side)).toBeDefined();
  expect(sessionStorage.getItem('unrelated')).toBe('keep');
});

it('leaves ordinary session navigation usable when browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Full'); });
  expect(() => saveSessionComposition('alice', composition())).not.toThrow();
  expect(readSessionComposition('alice', side)).toBeUndefined();
  expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
});


import { webcrypto } from 'node:crypto';
import type { SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument, readCompositionDocument, saveCompositionDocument, createRoleCheckpoint, compositionRoleKey,
  SuccessionApplication, adoptLegacySlot, retainCompositionDraftViews, applyCompositionTrack, readTrackCompanion, type CompositionDocument, type CompositionSlot } from './session-composition.js';
import { flushRecoveryWrites } from './recovery-writes.js';
import { DraftStore } from './draft-store.js';
import { TrackedSessionViews } from './tracked-session-views.js';
import { saveTrackedSessions, readTrackedSessions } from './tracking-state.js';
import { configureImageDraftPersistence, writeImageDraft, readImageDraft } from '@orchardworks/agent-remote-web/browser';
const nativeRef = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'codex', nativeSessionId });
const replayCommit = (from = 'A', to = 'B', expectedRevision = 1): SessionSuccessionReplay => {
  const workspace = { controllerId: 'installation', canonicalCwd: '/workspace' };
  const request = { operationId: `operation-${expectedRevision}`, roleId: 'role', expectedRevision, from: nativeRef(from) };
  return { version: 1, from: { hostId: 'host', providerId: 'codex', nativeSessionId: from }, to: { hostId: 'host', providerId: 'codex', nativeSessionId: to },
    projection: { version: 1, role: { id: 'role', revision: expectedRevision + 1, origin: nativeRef('A'), current: nativeRef(to), workspace }, receipt: { ...request, to: nativeRef(to), phase: 'committed', committedRevision: expectedRevision + 1, startedAt: 'now', updatedAt: 'now',
      prepared: { ...request, to: nativeRef(to), workspace, associationRevision: 1, participants: [], capture: { epoch: 'epoch', seq: 1, capturedAt: 'now' } } } } };
};
const ownedSlot = (id: string, native = id): CompositionSlot => ({ id, intent: { kind: 'fixed', target: { hostId: 'host', native: nativeRef(native) } },
  owners: { text: { scope: 'scope', key: `text-${id}` }, image: { scope: 'scope', key: `image-${id}` }, display: { scope: 'scope', key: `display-${id}` } } });
const makeDocument = (): CompositionDocument => createCompositionDocument('scope', [ownedSlot('A'), ownedSlot('B')]);
const authority = () => ({ scope: 'scope', hostId: 'host', controllerId: 'installation', isCurrent: () => true });
async function saveDocument(document: CompositionDocument) { const handle = saveCompositionDocument(document, () => true); flushRecoveryWrites(); return handle.completion; }

it('persists compact exact checkpoints without receipt bodies and hashes canonical projection content', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const commit = replayCommit(); const checkpoint = await createRoleCheckpoint('scope', commit);
  const reordered = { to: commit.to, projection: { receipt: commit.projection.receipt, role: commit.projection.role, version: 1 as const }, from: commit.from, version: 1 as const };
  expect((await createRoleCheckpoint('scope', reordered)).desired.projectionDigest).toEqual(checkpoint.desired.projectionDigest);
  const document = makeDocument(); document.roles.push(checkpoint);
  expect((await saveDocument(document)).status).toBe('saved');
  const raw = sessionStorage.getItem('agent-remote:recovery:scope:composition-v1')!;
  expect(raw).not.toContain('participants'); expect(raw).not.toContain('prepared'); expect(raw).not.toContain('authorityKey');
  expect(readCompositionDocument('scope')).toMatchObject({ status: 'ready', document: { roles: [{ desired: { from: nativeRef('A'), to: nativeRef('B') } }] } });
});
it('refuses unsupported metadata and independent count and UTF-8 byte overflow without replacing original state', async () => {
  const key = 'agent-remote:recovery:scope:composition-v1';
  sessionStorage.setItem(key, '{"version":9}');
  expect(readCompositionDocument('scope').status).toBe('unsupported');
  expect((await saveDocument(makeDocument())).status).toBe('failed'); expect(sessionStorage.getItem(key)).toBe('{"version":9}');
  sessionStorage.removeItem(key);
  const document = createCompositionDocument('scope', Array.from({ length: 1024 }, (_, index) => ownedSlot(`slot-${index}`)));
  expect((await saveDocument(document)).status).toBe('saved'); const original = sessionStorage.getItem(key);
  document.slots.push(ownedSlot('overflow')); document.editRevision++;
  expect((await saveDocument(document)).status).toBe('failed'); expect(sessionStorage.getItem(key)).toBe(original);
  const wide = makeDocument(); wide.editRevision = document.editRevision + 1; wide.slots[0]!.owners.text.key = '界'.repeat(400000);
  expect((await saveDocument(wide)).status).toBe('failed'); expect(sessionStorage.getItem(key)).toBe(original);
});
it('keeps stable A and independent B owners across A to B to C and rejects changed exact receipts', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const applied: string[] = [];
  const apply = async () => ({ status: 'applied' as const, retention: 'session' as const });
  const application = new SuccessionApplication(makeDocument(), authority(), { track: apply, ask: apply, draftViews: async () => { applied.push('retained'); return apply(); } });
  expect((await application.apply(replayCommit())).status).toBe('applied');
  expect(application.document.slots[0]).toMatchObject({ id: 'A', intent: { kind: 'role', target: { native: nativeRef('B') } }, owners: ownedSlot('A').owners });
  expect(application.document.slots[1]).toEqual(ownedSlot('B'));
  expect(application.document.retained).toEqual([{ slot: 'B', against: 'A' }]);
  expect((await application.apply(replayCommit('B', 'C', 2))).status).toBe('applied');
  expect(application.document.slots[0]!.intent).toMatchObject({ target: { native: nativeRef('C') } });
  const changed = replayCommit('B', 'C', 2); changed.projection.receipt.updatedAt = 'changed';
  expect((await application.apply(changed)).status).toBe('conflict');
  expect(application.document.slots[0]!.owners).toEqual(ownedSlot('A').owners);
  expect(applied).toHaveLength(2);
});
it('keeps desired intent in memory after checkpoint failure and runs no participant until current retention exists', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const participant = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const application = new SuccessionApplication(makeDocument(), authority(), { track: participant, ask: participant, draftViews: participant });
  const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied'); });
  expect((await application.apply(replayCommit())).status).toBe('failed');
  expect(application.document.slots[0]!.intent).toMatchObject({ target: { native: nativeRef('B') } });
  expect(participant).not.toHaveBeenCalled();
  denied.mockRestore();
  expect((await application.apply(replayCommit())).status).toBe('applied');
});
it('keeps latest authorized C desired when recovery cannot retain intermediate B work', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const participant = vi.fn(async () => ({ status: 'failed' as const, retention: 'page' as const }));
  const application = new SuccessionApplication(makeDocument(), authority(), { track: participant, ask: participant, draftViews: participant });
  const b = replayCommit(), c = replayCommit('B', 'C', 2);
  const result = await application.recover('role', { fetchSessionSuccessionOperation: async () => undefined,
    fetchSessionSuccessionCurrent: async () => ({ version: 1, role: c.projection.role, locator: c.to }),
    fetchSessionSuccessions: async () => ({ version: 1, successions: [b, c], nextCursor: null }) });
  expect(result.status).toBe('failed');
  expect(application.document.slots[0]!.intent).toMatchObject({ kind: 'role', target: { native: nativeRef('C') } });
  expect(application.document.retained).toContainEqual({ slot: 'B', against: 'A' });
  expect(application.document.roles[0]!.desired.committedRevision).toBe(3);
});
it('retains real legacy A and B text/image owners before deduplicating Track and navigation', async () => {
  vi.stubGlobal('crypto', webcrypto); configureImageDraftPersistence(() => false);
  const nativeA = { hostId: 'host', providerId: 'codex', nativeSessionId: 'A', agentId: 'runtime-A', title: 'A' };
  const nativeB = { ...nativeA, nativeSessionId: 'B', agentId: 'runtime-B', title: 'B' };
  const slots = [adoptLegacySlot('A', nativeA, 'scope', sessionKey(nativeA)), adoptLegacySlot('B', nativeB, 'scope', sessionKey(nativeB))];
  const document = createCompositionDocument('scope', slots); document.edges = [{ source: 'A', target: 'B', selected: true }];
  const drafts = new DraftStore('scope'); drafts.set('runtime-A', 'A text'); drafts.set('runtime-B', 'B text');
  for (const slot of slots) await writeImageDraft({ version: 1, ...slot.owners.image, parts: [{ type: 'image', imageId: slot.id, label: `image ${slot.id}` }],
    images: { [slot.id]: { imageId: slot.id, blob: new Blob([`${slot.id} bytes`], { type: 'image/png' }), uploadId: slot.id, status: 'pending', progress: 0 } }, nextLabel: 2 });
  saveTrackedSessions('scope', [{ ...nativeA, starredAt: 1 }, { ...nativeB, starredAt: 2 }]);
  const views = new TrackedSessionViews(); views.remember({ primary: nativeA, selections: {} }, [nativeA, nativeB], [nativeA, nativeB]);
  const ask = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const application = new SuccessionApplication(document, authority(), { draftViews: context => retainCompositionDraftViews(context, () => drafts),
    track: context => applyCompositionTrack(context, views), ask });
  const denied = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
    if (key.endsWith(':view:' + sessionKey(nativeB))) throw new Error('Unknown B display');
    return originalGet.call(this, key);
  });
  expect((await application.apply(replayCommit())).status).toBe('failed');
  expect(document.edges).toHaveLength(1); expect(readTrackedSessions('scope')).toHaveLength(2); expect(ask).not.toHaveBeenCalled();
  denied.mockRestore();
  expect((await application.apply(replayCommit())).status).toBe('applied');
  expect(document.retained).toEqual([{ slot: 'B', against: 'A' }]); expect(document.slots[1]).toEqual(slots[1]);
  expect(drafts.get('runtime-A')).toBe('A text'); expect(drafts.get('runtime-B')).toBe('B text');
  expect((await readImageDraft(slots[0]!.owners.image.key))?.images.A?.blob?.size).toBe(7);
  expect((await readImageDraft(slots[1]!.owners.image.key))?.images.B?.blob?.size).toBe(7);
  expect(readTrackedSessions('scope')).toMatchObject([{ entryId: 'A', nativeSessionId: 'B', title: 'A' }]);
  expect(readTrackCompanion('scope')).toMatchObject({ status: 'ready', document: { entries: [{ entryId: 'A', slotId: 'A' }] } });
  expect(document.edges).toEqual([]);
});
const originalGet = Storage.prototype.getItem;

it('persists an incomplete marker when revalidating an applied revision fails, then retries', async () => {
  vi.stubGlobal('crypto', webcrypto);
  let denied = false;
  const success = async () => ({ status: 'applied' as const, retention: 'session' as const });
  const application = new SuccessionApplication(makeDocument(), authority(), { track: success, ask: success,
    draftViews: async () => denied ? { status: 'failed', retention: 'page', code: 'owner_unreadable' } : success() });
  expect((await application.apply(replayCommit())).status).toBe('applied');
  denied = true;
  expect(await application.apply(replayCommit())).toMatchObject({ status: 'failed', code: 'owner_unreadable' });
  expect(application.document.roles[0]!.appliedRevision).toBeLessThan(2);
  expect(readCompositionDocument('scope')).toMatchObject({ status: 'ready', document: { roles: [{ appliedRevision: 1, documents: { draftViews: { status: 'failed' } } }] } });
  denied = false;
  expect((await application.apply(replayCommit())).status).toBe('applied');
});

it('keeps independent B Track and navigation reachable until Ask retention succeeds', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument(); document.edges = [{ source: 'A', target: 'B', selected: true }];
  const a = { hostId: 'host', providerId: 'codex', nativeSessionId: 'A', title: 'Track A', starredAt: 1 };
  const b = { ...a, nativeSessionId: 'B', title: 'Track B', starredAt: 2 };
  saveTrackedSessions('scope', [a, b]);
  const views = new TrackedSessionViews();
  let retained = false;
  const application = new SuccessionApplication(document, authority(), { draftViews: async () => ({ status: 'applied', retention: 'session' }),
    track: context => applyCompositionTrack(context, views), ask: async () => retained ? { status: 'applied', retention: 'session' } : { status: 'failed', retention: 'page', code: 'B_ask_unreadable' } });
  expect((await application.apply(replayCommit())).status).toBe('failed');
  expect(readTrackedSessions('scope').map(value => value.nativeSessionId)).toEqual(['A', 'B']);
  expect(document.edges).toEqual([{ source: 'A', target: 'B', selected: true }]);
  expect(document.retained).toEqual([{ slot: 'B', against: 'A' }]);
  retained = true;
  expect((await application.apply(replayCommit())).status).toBe('applied');
  expect(readTrackedSessions('scope')).toMatchObject([{ entryId: 'A', nativeSessionId: 'B', title: 'Track A' }]);
  expect(document.edges).toEqual([]);
});

import { saveTrackCompanion, saveAskOwnerIndex, readAskOwnerIndex, createHistorySlot, type TrackCompanionDocument, type AskOwnerIndexDocument } from './session-composition.js';
const askIndex = (count = 1): AskOwnerIndexDocument => ({ version: 1, scope: 'scope', editRevision: 0,
  owners: Array.from({ length: count }, (_, i) => ({ id: `ask-${i}`, sourceSlot: `slot-${i}`, stateScope: 'scope', legacySourceKey: `legacy-${i}`, geometryScope: `geometry-${i}`, text: { scope: 'scope:ask', key: `draft-${i}` } })) });
const trackCompanion = (count = 1): TrackCompanionDocument => ({ version: 1, scope: 'scope', editRevision: 0,
  entries: Array.from({ length: count }, (_, i) => ({ entryId: `entry-${i}`, slotId: `slot-${i}` })), views: [] });
async function completeWrite(handle: ReturnType<typeof saveCompositionDocument>) { flushRecoveryWrites(); return handle.completion; }

it('independently enforces 1024 Ask owners, 128 roles and eight tracked entries without truncation', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const ask = askIndex(1024), track = trackCompanion(8), document = makeDocument();
  const role = await createRoleCheckpoint('scope', replayCommit());
  document.roles = Array.from({ length: 128 }, (_, i) => ({ ...role, roleId: `role-${i}` }));
  expect((await completeWrite(saveAskOwnerIndex(ask, () => true))).status).toBe('saved');
  expect((await completeWrite(saveTrackCompanion(track, () => true))).status).toBe('saved');
  expect((await saveDocument(document)).status).toBe('saved');
  const original = ['ask-owners-v1', 'track-views-v1', 'composition-v1'].map(name => sessionStorage.getItem(`agent-remote:recovery:scope:${name}`));
  ask.owners.push({ ...ask.owners[0]!, id: 'overflow' }); ask.editRevision++;
  track.entries.push({ entryId: 'overflow', slotId: 'overflow' }); track.editRevision++;
  document.roles.push({ ...role, roleId: 'overflow' }); document.editRevision++;
  expect((await completeWrite(saveAskOwnerIndex(ask, () => true))).status).toBe('failed');
  expect((await completeWrite(saveTrackCompanion(track, () => true))).status).toBe('failed');
  expect((await saveDocument(document)).status).toBe('failed');
  expect(['ask-owners-v1', 'track-views-v1', 'composition-v1'].map(name => sessionStorage.getItem(`agent-remote:recovery:scope:${name}`))).toEqual(original);
  expect([ask.owners.length, track.entries.length, document.roles.length]).toEqual([1025, 9, 129]);
});

it.each(['composition', 'track', 'ask'] as const)('enforces the exact UTF-8 byte boundary for %s metadata', async kind => {
  const composition = makeDocument(), track = trackCompanion(), ask = askIndex();
  const document = kind === 'composition' ? composition : kind === 'track' ? track : ask;
  const set = (value: string) => { if (kind === 'composition') composition.slots[0]!.owners.text.key = value; else if (kind === 'track') track.entries[0]!.slotId = value; else ask.owners[0]!.text.key = value; };
  const save = () => completeWrite(kind === 'composition' ? saveCompositionDocument(composition, () => true) : kind === 'track' ? saveTrackCompanion(track, () => true) : saveAskOwnerIndex(ask, () => true));
  set('界'); const available = 1048576 - new TextEncoder().encode(JSON.stringify(document)).byteLength;
  set('界' + 'x'.repeat(available));
  expect((await save()).status).toBe('saved');
  const key = `agent-remote:recovery:scope:${kind === 'composition' ? 'composition-v1' : kind === 'track' ? 'track-views-v1' : 'ask-owners-v1'}`;
  const raw = sessionStorage.getItem(key)!; expect(new TextEncoder().encode(raw).byteLength).toBe(1048576);
  document.editRevision++; set('界' + 'x'.repeat(available + 1));
  expect((await save()).status).toBe('failed'); expect(sessionStorage.getItem(key)).toBe(raw);
});

it.each(['{', '{"version":9}', '{"version":1,"scope":"another"}'])('retains damaged or unsupported raw documents: %s', async raw => {
  for (const name of ['composition-v1', 'track-views-v1', 'ask-owners-v1']) sessionStorage.setItem(`agent-remote:recovery:scope:${name}`, raw);
  expect((await saveDocument(makeDocument())).status).toBe('failed');
  expect((await completeWrite(saveTrackCompanion(trackCompanion(), () => true))).status).toBe('failed');
  expect((await completeWrite(saveAskOwnerIndex(askIndex(), () => true))).status).toBe('failed');
  for (const name of ['composition-v1', 'track-views-v1', 'ask-owners-v1']) expect(sessionStorage.getItem(`agent-remote:recovery:scope:${name}`)).toBe(raw);
});

it.each([1, 2, 3, 4, 5])('retries current desired intent after checkpoint write %i fails', async fault => {
  vi.stubGlobal('crypto', webcrypto);
  const participant = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const application = new SuccessionApplication(makeDocument(), authority(), { draftViews: participant, ask: participant, track: participant });
  const original = Storage.prototype.setItem; let writes = 0;
  const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.endsWith(':composition-v1') && ++writes === fault) throw new Error('Checkpoint unavailable');
    original.call(this, key, value);
  });
  expect((await application.apply(replayCommit())).status).toBe('failed');
  expect(application.document.slots[0]!.intent).toMatchObject({ kind: 'role', target: { native: nativeRef('B') } });
  expect(application.document.roles[0]!.appliedRevision).toBeLessThan(2);
  const saved = readCompositionDocument('scope');
  if (saved.status === 'ready') expect(saved.document.roles[0]!.appliedRevision).toBeLessThan(2);
  denied.mockRestore();
  expect((await application.apply(replayCommit())).status).toBe('applied');
  expect(readCompositionDocument('scope')).toMatchObject({ status: 'ready', document: { roles: [{ appliedRevision: 2 }] } });
});

it.each(['draftViews', 'ask', 'track'] as const)('retains local owners when the %s participant throws and resumes explicitly', async name => {
  vi.stubGlobal('crypto', webcrypto); let crash = true;
  const ok = async () => ({ status: 'applied' as const, retention: 'page' as const });
  const application = new SuccessionApplication(makeDocument(), authority(), { draftViews: ok, ask: ok, track: ok,
    [name]: async () => { if (crash) throw new Error('Closed store'); return ok(); } });
  expect((await application.apply(replayCommit())).status).toBe('failed');
  expect(application.document.slots.map(slot => slot.owners)).toEqual([ownedSlot('A').owners, ownedSlot('B').owners]);
  crash = false; expect(await application.apply(replayCommit())).toEqual({ status: 'applied', retention: 'page' });
});

it.each(['scope', 'hostId', 'controllerId'] as const)('rejects mismatched %s authority without enrolling history or starting participants', async field => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument(); document.slots.push(createHistorySlot('history', { hostId: 'host', native: nativeRef('A') }, 'scope'));
  const participant = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const invalid = { ...authority(), [field]: 'different' };
  const application = new SuccessionApplication(document, invalid, { draftViews: participant, ask: participant, track: participant });
  expect((await application.apply(replayCommit())).status).toBe('pending');
  expect(document.slots.map(slot => slot.intent.kind)).toEqual(['fixed', 'fixed', 'history']); expect(participant).not.toHaveBeenCalled();
});

it('does not enroll explicit history or another provider with the same native ID', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument(), other = ownedSlot('other', 'A');
  if (other.intent.kind === 'fixed') other.intent.target.native.providerId = 'claude';
  document.slots.push(other, createHistorySlot('history', { hostId: 'host', native: nativeRef('A') }, 'scope'));
  const ok = async () => ({ status: 'applied' as const, retention: 'session' as const });
  expect((await new SuccessionApplication(document, authority(), { draftViews: ok, ask: ok, track: ok }).apply(replayCommit())).status).toBe('applied');
  expect(document.slots.slice(2).map(slot => slot.intent.kind)).toEqual(['fixed', 'history']);
});

it('retires held B callbacks after C and keeps original A owners when real Track catches up', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument(); const views = new TrackedSessionViews();
  saveTrackedSessions('scope', [{ hostId: 'host', providerId: 'codex', nativeSessionId: 'A', title: 'Original A', starredAt: 1 }]);
  let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; }); let entered = false;
  const ask = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const application = new SuccessionApplication(document, authority(), { draftViews: async context => {
    if (context.replay.to.nativeSessionId === 'B') { entered = true; await held; }
    return { status: 'applied', retention: 'session' };
  }, ask, track: context => applyCompositionTrack(context, views) });
  const b = application.apply(replayCommit()); await vi.waitFor(() => expect(entered).toBe(true));
  expect((await application.apply(replayCommit('B', 'C', 2))).status).toBe('applied');
  finish(); expect((await b).status).toBe('pending');
  expect(readTrackedSessions('scope')).toMatchObject([{ nativeSessionId: 'C', entryId: 'A', title: 'Original A' }]);
  expect(document.roles[0]!.appliedRevision).toBe(3); expect(ask).toHaveBeenCalledTimes(1);
  expect(document.slots[0]!.owners).toEqual(ownedSlot('A').owners);
});

it.each(['edit', 'retire', 'clear'] as const)('does not persist late participant progress after %s', async reason => {
  vi.stubGlobal('crypto', webcrypto); let active = true, entered = false;
  const document = makeDocument(); let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; });
  const next = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const application = new SuccessionApplication(document, { ...authority(), isCurrent: () => active }, { ask: next, track: next,
    draftViews: async () => { entered = true; await held; return { status: 'applied', retention: 'session' }; } });
  const result = application.apply(replayCommit()); await vi.waitFor(() => expect(entered).toBe(true));
  if (reason === 'edit') document.editRevision++; else if (reason === 'retire') active = false; else clearConversationRecovery('scope');
  const raw = sessionStorage.getItem('agent-remote:recovery:scope:composition-v1');
  finish(); expect((await result).status).toBe('pending'); expect(next).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('agent-remote:recovery:scope:composition-v1')).toBe(raw);
});

it.each(['current-only', 'gap', 'offline', 'pinned-conflict'] as const)('keeps recovery incomplete for %s evidence', async mode => {
  vi.stubGlobal('crypto', webcrypto);
  const b = replayCommit(), c = replayCommit('B', 'C', 2), document = makeDocument();
  if (mode === 'pinned-conflict') document.roles.push(await createRoleCheckpoint('scope', b));
  const participant = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const application = new SuccessionApplication(document, authority(), { draftViews: participant, ask: participant, track: participant });
  const changed = replayCommit(); changed.projection.receipt.updatedAt = 'changed';
  const result = await application.recover('role', { fetchSessionSuccessionOperation: async () => changed,
    fetchSessionSuccessionCurrent: async () => ({ version: 1, role: c.projection.role, locator: c.to }),
    fetchSessionSuccessions: async () => { if (mode === 'offline') throw new Error('Offline'); return { version: 1, successions: mode === 'current-only' ? [] : [c], nextCursor: null }; } });
  expect(result.status).toBe(mode === 'pinned-conflict' ? 'conflict' : 'pending');
  expect(document.slots[0]!.intent.kind).toBe('fixed'); expect(participant).not.toHaveBeenCalled();
});

it('persists unaffected Track views and independent duplicate views before removing their navigation entry', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument(); document.slots.push(ownedSlot('D'));
  const entries = ['A', 'B', 'D'].map((nativeSessionId, index) => ({ hostId: 'host', providerId: 'codex', nativeSessionId, title: nativeSessionId, starredAt: index + 1 }));
  saveTrackedSessions('scope', entries); const views = new TrackedSessionViews();
  for (const entry of entries) { views.select(entry); views.remember({ primary: entry, selections: {}, focus: `focus-${entry.nativeSessionId}` }, entries, entries); }
  views.select(entries[1]!);
  const ok = async () => ({ status: 'applied' as const, retention: 'session' as const });
  const application = new SuccessionApplication(document, authority(), { draftViews: ok, ask: ok, track: context => applyCompositionTrack(context, views) });
  expect((await application.apply(replayCommit())).status).toBe('applied');
  const saved = readTrackCompanion('scope'); expect(saved.status).toBe('ready');
  if (saved.status !== 'ready') throw new Error('Missing view retention');
  expect(saved.document.views).toEqual(expect.arrayContaining([
    expect.objectContaining({ primarySlot: 'A', focus: 'focus-A' }),
    expect.objectContaining({ primarySlot: 'B', focus: 'focus-B' }),
    expect.objectContaining({ primarySlot: 'D', focus: 'focus-D' }),
  ]));
  expect(saved.document.selected).toBe('A');
  expect(readTrackedSessions('scope').map(entry => entry.nativeSessionId)).toEqual(['B', 'D']);
});

it('requires the complete authorized chain after reloading a compact pending C checkpoint', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument(), b = replayCommit(), c = replayCommit('B', 'C', 2);
  const fail = async () => ({ status: 'failed' as const, retention: 'page' as const });
  const transport = { fetchSessionSuccessionOperation: async () => c, fetchSessionSuccessionCurrent: async () => ({ version: 1 as const, role: c.projection.role, locator: c.to }),
    fetchSessionSuccessions: async () => ({ version: 1 as const, successions: [b, c], nextCursor: null }) };
  await new SuccessionApplication(document, authority(), { draftViews: fail, ask: fail, track: fail }).recover('role', transport);
  const saved = readCompositionDocument('scope'); if (saved.status !== 'ready') throw new Error('Missing checkpoint');
  const ok = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const reloaded = new SuccessionApplication(saved.document, authority(), { draftViews: ok, ask: ok, track: ok });
  expect(await reloaded.apply(c)).toMatchObject({ status: 'pending', code: 'replay_gap' }); expect(ok).not.toHaveBeenCalled();
  expect((await reloaded.recover('role', transport)).status).toBe('applied');
});

it('rechecks concrete retained draft edits after Ask waits and before Track deduplication', async () => {
  vi.stubGlobal('crypto', webcrypto); configureImageDraftPersistence(() => false);
  const document = makeDocument(), drafts = new DraftStore('scope'); drafts.set('text-A', 'Before');
  let finish!: () => void, entered = false; const held = new Promise<void>(resolve => { finish = resolve; });
  const track = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const application = new SuccessionApplication(document, authority(), { draftViews: context => retainCompositionDraftViews(context, () => drafts),
    ask: async () => { entered = true; await held; return { status: 'applied', retention: 'session' }; }, track });
  const result = application.apply(replayCommit()); await vi.waitFor(() => expect(entered).toBe(true));
  drafts.set('text-A', 'Edited while Ask retained'); finish();
  expect((await result).status).toBe('pending'); expect(track).not.toHaveBeenCalled();
  expect(document.roles[0]!.appliedRevision).toBeLessThan(2); expect(drafts.get('text-A')).toBe('Edited while Ask retained');
});


it.each([
  ['track', 'storage'], ['track', 'caller'], ['final', 'storage'], ['final', 'caller'],
] as const)('preserves a document edit at the %s checkpoint %s continuation and returns incomplete', async (phase, boundary) => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument(); document.slots.push(ownedSlot('D'));
  const ok = async () => ({ status: 'applied' as const, retention: 'session' as const });
  const application = new SuccessionApplication(document, authority(), { draftViews: ok, ask: ok, track: ok });
  const original = Storage.prototype.setItem; let edited = false;
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    original.call(this, key, value);
    if (!key.endsWith(':composition-v1') || edited) return;
    const saved = JSON.parse(value) as CompositionDocument, checkpoint = saved.roles[0]!;
    if (checkpoint.documents.track.status !== 'applied' || (checkpoint.documents.composition.status === 'applied') !== (phase === 'final')) return;
    edited = true;
    const edit = () => {
      document.edges = [{ source: 'B', target: 'D', selected: true }];
      document.focus = 'B'; document.collapsed = ['B']; document.editRevision++;
    };
    queueMicrotask(() => { if (boundary === 'caller') queueMicrotask(edit); else edit(); });
  });
  expect((await application.apply(replayCommit())).status).toBe('pending');
  expect(edited).toBe(true);
  expect(document.edges).toEqual([{ source: 'B', target: 'D', selected: true }]);
  expect(document.focus).toBe('B'); expect(document.collapsed).toEqual(['B']);
  expect(document.roles[0]!.appliedRevision).toBeLessThan(2);
  const saved = readCompositionDocument('scope');
  expect(saved.status).toBe('ready');
  if (saved.status !== 'ready') throw new Error('Missing incomplete checkpoint');
  expect(saved.document.roles[0]!.appliedRevision).toBeLessThan(2);
  if (phase === 'final') {
    expect(saved.document.edges).toEqual(document.edges);
    expect(saved.document.focus).toBe('B');
  }
  write.mockRestore();
  expect((await application.apply(replayCommit())).status).toBe('applied');
});

it('does not roll back a newer C checkpoint when the B final completion retires', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument();
  const ok = async () => ({ status: 'applied' as const, retention: 'session' as const });
  const application = new SuccessionApplication(document, authority(), { draftViews: ok, ask: ok, track: ok });
  const original = Storage.prototype.setItem; let advanced = false;
  let newer: ReturnType<typeof application.apply> | undefined;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    original.call(this, key, value);
    if (!key.endsWith(':composition-v1') || advanced) return;
    const saved = JSON.parse(value) as CompositionDocument;
    if (saved.roles[0]!.appliedRevision !== 2) return;
    advanced = true;
    queueMicrotask(() => { newer = application.apply(replayCommit('B', 'C', 2)); });
  });
  expect((await application.apply(replayCommit())).status).toBe('pending');
  expect(advanced).toBe(true); expect(newer).toBeDefined();
  expect((await newer!)?.status).toBe('applied');
  expect(document.roles[0]).toMatchObject({ appliedRevision: 3, desired: { committedRevision: 3 } });
  expect(readCompositionDocument('scope')).toMatchObject({ status: 'ready', document: { roles: [{ appliedRevision: 3 }] } });
});
