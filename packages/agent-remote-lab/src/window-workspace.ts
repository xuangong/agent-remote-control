import { bindWindowCompositionSlot, windowAskSourceAnchor } from './window-composition.js';
import { createWindowFeature, parseWindowFeature } from './window-feature-views.js';
import { applyWindowOperation, createWindowView, isWorkspaceWindow, type WindowOperation, type WindowSessionBinding, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { WindowWorkspaceClient, WindowSnapshot } from '@orchardworks/agent-remote-web';
import { conversationLocalStorage, conversationSessionStorage } from './conversation-storage.js';
import { sessionKey } from './session-tree.js';
import { compositionSelection, type CompositionDocument } from './session-composition.js';

export function windowSessionBinding(session: { hostId?: string; providerId: string; nativeSessionId: string; title: string; parentNativeSessionId?: string }): WindowSessionBinding {
  return { hostId: session.hostId ?? 'local', providerId: session.providerId, nativeSessionId: session.nativeSessionId, title: session.title,
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
    if (sessionKey(view.binding) !== sessionKey(compositionSelection(source))) continue;
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
  const main = createWindowView('main', binding && windowSessionBinding(binding), 'primary');
  const views = [main, ...(document.windows ?? []).map(entry => {
    const slot = document.slots.find(slot => slot.id === entry.slotId), selected = slot && compositionSelection(slot);
    const view = createWindowView(ids.get(entry.id)!, selected && windowSessionBinding(selected));
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
    const view = createWindowView(`child-${crypto.randomUUID()}`, windowSessionBinding(compositionSelection(child)), 'attached');
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
  const window: WorkspaceWindow = { schemaVersion: 1, id: crypto.randomUUID(), title: binding?.title ?? 'Window', revision: 0, primaryViewId: main.id,
    selectedViewId, mainMinimized: dock?.mainMinimized === true && views.some(view => view.placement === 'dock'), views: ordered };
  if (!isWorkspaceWindow(window)) throw new Error('The saved presentation could not be imported. Its original stores have been preserved.');
  importedSlots.set(window, slotViews);
  return window;
}
export function resolveWindowViewId(window: WorkspaceWindow, localId: string): string | undefined {
  return window.views.find(view => { const feature = parseWindowFeature(view.feature); return view.id === localId || feature && `${feature.kind}:${feature.id}` === localId; })?.id;
}
/** Serialized commands use the latest committed revision. A lost reply is settled by receipt lookup. */
export class WindowWorkspaceStore {
  private snapshot: WorkspaceWindow;
  private listeners = new Set<() => void>();
  private queue = Promise.resolve();
  private uncertain = false;
  constructor(initial: WorkspaceWindow, private readonly client?: WindowWorkspaceClient, private readonly cache?: (window: WorkspaceWindow) => void, private readonly localCommit?: (source: WorkspaceWindow, operation: WindowOperation) => Promise<WorkspaceWindow>) { this.snapshot = initial; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  accept(window: WorkspaceWindow) {
    if (!isWorkspaceWindow(window) || window.id !== this.snapshot.id || window.revision < this.snapshot.revision) return;
    this.snapshot = window; this.cache?.(window); for (const listener of this.listeners) listener();
  }
  operate(operation: WindowOperation): Promise<void> {
    const observedRevision = this.snapshot.revision;
    const replacesLayout = operation.type === 'layout.apply' || operation.type === 'batch' && operation.operations.some(edit => edit.type === 'layout.apply');
    const run = async () => {
      if (this.uncertain) throw new Error('The prior Window operation is unresolved. Reopen this Window to inspect its current state.');
      if (replacesLayout && this.snapshot.revision !== observedRevision) throw new Error('The Window changed before applying this layout. Refresh and retry.');
      if (!this.client) { this.accept(this.localCommit ? await this.localCommit(this.snapshot, operation) : applyWindowOperation(this.snapshot, operation)); return; }
      const mutation = { operationId: crypto.randomUUID(), issuedAt: Date.now(), baseRevision: this.snapshot.revision, operation };
      let commit;
      try { commit = await this.client.mutate(this.snapshot.id, mutation); }
      catch (error) {
        let result;
        try { result = await this.client.operation(this.snapshot.id, mutation.operationId); }
        catch {
          // A known HTTP rejection can be refreshed safely; an unknown transport outcome blocks further edits.
          if (error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
            const current = await this.client.inspect(this.snapshot.id); this.accept(current.window); throw error;
          }
          this.uncertain = true; throw error;
        }
        const current = await this.client.inspect(this.snapshot.id); this.accept(current.window);
        if (result.status !== 'committed') throw new Error(result.message ?? 'Window operation rejected.');
        return;
      }
      this.accept(commit.window);
      if (commit.result.status !== 'committed') throw new Error(commit.result.message ?? 'Window operation rejected.');
    };
    const result = this.queue.then(run); this.queue = result.catch(() => {}); return result;
  }
  async synchronize(signal: AbortSignal): Promise<void> {
    if (!this.client) return;
    let initialized = false, failures = 0;
    while (!signal.aborted) {
      try {
        const next: WindowSnapshot | undefined = initialized ? await this.client.changes(this.snapshot.id, this.snapshot.revision, signal) : await this.client.inspect(this.snapshot.id, signal);
        if (next) this.accept(next.window); initialized = true; failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof Error && 'status' in error && [401, 403, 404].includes(Number(error.status))) throw error;
        initialized = false;
        await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, Math.min(10000, 250 * 2 ** Math.min(failures++, 6))); signal.addEventListener('abort', done, { once: true }); });
      }
    }
  }
}
