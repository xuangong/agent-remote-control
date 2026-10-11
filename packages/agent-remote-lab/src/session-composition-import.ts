import { conversationLocalStorage, conversationSessionStorage } from './conversation-storage.js';
import { recoveryGeneration } from './conversation-recovery.js';
import { flushRecoveryWrites } from './recovery-writes.js';
import { sessionKey, type SessionEntry } from './session-tree.js';
import { ForkStore } from './session-forks.js';
import { readTrackedSessionsChecked } from './tracking-state.js';
import type { OpenedSession } from './directory-client.js';
import { compositionMetadataKey, compositionOriginId, compositionOwnersImported, completeCompositionOwnerImport, retainCompositionOwners, restoreCompositionOwners, refreshCompositionAskPreferences, compositionSelection, compositionSessionMetadata, createAskOwner, createCompositionDocument, createCompositionSlot, parseComposition, readCompositionDocument, saveCompositionDocument,
  type AskAssociationOwner, type CompositionDocument, type CompositionRead, type CompositionSlot } from './session-composition-model.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const requireValue = (ok: unknown): void => { if (!ok) throw new Error('The original session view data could not be imported.'); };
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function read(storage: Storage, key: string): unknown {
  flushRecoveryWrites(key);
  const raw = storage.getItem(key);
  return raw === null ? undefined : JSON.parse(raw);
}
function opened(value: unknown): OpenedSession {
  requireValue(object(value)); const item = value as OpenedSession;
  requireValue(nonempty(item.agentId) && nonempty(item.providerId) && nonempty(item.nativeSessionId) && typeof item.title === 'string'
    && [item.hostId, item.parentAgentId, item.parentNativeSessionId, item.createdAt].every(value => value === undefined || typeof value === 'string'));
  return { agentId: item.agentId, providerId: item.providerId, nativeSessionId: item.nativeSessionId, title: item.title,
    ...(item.hostId === undefined ? {} : { hostId: item.hostId }), ...(item.parentAgentId === undefined ? {} : { parentAgentId: item.parentAgentId }),
    ...(item.parentNativeSessionId === undefined ? {} : { parentNativeSessionId: item.parentNativeSessionId }), ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }) };
}
function keySession(key: string): SessionEntry {
  const parts: unknown = JSON.parse(key);
  requireValue(Array.isArray(parts) && parts.length === 3 && parts.every(nonempty));
  const [hostId, providerId, nativeSessionId] = parts as string[];
  return { hostId: hostId!, providerId: providerId!, nativeSessionId: nativeSessionId!, title: 'Session' };
}

/** Only this upgrade boundary reads native-key layouts or companion documents. */
function importComposition(scope: string): CompositionDocument {
  const prefix = `agent-remote:recovery:${scope}:`;
  const previous = read(conversationSessionStorage, `${prefix}composition-v1`);
  const layout = read(conversationSessionStorage, `${prefix}composition`);
  const oldTracks = read(conversationSessionStorage, `${prefix}track-views-v1`);
  const oldAsk = read(conversationSessionStorage, `${prefix}ask-owners-v1`);
  const known: OpenedSession[] = [];
  const catalog = read(conversationLocalStorage, `agent-remote-opened:${scope}`);
  if (catalog !== undefined) { requireValue(Array.isArray(catalog)); known.push(...(catalog as unknown[]).map(opened)); }
  const askStore = new ForkStore(`ask:${scope}`, conversationSessionStorage);
  const recordPrefix = `agent-remote-forks:ask:${scope}:record:`;
  for (let index = 0; index < conversationSessionStorage.length; index++) {
    const key = conversationSessionStorage.key(index);
    if (key?.startsWith(recordPrefix)) askStore.getLocalForEffect(key.slice(recordPrefix.length));
  }
  const records = askStore.all();
  for (const record of records) known.push(record.source, ...(record.target ? [record.target] : []));
  let path: OpenedSession[] = [];
  if (layout !== undefined) {
    requireValue(object(layout) && Array.isArray(layout.path) && layout.path.length > 0 && layout.path.length <= 100);
    path = ((layout as { path: unknown[] }).path).map(opened); known.push(...path);
    const keys = new Set(path.map(sessionKey));
    requireValue(keys.size === path.length && keys.has((layout as { addressKey: string }).addressKey));
    requireValue(['focus', 'anchor'].every(key => (layout as Record<string, unknown>)[key] === undefined || keys.has((layout as Record<string, string>)[key]!)));
  }
  const document = createCompositionDocument(scope);
  if (previous !== undefined) {
    requireValue(object(previous) && previous.version === 1 && previous.scope === scope && Array.isArray(previous.slots));
    Object.assign(document, previous, { version: 2, asks: [], tracks: [] });
    document.slots = (previous as { slots: Array<CompositionSlot & { intent: { kind: string; target: unknown } }> }).slots.map(value => {
      const raw = value.intent as unknown as { kind: string; target: SessionEntry };
      const intent = raw.kind === 'legacy_fixed'
        ? { kind: 'fixed' as const, target: { hostId: raw.target.hostId ?? 'local', native: { providerId: raw.target.providerId, nativeSessionId: raw.target.nativeSessionId } } }
        : value.intent;
      requireValue(value.origin || intent.kind !== 'role');
      const slot = { ...value, origin: value.origin ?? structuredClone(intent), intent } as CompositionSlot;
      const metadata = known.find(source => source.agentId === slot.owners.text.key);
      if (metadata) slot.metadata = compositionSessionMetadata(metadata);
      return slot;
    });
  }
  const find = (source: SessionEntry, id?: string): CompositionSlot => {
    const existing = id ? document.slots.find(slot => slot.id === id) : document.slots.find(slot => slot.intent.kind !== 'history' && sessionKey(compositionSelection(slot)) === sessionKey(source));
    if (existing) return existing;
    const key = sessionKey(source), slotId = id ?? compositionOriginId(source), value = createCompositionSlot(slotId, source, scope, {
      text: { scope, key: source.agentId ?? `view:${slotId}` }, image: { scope, key: JSON.stringify([scope, key]) }, display: { scope, key },
    });
    document.slots.push(value); return value;
  };
  for (const source of known) find(source);
  if (previous === undefined && path.length) {
    const slots = path.map(source => find(source));
    document.primary = slots[0]!.id;
    document.edges = slots.slice(0, -1).map((source, index) => ({ source: source.id, target: slots[index + 1]!.id, selected: true }));
    for (const [field, key] of [['address', 'addressKey'], ['focus', 'focus'], ['anchor', 'anchor']] as const) {
      const nativeKey = (layout as Record<string, string>)[key];
      if (nativeKey) document[field] = slots[path.findIndex(source => sessionKey(source) === nativeKey)]!.id;
    }
  }
  if (!document.primary && document.address) {
    let id = document.address; const visited = new Set<string>();
    for (let parent = document.edges.find(edge => edge.selected && edge.target === id); parent && !visited.has(id); parent = document.edges.find(edge => edge.selected && edge.target === id)) { visited.add(id); id = parent.source; }
    document.primary = id;
  }
  const tracked = readTrackedSessionsChecked(scope);
  requireValue(tracked.status === 'ready');
  if (tracked.status !== 'ready') throw tracked.error;
  if (oldTracks !== undefined) requireValue(object(oldTracks) && oldTracks.version === 1 && oldTracks.scope === scope && Array.isArray(oldTracks.entries) && Array.isArray(oldTracks.views));
  const companion = oldTracks as { entries: Array<{ entryId: string; slotId: string }>; views: Array<{ entryId: string; primarySlot: string; selections: Record<string, string | null>; focus?: string; anchor?: string }>; selected?: string } | undefined;
  for (const entry of tracked.sessions) {
    const entryId = entry.entryId ?? sessionKey(entry), owner = companion?.entries.find(value => value.entryId === entryId);
    const slot = find(entry, owner?.slotId ?? entry.entryId);
    document.tracks.push({ entryId, slotId: slot.id });
  }
  for (const saved of companion?.views ?? []) {
    const primary = document.slots.find(slot => slot.id === saved.primarySlot); requireValue(primary);
    let track = document.tracks.find(entry => entry.entryId === saved.entryId);
    if (!track) { track = { entryId: saved.entryId, slotId: primary!.id }; document.tracks.push(track); }
    const viewId = (key: string) => sessionKey(compositionSelection(primary!)) === key ? primary!.id : find(keySession(key)).id;
    track.view = { primarySlot: primary!.id, selections: Object.fromEntries(Object.entries(saved.selections).map(([source, target]) => [viewId(source), target === null ? null : viewId(target)])),
      ...(saved.focus ? { focus: viewId(saved.focus) } : {}), ...(saved.anchor ? { anchor: viewId(saved.anchor) } : {}) };
  }
  if (companion?.selected) document.selectedTrack = companion.selected;
  const open = read(conversationSessionStorage, `agent-remote-ask:${scope}:open-windows`);
  const single = open === undefined ? conversationSessionStorage.getItem(`agent-remote-ask:${scope}:open`) : null;
  requireValue(open === undefined || Array.isArray(open) && open.every(nonempty));
  const windows = new Set((open as string[] | undefined) ?? (single ? [single] : []));
  if (oldAsk !== undefined) requireValue(object(oldAsk) && oldAsk.version === 1 && oldAsk.scope === scope && Array.isArray(oldAsk.owners));
  const associations = (oldAsk as { owners: Array<AskAssociationOwner & { legacySourceKey: string; stateScope: string }> } | undefined)?.owners ?? [];
  for (const key of windows) if (!associations.some(owner => owner.id === key)) find(keySession(key));
  for (const slot of document.slots) {
    const existing = associations.find(owner => owner.sourceSlot === slot.id);
    const sourceKey = existing?.legacySourceKey ?? sessionKey(compositionSelection(slot));
    const preference = conversationLocalStorage.getItem(`agent-remote-ask:${scope}:enabled:${sourceKey}`) ?? localStorage.getItem('agent-remote-ask-enabled');
    requireValue(preference === null || preference === 'true' || preference === 'false');
    const owned = records.filter(record => sessionKey(record.source) === sourceKey);
    const target = owned.filter(record => record.target).at(-1)?.target;
    const owner: AskAssociationOwner = { id: existing?.id ?? `ask:${slot.id}`, sourceSlot: slot.id,
      input: { scope, key: `agent-remote-ask:${scope}:inputs:${sourceKey}` }, geometryScope: existing?.geometryScope ?? JSON.stringify([scope, sourceKey]),
      text: existing?.text ?? { scope: `${scope}:ask`, key: sourceKey },
      open: windows.has(sourceKey) || !!existing && windows.has(existing.id), ...(preference === null ? {} : { enabled: preference === 'true' }),
      image: existing?.image ?? { scope, key: JSON.stringify([scope, target ? sessionKey(target) : `ask:${slot.id}`]) },
      display: existing?.display ?? { scope, key: target ? sessionKey(target) : `ask:${slot.id}` },
      records: existing?.records ?? owned.map(record => ({ id: record.id, ...(record.target ? { target: sessionKey(record.target) } : {}) })),
    };
    document.asks.push(owner);
  }
  return parseComposition(document, scope);
}

function restoreTabComposition(scope: string): CompositionDocument {
  const document = restoreCompositionOwners(scope), tracked = readTrackedSessionsChecked(scope);
  requireValue(tracked.status === 'ready');
  if (tracked.status !== 'ready') throw tracked.error;
  for (const entry of tracked.sessions) {
    const entryId = entry.entryId ?? sessionKey(entry);
    let slot = document.slots.find(slot => slot.id === entryId)
      ?? document.slots.find(slot => slot.origin.kind === 'fixed' && sessionKey({ hostId: slot.origin.target.hostId, ...slot.origin.target.native }) === entryId)
      ?? document.slots.find(slot => slot.origin.kind === 'fixed' && sessionKey(compositionSelection(slot)) === sessionKey(entry));
    if (!slot) {
      slot = createCompositionSlot(compositionOriginId(entry), entry, scope);
      document.slots.push(slot); document.asks.push(createAskOwner(slot, scope));
    }
    document.tracks.push({ entryId, slotId: slot.id });
  }
  return parseComposition(document, scope);
}

/** Durable owner readback marks the upgrade; every tab keeps its own layout. */
export function initializeCompositionDocument(scope: string): CompositionRead<CompositionDocument> {
  const existing = readCompositionDocument(scope);
  const generation = recoveryGeneration(scope);
  const current = () => recoveryGeneration(scope) === generation;
  try {
    if (existing.status !== 'missing') {
      if (existing.status !== 'ready') return existing;
      retainCompositionOwners(existing.document, current);
      if (!refreshCompositionAskPreferences(existing.document)) {
        completeCompositionOwnerImport(scope, current);
        return existing;
      }
      existing.document.editRevision++;
    }
    const document = parseComposition(existing.status === 'ready' ? existing.document : compositionOwnersImported(scope) ? restoreTabComposition(scope) : importComposition(scope), scope);
    const write = saveCompositionDocument(document, current);
    flushRecoveryWrites(compositionMetadataKey(scope));
    if (write.result?.status !== 'saved') throw new Error('Session view import could not be saved. Original data has been preserved.');
    const verified = readCompositionDocument(scope);
    if (verified.status !== 'ready' || JSON.stringify(verified.document) !== JSON.stringify(document)) {
      conversationSessionStorage.removeItem(compositionMetadataKey(scope));
      throw new Error('Session view import could not be verified. Original data has been preserved.');
    }
    completeCompositionOwnerImport(scope, current);
    return verified;
  } catch (error) { return { status: 'failed', error }; }
}
