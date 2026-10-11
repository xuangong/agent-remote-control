// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clearConversationRecovery } from './conversation-recovery.js';
import type { OpenedSession } from './directory-client.js';
import { sessionKey } from './session-tree.js';
import { clearCacheOnClose, setClearCacheOnClose } from './conversation-storage.js';
import * as compositionMetadata from './session-composition.js';

const source: OpenedSession = { hostId: 'desk', providerId: 'codex', nativeSessionId: 'main', agentId: 'old-main-binding', title: 'Main' };
const side: OpenedSession = { ...source, nativeSessionId: 'side', agentId: 'old-side-binding', title: 'Side' };
const sourceKey = '["desk","codex","main"]';
const sideKey = '["desk","codex","side"]';
const storageKey = (scope: string) => `agent-remote:recovery:${scope}:composition`;
const composition = () => ({ path: [source, side], focus: sideKey, anchor: sideKey, addressKey: sideKey });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureImageDraftPersistence(() => !clearCacheOnClose());
  clearConversationRecovery();
  sessionStorage.clear(); localStorage.clear();
});

it('imports view metadata once without moving its draft or image owners', () => {
  sessionStorage.setItem(storageKey('alice'), JSON.stringify(composition()));
  localStorage.setItem('agent-remote-opened:alice', JSON.stringify([source, side]));
  sessionStorage.setItem(`agent-remote-ask:alice:open-windows`, JSON.stringify([sourceKey]));
  const loaded = compositionMetadata.initializeCompositionDocument('alice');
  expect(loaded.status).toBe('ready');
  if (loaded.status !== 'ready') return;
  const primary = loaded.document.slots.find(slot => slot.intent.target.native.nativeSessionId === 'main')!;
  const child = loaded.document.slots.find(slot => slot.intent.target.native.nativeSessionId === 'side')!;
  expect(loaded.document.version).toBe(2);
  expect(loaded.document.primary).toBe(primary.id);
  expect(loaded.document.address).toBe(child.id);
  expect(loaded.document.edges).toEqual([{ source: primary.id, target: child.id, selected: true }]);
  expect(primary.owners).toEqual({ text: { scope: 'alice', key: source.agentId },
    image: { scope: 'alice', key: JSON.stringify(['alice', sourceKey]) }, display: { scope: 'alice', key: sourceKey } });
  expect(loaded.document.asks.find(owner => owner.sourceSlot === primary.id)).toMatchObject({ open: true, text: { scope: 'alice:ask', key: sourceKey } });
  expect(sessionStorage.getItem(storageKey('alice'))).toBe(JSON.stringify(composition()));
});

it('uses the new document alone after importing the original view state', () => {
  sessionStorage.setItem(storageKey('alice'), JSON.stringify(composition()));
  const first = compositionMetadata.initializeCompositionDocument('alice');
  expect(first.status).toBe('ready');
  sessionStorage.setItem(storageKey('alice'), '{');
  localStorage.setItem('agent-remote-opened:alice', '{');
  sessionStorage.setItem('agent-remote-ask:alice:open-windows', '{');
  expect(compositionMetadata.initializeCompositionDocument('alice')).toEqual(first);
});

it('keeps imported metadata from replacing a view target while retaining its original draft owner', () => {
  const view = createCompositionSlot('retained-owner', side, 'alice');
  view.owners.text.key = source.agentId;
  const previous = { ...createCompositionDocument('alice', [view]), version: 1 };
  sessionStorage.setItem('agent-remote:recovery:alice:composition-v1', JSON.stringify(previous));
  localStorage.setItem('agent-remote-opened:alice', JSON.stringify([source, side]));
  const loaded = compositionMetadata.initializeCompositionDocument('alice');
  expect(loaded.status).toBe('ready');
  if (loaded.status !== 'ready') return;
  expect(loaded.document.slots.map(slot => slot.intent.target.native.nativeSessionId).sort()).toEqual(['main', 'side']);
  expect(loaded.document.slots.find(slot => slot.id === view.id)).toMatchObject({
    intent: { target: { native: { nativeSessionId: side.nativeSessionId } } },
    owners: { text: { key: source.agentId } },
  });
});

it('preserves original view data and retries an import rejected by storage', () => {
  const original = JSON.stringify(composition());
  sessionStorage.setItem(storageKey('alice'), original);
  const setItem = Storage.prototype.setItem;
  const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.endsWith(':composition-v2')) throw new Error('Storage full');
    return setItem.call(this, key, value);
  });
  expect(compositionMetadata.initializeCompositionDocument('alice').status).toBe('failed');
  expect(sessionStorage.getItem(storageKey('alice'))).toBe(original);
  expect(sessionStorage.getItem('agent-remote:recovery:alice:composition-v2')).toBeNull();
  denied.mockRestore();
  expect(compositionMetadata.initializeCompositionDocument('alice').status).toBe('ready');
});

it('does not complete a view import until the new document reads back unchanged', () => {
  sessionStorage.setItem(storageKey('alice'), JSON.stringify(composition()));
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.endsWith(':composition-v2')) return;
    return setItem.call(this, key, value);
  });
  expect(compositionMetadata.initializeCompositionDocument('alice').status).toBe('failed');
  expect(sessionStorage.getItem(storageKey('alice'))).toBe(JSON.stringify(composition()));
});

it('retries the original import after a valid but incomplete write is read back', () => {
  sessionStorage.setItem(storageKey('alice'), JSON.stringify(composition()));
  const setItem = Storage.prototype.setItem;
  const corrupt = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    return setItem.call(this, key, key.endsWith(':composition-v2') ? JSON.stringify(createCompositionDocument('alice')) : value);
  });
  expect(compositionMetadata.initializeCompositionDocument('alice').status).toBe('failed');
  corrupt.mockRestore();
  const next = compositionMetadata.initializeCompositionDocument('alice');
  expect(next).toMatchObject({ status: 'ready', document: { slots: expect.arrayContaining([expect.objectContaining({ metadata: expect.objectContaining({ agentId: source.agentId }) })]) } });
  expect(sessionStorage.getItem(storageKey('alice'))).toBe(JSON.stringify(composition()));
});

it.each(['{', 'null', '{"path":[]}', JSON.stringify({ path: [source], addressKey: sideKey })])('keeps malformed original layouts untouched: %s', raw => {
  sessionStorage.setItem(storageKey('alice'), raw);
  expect(compositionMetadata.initializeCompositionDocument('alice').status).toBe('failed');
  expect(sessionStorage.getItem(storageKey('alice'))).toBe(raw);
  expect(readCompositionDocument('alice').status).toBe('missing');
});

it('clears only the signed-out workspace composition', () => {
  compositionMetadata.initializeCompositionDocument('alice'); compositionMetadata.initializeCompositionDocument('bob');
  clearConversationRecovery('alice');
  expect(readCompositionDocument('alice').status).toBe('missing');
  expect(readCompositionDocument('bob').status).toBe('ready');
});

it('restores durable owners without reimporting legacy data or another tab layout', () => {
  sessionStorage.setItem(storageKey('alice'), JSON.stringify(composition()));
  const first = compositionMetadata.initializeCompositionDocument('alice');
  if (first.status !== 'ready') throw new Error('Missing imported views');
  sessionStorage.clear();
  sessionStorage.setItem(storageKey('alice'), '{');
  localStorage.setItem('agent-remote-opened:alice', '{');
  sessionStorage.setItem('agent-remote-ask:alice:open-windows', '{');
  const restored = compositionMetadata.initializeCompositionDocument('alice');
  expect(restored).toMatchObject({ status: 'ready', document: { slots: first.document.slots, roles: [], edges: [], tracks: [], retained: [], collapsed: [] } });
  if (restored.status !== 'ready') return;
  for (const key of ['primary', 'address', 'focus', 'anchor', 'selectedTrack'] as const) expect(restored.document[key]).toBeUndefined();
  expect(restored.document.asks.every(owner => !owner.open && owner.records === undefined)).toBe(true);
});

it.each(['throw', 'omit'] as const)('keeps owner import retryable after a durable metadata %s failure', failure => {
  sessionStorage.setItem(storageKey('alice'), JSON.stringify(composition()));
  const setItem = Storage.prototype.setItem;
  const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.includes(':composition-owner:')) { if (failure === 'throw') throw new Error('Owner storage denied'); return; }
    return setItem.call(this, key, value);
  });
  expect(compositionMetadata.initializeCompositionDocument('alice').status).toBe('failed');
  expect(localStorage.getItem('agent-remote:recovery:alice:composition-import-v2')).toBeNull();
  expect(sessionStorage.getItem(storageKey('alice'))).toBe(JSON.stringify(composition()));
  denied.mockRestore();
  expect(compositionMetadata.initializeCompositionDocument('alice').status).toBe('ready');
  expect(localStorage.getItem('agent-remote:recovery:alice:composition-import-v2')).toBe('2');
});

it('keeps the latest Ask preference when a stale tab saves and then reloads', async () => {
  sessionStorage.setItem(storageKey('alice'), JSON.stringify(composition()));
  localStorage.setItem(`agent-remote-ask:alice:enabled:${sourceKey}`, 'true');
  const loaded = compositionMetadata.initializeCompositionDocument('alice');
  if (loaded.status !== 'ready') throw new Error('Missing imported views');
  const current = structuredClone(loaded.document), stale = structuredClone(loaded.document);
  const owner = current.asks.find(owner => owner.sourceSlot === current.primary)!;
  compositionMetadata.saveCompositionAskEnabled(current, owner.id, false, () => true);
  expect((await saveDocument(stale)).status).toBe('saved');
  const reloaded = compositionMetadata.initializeCompositionDocument('alice');
  expect(reloaded).toMatchObject({ status: 'ready', document: { asks: expect.arrayContaining([expect.objectContaining({ id: owner.id, enabled: false })]) } });
  sessionStorage.clear();
  expect(compositionMetadata.initializeCompositionDocument('alice')).toMatchObject({ status: 'ready', document: { asks: expect.arrayContaining([expect.objectContaining({ id: owner.id, enabled: false })]) } });
});

it('retains independent and history owners across a new tab while authority restores role intent', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument();
  document.slots.push(ownedSlot('independent-A', 'A'), createHistorySlot('history-A', { hostId: 'host', native: nativeRef('A') }, 'scope'));
  document.asks = document.slots.map(slot => createAskOwner(slot, 'scope'));
  const success = async () => ({ status: 'applied' as const, retention: 'session' as const });
  const application = new SuccessionApplication(document, authority(), { track: success, ask: success, draftViews: success });
  expect((await application.apply(replayCommit())).status).toBe('applied');
  expect(compositionMetadata.initializeCompositionDocument('scope').status).toBe('ready');
  sessionStorage.clear();
  const restored = compositionMetadata.initializeCompositionDocument('scope');
  if (restored.status !== 'ready') throw new Error('Missing durable owners');
  expect(restored.document.roles).toEqual([]); expect(restored.document.retained).toEqual([]);
  expect(restored.document.slots.map(slot => [slot.id, slot.origin.kind, slot.intent.target.native.nativeSessionId, slot.owners])).toEqual([
    ['A', 'fixed', 'A', ownedSlot('A').owners], ['B', 'fixed', 'B', ownedSlot('B').owners],
    ['independent-A', 'fixed', 'A', ownedSlot('independent-A', 'A').owners], ['history-A', 'history', 'A', document.slots[3]!.owners],
  ]);
  const recovered = new SuccessionApplication(restored.document, authority(), { track: success, ask: success, draftViews: success });
  expect((await recovered.apply(replayCommit())).status).toBe('applied');
  expect(restored.document.slots.find(slot => slot.id === 'A')).toMatchObject({ intent: { kind: 'role', target: { native: nativeRef('B') } }, owners: ownedSlot('A').owners });
  expect(restored.document.slots.find(slot => slot.id === 'B')).toEqual(ownedSlot('B'));
  expect(restored.document.slots.find(slot => slot.id === 'history-A')!.intent.kind).toBe('history');
});

it('clears durable owners on sign-out and keeps protected owners off disk', async () => {
  for (const scope of ['alice', 'bob']) {
    const slot = createCompositionSlot('view', source, scope);
    expect((await saveDocument(createCompositionDocument(scope, [slot]))).status).toBe('saved');
    expect(compositionMetadata.initializeCompositionDocument(scope).status).toBe('ready');
  }
  clearConversationRecovery('alice');
  expect(Object.keys(localStorage).filter(key => key.startsWith('agent-remote:recovery:alice:'))).toEqual([]);
  expect(compositionMetadata.restoreCompositionOwners('bob').slots).toHaveLength(1);
  await setClearCacheOnClose(true);
  const document = createCompositionDocument('protected', [createCompositionSlot('private', source, 'protected')]);
  expect((await saveDocument(document)).status).toBe('saved');
  expect(compositionMetadata.restoreCompositionOwners('protected').slots).toHaveLength(1);
  expect(Object.keys(localStorage).filter(key => key.startsWith('agent-remote:recovery:'))).toEqual([]);
  await setClearCacheOnClose(false);
});

it('rejects new owners beyond the durable catalogue bounds without making existing owners unreadable', async () => {
  const full = createCompositionDocument('scope', Array.from({ length: 1024 }, (_, index) => ownedSlot(`durable-${index}`)));
  expect((await saveDocument(full)).status).toBe('saved');
  sessionStorage.clear();
  const staleTab = createCompositionDocument('scope', [ownedSlot('later-view')]);
  expect((await saveDocument(staleTab)).status).toBe('failed');
  expect(compositionMetadata.restoreCompositionOwners('scope').slots).toHaveLength(1024);
  clearConversationRecovery('scope');
  const large = (id: string, size: number) => {
    const slot = ownedSlot(id); slot.metadata = { title: 'x'.repeat(size) };
    return createCompositionDocument('scope', [slot]);
  };
  expect((await saveDocument(large('first-large', 600000))).status).toBe('saved');
  sessionStorage.clear();
  expect((await saveDocument(large('second-large', 600000))).status).toBe('failed');
  expect(compositionMetadata.restoreCompositionOwners('scope').slots.map(slot => slot.id)).toEqual(['first-large']);
});

import { webcrypto } from 'node:crypto';
import type { SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument, readCompositionDocument, saveCompositionDocument, createRoleCheckpoint, compositionRoleKey,
  SuccessionApplication, createCompositionSlot, createAskOwner, createHistorySlot, retainCompositionDraftViews, applyCompositionTrack, type CompositionDocument, type CompositionSlot } from './session-composition.js';
import { flushRecoveryWrites } from './recovery-writes.js';
import { DraftStore } from './draft-store.js';
import { TrackedSessionViews } from './tracked-session-views.js';
import { saveTrackedSessions, readTrackedSessions } from './tracking-state.js';
import { configureImageDraftPersistence, writeImageDraft, readImageDraft } from '@orchardworks/agent-remote-web/browser';
const importedSlot = (id: string, session: OpenedSession, scope: string, nativeKey: string) => createCompositionSlot(id, session, scope, {
  text: { scope, key: session.agentId }, image: { scope, key: JSON.stringify([scope, nativeKey]) }, display: { scope, key: nativeKey },
});
const nativeRef = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'codex', nativeSessionId });
const replayCommit = (from = 'A', to = 'B', expectedRevision = 1): SessionSuccessionReplay => {
  const workspace = { controllerId: 'installation', canonicalCwd: '/workspace' };
  const request = { operationId: `operation-${expectedRevision}`, roleId: 'role', expectedRevision, from: nativeRef(from) };
  return { version: 1, from: { hostId: 'host', providerId: 'codex', nativeSessionId: from }, to: { hostId: 'host', providerId: 'codex', nativeSessionId: to },
    projection: { version: 1, role: { id: 'role', revision: expectedRevision + 1, origin: nativeRef('A'), current: nativeRef(to), workspace }, receipt: { ...request, to: nativeRef(to), phase: 'committed', committedRevision: expectedRevision + 1, startedAt: 'now', updatedAt: 'now',
      prepared: { ...request, to: nativeRef(to), workspace, associationRevision: 1, participants: [], capture: { epoch: 'epoch', seq: 1, capturedAt: 'now' } } } } };
};
const ownedSlot = (id: string, native = id): CompositionSlot => ({ id, origin: { kind: 'fixed', target: { hostId: 'host', native: nativeRef(native) } }, intent: { kind: 'fixed', target: { hostId: 'host', native: nativeRef(native) } },
  owners: { text: { scope: 'scope', key: `text-${id}` }, image: { scope: 'scope', key: `image-${id}` }, display: { scope: 'scope', key: `display-${id}` } } });
const makeDocument = (): CompositionDocument => { const document = createCompositionDocument('scope', [ownedSlot('A'), ownedSlot('B')]); document.tracks = [{ entryId: 'A', slotId: 'A' }, { entryId: 'B', slotId: 'B' }]; return document; };
const authority = () => ({ scope: 'scope', hostId: 'host', controllerId: 'installation', isCurrent: () => true });
async function saveDocument(document: CompositionDocument) { const handle = saveCompositionDocument(document, () => true); flushRecoveryWrites(); return handle.completion; }

it('persists compact exact checkpoints without receipt bodies and hashes canonical projection content', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const commit = replayCommit(); const checkpoint = await createRoleCheckpoint('scope', commit);
  const reordered = { to: commit.to, projection: { receipt: commit.projection.receipt, role: commit.projection.role, version: 1 as const }, from: commit.from, version: 1 as const };
  expect((await createRoleCheckpoint('scope', reordered)).desired.projectionDigest).toEqual(checkpoint.desired.projectionDigest);
  const document = makeDocument(); document.roles.push(checkpoint);
  expect((await saveDocument(document)).status).toBe('saved');
  const raw = sessionStorage.getItem('agent-remote:recovery:scope:composition-v2')!;
  expect(raw).not.toContain('participants'); expect(raw).not.toContain('prepared'); expect(raw).not.toContain('authorityKey');
  expect(readCompositionDocument('scope')).toMatchObject({ status: 'ready', document: { roles: [{ desired: { from: nativeRef('A'), to: nativeRef('B') } }] } });
});
it('refuses unsupported metadata and independent count and UTF-8 byte overflow without replacing original state', async () => {
  const key = 'agent-remote:recovery:scope:composition-v2';
  sessionStorage.setItem(key, '{"version":9}');
  expect(readCompositionDocument('scope').status).toBe('unsupported');
  expect((await saveDocument(makeDocument())).status).toBe('failed'); expect(sessionStorage.getItem(key)).toBe('{"version":9}');
  sessionStorage.removeItem(key);
  const document = createCompositionDocument('scope', Array.from({ length: 1024 }, (_, index) => ownedSlot(`slot-${index}`)));
  expect((await saveDocument(document)).status).toBe('saved'); const original = sessionStorage.getItem(key);
  expect(compositionMetadata.restoreCompositionOwners('scope').slots).toHaveLength(1024);
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
  const slots = [importedSlot('A', nativeA, 'scope', sessionKey(nativeA)), importedSlot('B', nativeB, 'scope', sessionKey(nativeB))];
  const document = createCompositionDocument('scope', slots); document.edges = [{ source: 'A', target: 'B', selected: true }];
  const drafts = new DraftStore('scope'); drafts.set('runtime-A', 'A text'); drafts.set('runtime-B', 'B text');
  for (const slot of slots) await writeImageDraft({ version: 1, ...slot.owners.image, parts: [{ type: 'image', imageId: slot.id, label: `image ${slot.id}` }],
    images: { [slot.id]: { imageId: slot.id, blob: new Blob([`${slot.id} bytes`], { type: 'image/png' }), uploadId: slot.id, status: 'pending', progress: 0 } }, nextLabel: 2 });
  saveTrackedSessions('scope', [{ ...nativeA, entryId: 'A', starredAt: 1 }, { ...nativeB, entryId: 'B', starredAt: 2 }]);
  document.tracks = [{ entryId: 'A', slotId: 'A', view: { primarySlot: 'A', selections: {} } }, { entryId: 'B', slotId: 'B' }];
  const ask = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const application = new SuccessionApplication(document, authority(), { draftViews: context => retainCompositionDraftViews(context, () => drafts),
    track: context => applyCompositionTrack(context), ask });
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
  expect(readCompositionDocument('scope')).toMatchObject({ status: 'ready', document: { tracks: expect.arrayContaining([{ entryId: 'A', slotId: 'A', view: { primarySlot: 'A', selections: {} } }]) } });
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
  const a = { hostId: 'host', providerId: 'codex', nativeSessionId: 'A', title: 'Track A', entryId: 'A', starredAt: 1 };
  const b = { ...a, nativeSessionId: 'B', title: 'Track B', entryId: 'B', starredAt: 2 };
  saveTrackedSessions('scope', [a, b]);
  let retained = false;
  const application = new SuccessionApplication(document, authority(), { draftViews: async () => ({ status: 'applied', retention: 'session' }),
    track: context => applyCompositionTrack(context), ask: async () => retained ? { status: 'applied', retention: 'session' } : { status: 'failed', retention: 'page', code: 'B_ask_unreadable' } });
  expect((await application.apply(replayCommit())).status).toBe('failed');
  expect(readTrackedSessions('scope').map(value => value.nativeSessionId)).toEqual(['A', 'B']);
  expect(document.edges).toEqual([{ source: 'A', target: 'B', selected: true }]);
  expect(document.retained).toEqual([{ slot: 'B', against: 'A' }]);
  retained = true;
  expect((await application.apply(replayCommit())).status).toBe('applied');
  expect(readTrackedSessions('scope')).toMatchObject([{ entryId: 'A', nativeSessionId: 'B', title: 'Track A' }]);
  expect(document.edges).toEqual([]);
});

it('bounds all view metadata in the same document without truncating original state', async () => {
  const document = createCompositionDocument('scope', Array.from({ length: 1024 }, (_, i) => ownedSlot(`slot-${i}`)));
  document.asks = document.slots.map(slot => createAskOwner(slot, 'scope'));
  expect((await saveDocument(document)).status).toBe('saved');
  const raw = sessionStorage.getItem('agent-remote:recovery:scope:composition-v2');
  document.asks.push({ ...document.asks[0]!, id: 'overflow' }); document.editRevision++;
  expect((await saveDocument(document)).status).toBe('failed');
  expect(sessionStorage.getItem('agent-remote:recovery:scope:composition-v2')).toBe(raw);
});

it('keeps invalid track and Ask references out of the authoritative document', async () => {
  const document = makeDocument();
  document.tracks[0]!.view = { primarySlot: 'missing', selections: {} };
  expect((await saveDocument(document)).status).toBe('failed');
  document.tracks[0]!.view = { primarySlot: 'A', selections: { A: 'missing' } };
  expect((await saveDocument(document)).status).toBe('failed');
  document.tracks[0]!.view = { primarySlot: 'A', selections: {} };
  document.asks = [{ ...createAskOwner(document.slots[0]!, 'scope'), sourceSlot: 'missing' }];
  expect((await saveDocument(document)).status).toBe('failed');
});

it.each([1, 2, 3, 4, 5])('retries current desired intent after checkpoint write %i fails', async fault => {
  vi.stubGlobal('crypto', webcrypto);
  const participant = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const application = new SuccessionApplication(makeDocument(), authority(), { draftViews: participant, ask: participant, track: participant });
  const original = Storage.prototype.setItem; let writes = 0;
  const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.endsWith(':composition-v2') && ++writes === fault) throw new Error('Checkpoint unavailable');
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
  const document = makeDocument();
  saveTrackedSessions('scope', [{ hostId: 'host', providerId: 'codex', nativeSessionId: 'A', title: 'Original A', entryId: 'A', starredAt: 1 }]);
  let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; }); let entered = false;
  const ask = vi.fn(async () => ({ status: 'applied' as const, retention: 'session' as const }));
  const application = new SuccessionApplication(document, authority(), { draftViews: async context => {
    if (context.replay.to.nativeSessionId === 'B') { entered = true; await held; }
    return { status: 'applied', retention: 'session' };
  }, ask, track: context => applyCompositionTrack(context) });
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
  const raw = sessionStorage.getItem('agent-remote:recovery:scope:composition-v2');
  finish(); expect((await result).status).toBe('pending'); expect(next).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('agent-remote:recovery:scope:composition-v2')).toBe(raw);
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

it('retains independent Track view IDs while a role binding changes twice', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument(); document.slots.push(ownedSlot('D'));
  document.tracks = ['A', 'B', 'D'].map(id => ({ entryId: id, slotId: id, view: { primarySlot: id, selections: {}, focus: id } }));
  saveTrackedSessions('scope', ['A', 'B', 'D'].map((id, index) => ({ hostId: 'host', providerId: 'codex', nativeSessionId: id, entryId: id, title: id, starredAt: index + 1 })));
  const views = new TrackedSessionViews(document, () => {});
  const ok = async () => ({ status: 'applied' as const, retention: 'session' as const });
  const application = new SuccessionApplication(document, authority(), { draftViews: ok, ask: ok, track: applyCompositionTrack });
  expect((await application.apply(replayCommit())).status).toBe('applied');
  expect((await application.apply(replayCommit('B', 'C', 2))).status).toBe('applied');
  expect(views.get('A')).toMatchObject({ primarySlot: 'A', primary: { nativeSessionId: 'C' } });
  expect(views.get('B')).toMatchObject({ primarySlot: 'B', primary: { nativeSessionId: 'B' } });
  expect(views.get('D')).toMatchObject({ primarySlot: 'D', primary: { nativeSessionId: 'D' } });
  expect(readCompositionDocument('scope')).toMatchObject({ status: 'ready', document: { tracks: document.tracks } });
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
    if (!key.endsWith(':composition-v2') || edited) return;
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
    if (!key.endsWith(':composition-v2') || advanced) return;
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

it('preserves an explicitly selected retained view during repeated and newer role recovery', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument(), chain = [replayCommit()];
  const ok = async () => ({ status: 'applied' as const, retention: 'session' as const });
  const application = new SuccessionApplication(document, authority(), { draftViews: ok, ask: ok, track: ok });
  expect((await application.apply(chain[0]!)).status).toBe('applied');
  Object.assign(document, { address: 'B', focus: 'B', anchor: 'B' }); document.editRevision++;
  const transport = { fetchSessionSuccessionOperation: async (_role: string, operation: string) => chain.find(value => value.projection.receipt.operationId === operation),
    fetchSessionSuccessionCurrent: async () => ({ version: 1 as const, role: chain.at(-1)!.projection.role, locator: chain.at(-1)!.to }),
    fetchSessionSuccessions: async () => ({ version: 1 as const, successions: chain, nextCursor: null }) };
  for (let index = 0; index < 3; index++) {
    if (index === 2) chain.push(replayCommit('B', 'C', 2));
    expect(await application.recover('role', transport, { selectedSlot: 'B', isCurrent: () => true })).toMatchObject({ status: 'applied' });
    expect(readCompositionDocument('scope')).toMatchObject({ status: 'ready', document: { address: 'B', focus: 'B', anchor: 'B' } });
  }
  expect(document.slots.find(slot => slot.id === 'A')!.intent).toMatchObject({ kind: 'role', target: { native: { nativeSessionId: 'C' } } });
  expect(document.slots.find(slot => slot.id === 'B')!.intent).toMatchObject({ kind: 'fixed', target: { native: { nativeSessionId: 'B' } } });
});

it('retires an in-flight recovery before it can publish over a new local selection', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const document = makeDocument(), replay = replayCommit();
  let selected = true, entered = false, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const ok = async () => ({ status: 'applied' as const, retention: 'session' as const });
  const track = vi.fn(ok);
  const application = new SuccessionApplication(document, authority(), { draftViews: ok, ask: async () => { entered = true; await gate; return ok(); }, track });
  const pending = application.recover('role', { fetchSessionSuccessionOperation: async () => replay,
    fetchSessionSuccessionCurrent: async () => ({ version: 1, role: replay.projection.role, locator: replay.to }),
    fetchSessionSuccessions: async () => ({ version: 1, successions: [replay], nextCursor: null }),
  }, { selectedSlot: 'B', isCurrent: () => selected });
  await vi.waitFor(() => expect(entered).toBe(true));
  selected = false; document.address = 'B'; finish();
  expect(await pending).toMatchObject({ status: 'pending' });
  expect(track).not.toHaveBeenCalled(); expect(document.address).toBe('B'); expect(document.roles[0]!.appliedRevision).toBeLessThan(2);
});


it('retries partial owner import for an Ask window outside the recent session catalog', () => {
  const scope = 'partial-ask-import', key = `agent-remote:recovery:${scope}:composition-v2`;
  const windowsKey = `agent-remote-ask:${scope}:open-windows`;
  const windows = JSON.stringify([JSON.stringify(['host', 'recorded', 'outside-recent-catalog'])]);
  sessionStorage.setItem(windowsKey, windows);
  const original = Storage.prototype.setItem;
  const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, storedKey, value) {
    if (storedKey === key) throw new Error('Session metadata write failed');
    original.call(this, storedKey, value);
  });
  expect(compositionMetadata.initializeCompositionDocument(scope).status).toBe('failed');
  const owners = compositionMetadata.restoreCompositionOwners(scope);
  expect(owners.slots).toHaveLength(1);
  expect(sessionStorage.getItem(key)).toBeNull();
  fail.mockRestore();
  const retry = compositionMetadata.initializeCompositionDocument(scope);
  expect(retry).toMatchObject({ status: 'ready', document: { slots: [expect.objectContaining({ id: owners.slots[0]!.id, owners: owners.slots[0]!.owners })] } });
  expect(compositionMetadata.initializeCompositionDocument(scope).status).toBe('ready');
  expect(sessionStorage.getItem(windowsKey)).toBe(windows);
});


it('persists existing owners and current Ask preference after disabling clear-on-close', async () => {
  const scope = 'policy-owner';
  localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source]));
  const first = compositionMetadata.initializeCompositionDocument(scope);
  if (first.status !== 'ready') throw new Error('Missing initial composition');
  const document = first.document, owner = document.asks[0]!;
  await setClearCacheOnClose(true);
  compositionMetadata.saveCompositionAskEnabled(document, owner.id, true, () => true);
  await setClearCacheOnClose(false);
  document.editRevision++;
  expect((await saveDocument(document)).status).toBe('saved');
  const initialized = compositionMetadata.initializeCompositionDocument(scope);
  if (initialized.status === 'failed') throw initialized.error;
  expect(initialized.status).toBe('ready');
  sessionStorage.clear();
  vi.resetModules();
  const cold = await import('./session-composition.js');
  expect(cold.initializeCompositionDocument(scope)).toMatchObject({ status: 'ready', document: {
    slots: expect.arrayContaining([expect.objectContaining({ id: document.slots[0]!.id, owners: document.slots[0]!.owners })]),
    asks: expect.arrayContaining([expect.objectContaining({ id: owner.id, enabled: true })]),
  } });
});
