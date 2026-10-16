import { bindWindowCompositionSlot, windowAskSourceAnchor } from './window-composition.js';
import { createWindowFeature, parseWindowFeature } from './window-feature-views.js';
import { applyWindowOperation, createWindowView, isWorkspaceWindow, type WindowOperation, type WindowSessionBinding, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { conversationLocalStorage, conversationSessionStorage } from './conversation-storage.js';
import { sessionKey } from './session-tree.js';
import { compositionSelection, type CompositionDocument } from './session-composition.js';

export function windowSessionBinding(session: { hostId?: string; providerId: string; nativeSessionId: string; title: string; parentNativeSessionId?: string; sessionIntent?: 'history' }, sessionIntent = session.sessionIntent): WindowSessionBinding {
  return { hostId: session.hostId ?? 'local', providerId: session.providerId, nativeSessionId: session.nativeSessionId, title: session.title,
    ...(sessionIntent ? { sessionIntent } : {}),
    ...(session.parentNativeSessionId ? { parentNativeSessionId: session.parentNativeSessionId } : {}) };
}
const importedSlots = new WeakMap<WorkspaceWindow, Map<string, string>>();
/** Page-local recovery metadata; these associations never establish native authority. */
export function captureImportedWindowComposition(candidate: WorkspaceWindow): Array<[string, string]> {
  return [...importedSlots.get(candidate) ?? []];
}
export function restoreImportedWindowComposition(document: CompositionDocument, candidate: WorkspaceWindow, value: unknown): void {
  if (!Array.isArray(value) || value.length > 64) return;
  const entries = new Map<string, string>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue;
    const [slotId, viewId] = entry;
    const source = document.slots.find(slot => slot.id === slotId);
    const view = candidate.views.find(view => view.id === viewId);
    if (!source || !view?.binding || document.windowBindings?.some(binding => binding.slotId === slotId)
      || (source.intent.kind === 'history') !== (view.binding.sessionIntent === 'history')
      || sessionKey(view.binding) !== sessionKey(compositionSelection(source))) continue;
    entries.set(slotId, viewId);
  }
  importedSlots.set(candidate, entries);
}

/** Candidate imports do not claim owners until their Window creation has settled. */
export function commitImportedWindowComposition(document: CompositionDocument, candidate: WorkspaceWindow, committed: WorkspaceWindow = candidate): void {
  if (candidate.id !== committed.id) throw new Error('The committed Window does not match its import candidate.');
  for (const [slotId, viewId] of importedSlots.get(candidate) ?? []) {
    const view = committed.views.find(view => view.id === viewId);
    const source = document.slots.find(slot => slot.id === slotId);
    if (!view?.binding || !source || document.windowBindings?.some(entry => entry.slotId === slotId)) continue;
    if ((source.intent.kind === 'history') !== (view.binding.sessionIntent === 'history')
      || sessionKey(view.binding) !== sessionKey(compositionSelection(source))) continue;
    bindWindowCompositionSlot(document, committed.id, viewId, view.binding, slotId);
  }
  importedSlots.delete(candidate);
}

export function importCompositionWindow(document: CompositionDocument): WorkspaceWindow {
  const read = (key: string, local = false): any => { try { return JSON.parse((local ? conversationLocalStorage : conversationSessionStorage).getItem(key) ?? 'null'); } catch { return undefined; } };
  const validId = (id: string) => /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? id : `view-${crypto.randomUUID()}`;
  const legacy = document.windows === undefined ? read(`agent-remote:recovery:${document.scope}:session-windows`) : undefined;
  const legacyEntries = (Array.isArray(legacy) ? legacy : []).filter(value => value?.target && ['hostId', 'providerId', 'nativeSessionId', 'title'].every(key => typeof value.target[key] === 'string' && value.target[key]));
  const ids = new Map((document.windows ?? []).map(entry => [entry.id, validId(entry.id)]));
  const primary = document.slots.find(slot => slot.id === document.primary);
  const binding = primary && compositionSelection(primary);
  const main = createWindowView('main', binding && windowSessionBinding(binding, primary?.intent.kind === 'history' ? 'history' : undefined), 'primary');
  const views = [main, ...(document.windows ?? []).map(entry => {
    const slot = document.slots.find(slot => slot.id === entry.slotId), selected = slot && compositionSelection(slot);
    const view = createWindowView(ids.get(entry.id)!, selected && windowSessionBinding(selected, slot?.intent.kind === 'history' ? 'history' : undefined));
    if (entry.closeWith && ids.has(entry.closeWith)) view.closeWith = ids.get(entry.closeWith);
    const root = entry.closeWith ? document.windows?.find(root => root.id === entry.closeWith) : entry;
    const teamId = entry.groupId ?? root?.groupId ?? slot?.metadata?.teamId;
    const memberId = entry.teamMemberId ?? slot?.metadata?.teamMemberId;
    if (teamId) {
      view.feature = createWindowFeature({ kind: 'team', id: teamId, ...(memberId ? { memberId } : {}), role: entry.closeWith ? 'member' : 'leader' });
      view.bindingPolicy = 'managed';
    }
    return view;
  })];
  for (const entry of legacyEntries) {
    const oldId = `session:${sessionKey(entry.target)}`;
    if (ids.has(oldId)) continue;
    const view = createWindowView(validId(oldId), windowSessionBinding(entry.target)); ids.set(oldId, view.id);
    const root = entry.closeWith ? legacyEntries.find(root => `session:${sessionKey(root.target)}` === entry.closeWith) : entry;
    const teamId = entry.groupId ?? root?.groupId ?? entry.target.teamId;
    const memberId = entry.teamMemberId ?? entry.target.teamMemberId;
    if (teamId) {
      view.feature = createWindowFeature({ kind: 'team', id: teamId, ...(memberId ? { memberId } : {}), role: entry.closeWith ? 'member' : 'leader' });
      view.bindingPolicy = 'managed';
    }
    views.push(view);
  }
  for (const entry of legacyEntries) { const id = ids.get(`session:${sessionKey(entry.target)}`), parent = ids.get(entry.closeWith); if (id && parent && id !== parent) views.find(view => view.id === id)!.closeWith = parent; }
  const slotViews = new Map<string, string>(); if (primary) slotViews.set(primary.id, main.id);
  for (const entry of document.windows ?? []) if (entry.slotId) slotViews.set(entry.slotId, ids.get(entry.id)!);
  // Composition retains native owners; only presentation facts are imported here.
  let parentSlot = document.primary, parentView = main.id;
  const visited = new Set<string>();
  while (parentSlot && !visited.has(parentSlot)) {
    visited.add(parentSlot);
    const edge = document.edges.find(edge => edge.source === parentSlot && edge.selected);
    const child = document.slots.find(slot => slot.id === edge?.target);
    if (!child) break;
    const view = createWindowView(`child-${crypto.randomUUID()}`, windowSessionBinding(compositionSelection(child), child.intent.kind === 'history' ? 'history' : undefined), 'attached');
    view.attachedTo = parentView; view.collapsed = document.collapsed.includes(child.id);
    views.splice(views.findIndex(item => item.id === parentView) + 1, 0, view); slotViews.set(child.id, view.id);
    parentView = view.id; parentSlot = child.id;
  }
  for (const owner of document.asks.filter(owner => owner.open)) {
    const sourceViewId = slotViews.get(owner.sourceSlot); if (!sourceViewId) continue;
    const view = createWindowView(`ask-${crypto.randomUUID()}`, undefined, 'float');
    const sourceSlot = document.slots.find(slot => slot.id === owner.sourceSlot);
    view.feature = createWindowFeature({ kind: 'ask', id: owner.id, ...(sourceSlot ? { source: windowAskSourceAnchor(document, sourceSlot) } : {}) });
    view.bindingPolicy = 'managed';
    view.closeWith = sourceViewId;
    views.push(view);
  }
  const tpm = read(`agent-remote:recovery:${document.scope}:tpm-windows`);
  for (const key of Array.isArray(tpm) ? tpm : []) {
    if (typeof key !== 'string') continue;
    try { const [hostId, workId] = JSON.parse(key); if (typeof hostId !== 'string' || typeof workId !== 'string') continue;
      const view = createWindowView(`tpm-${crypto.randomUUID()}`, undefined, 'float');
      view.feature = createWindowFeature({ kind: 'tpm', id: key, hostId });
      view.bindingPolicy = 'managed';
      views.push(view);
    } catch { /* Invalid legacy catalog references remain in their original store. */ }
  }
  const dock = read(`agent-remote:recovery:${document.scope}:workspace-dock`);
  const panes: Array<{id:string;width:number}> = Array.isArray(dock?.panes) ? dock.panes : [];
  for (const view of [...views]) {
    const oldId = [...ids].find(([, id]) => id === view.id)?.[0] ?? view.id;
    const owner = parseWindowFeature(view.feature)?.kind === 'ask' ? document.asks.find(owner => owner.id === view.feature!.id) : undefined;
    const placementId = owner ? `ask:${owner.geometryScope}` : parseWindowFeature(view.feature)?.kind === 'tpm' ? `tpm:${view.feature!.id}` : oldId;
    const pane = panes.find(pane => pane.id === placementId);
    if (view.placement !== 'primary' && view.placement !== 'attached') view.placement = pane ? 'dock' : 'float';
    const width = view.placement === 'primary' ? dock?.baseWidth : pane?.width;
    if (typeof width === 'number' && Number.isFinite(width)) view.width = Math.max(240, Math.min(1600, width));
    const slot = document.slots.find(slot => slotViews.get(slot.id) === view.id);
    const displayKey = owner?.display?.key ?? (view.id === main.id ? slot?.owners.display.key : oldId);
    const display = displayKey && read(`agent-remote:recovery:${document.scope}:view:${displayKey}`, true);
    if (display && ['preview', 'simple', 'content'].includes(display.mode) && typeof display.lettersVisible === 'boolean') view.display = { mode: display.mode, lettersVisible: display.lettersVisible };
    const geometryScope = owner?.geometryScope ?? (parseWindowFeature(view.feature)?.kind === 'tpm' ? JSON.stringify([document.scope, 'tpm', view.feature!.id]) : JSON.stringify([document.scope, oldId]));
    const position = read(`agent-remote-ask:${geometryScope}:window-position`, true), size = read(`agent-remote-ask:${geometryScope}:window-size`, true);
    if (position && size && [position.x, position.y, size.width, size.height].every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) view.geometry = { x: Math.max(0, Math.min(100000, position.x)), y: Math.max(0, Math.min(100000, position.y)), width: Math.max(240, Math.min(1600, size.width)), height: Math.max(120, Math.min(4000, size.height)) };
    if (view.binding && !view.attachedTo) {
      const familyKey = `agent-remote:recovery:${document.scope}:session-family:${oldId}:${sessionKey(view.binding)}`;
      const family = read(familyKey), widths = read(`${familyKey}:widths`);
      let parent = view;
      for (const target of Array.isArray(family?.children) ? family.children : []) {
        if (target?.hostId !== view.binding.hostId || target?.providerId !== view.binding.providerId || typeof target?.nativeSessionId !== 'string' || typeof target?.title !== 'string' || target.parentNativeSessionId !== parent.binding?.nativeSessionId) break;
        const child = createWindowView(`child-${crypto.randomUUID()}`, windowSessionBinding(target), 'attached'); child.attachedTo = parent.id;
        const width = widths?.[sessionKey(target)]; if (typeof width === 'number' && Number.isFinite(width)) child.width = Math.max(240, Math.min(1600, width));
        views.splice(views.indexOf(parent) + 1, 0, child); parent = child;
      }
    }
  }
  const order = (view: typeof main) => panes.findIndex(pane => pane.id === ([...ids].find(([, id]) => id === view.id)?.[0] ?? (view.feature ? `${view.feature.kind}:${parseWindowFeature(view.feature)?.kind === 'ask' ? document.asks.find(owner => owner.id === view.feature!.id)?.geometryScope : view.feature!.id}` : view.id)));
  const roots = views.filter(view => view.placement !== 'primary' && !view.attachedTo);
  const mainGroup = views.filter(view => view.id === main.id || view.attachedTo && (() => { let parent = views.find(item => item.id === view.attachedTo); while (parent?.attachedTo) parent = views.find(item => item.id === parent!.attachedTo); return parent?.id === main.id; })());
  roots.sort((left, right) => { const a = order(left), b = order(right); return a < 0 ? b < 0 ? 0 : 1 : b < 0 ? -1 : a - b; });
  const ordered = [...mainGroup];
  for (const root of roots) { ordered.push(root); let parent = root.id; for (;;) { const child = views.find(view => view.attachedTo === parent); if (!child) break; ordered.push(child); parent = child.id; } }
  const selectedViewId = document.activeWindow && ids.get(document.activeWindow) || document.focus && slotViews.get(document.focus) || main.id;
  main.collapsed = dock?.mainMinimized === true && views.some(view => view.placement === 'dock');
  const window: WorkspaceWindow = { schemaVersion: 2, id: crypto.randomUUID(), title: binding?.title ?? 'Window', revision: 0, selectedPrimaryViewId: main.id,
    selectedViewId, views: ordered };
  if (!isWorkspaceWindow(window)) throw new Error('The saved presentation could not be imported. Its original stores have been preserved.');
  importedSlots.set(window, slotViews);
  return window;
}
export function resolveWindowViewId(window: WorkspaceWindow, localId: string): string | undefined {
  return window.views.find(view => { const feature = parseWindowFeature(view.feature); return view.id === localId || feature && `${feature.kind}:${feature.id}` === localId; })?.id;
}
export { WindowWorkspaceStore } from './window-workspace-store.js';
