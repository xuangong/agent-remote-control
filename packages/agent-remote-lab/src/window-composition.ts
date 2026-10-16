import { parseWindowFeature, type WindowAskSourceAnchor } from './window-feature-views.js';
import type { WindowSessionBridge } from './window-session-bridge-context.js';
import type { WindowSessionBinding, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { compositionOriginId, compositionRoleKey, compositionSelection, createAskOwner, createCompositionSlot, createHistorySlot, type CompositionDocument, type CompositionSlot } from './session-composition.js';
import { sessionKey } from './session-tree.js';

export const windowSlotPrefix = (windowId: string, viewId: string) => `window:${encodeURIComponent(windowId)}:${encodeURIComponent(viewId)}:`;
export const windowBindingKey = (binding: WindowSessionBinding) => binding.sessionIntent === 'history'
  ? JSON.stringify([binding.hostId, binding.providerId, binding.nativeSessionId, 'history']) : sessionKey(binding);

function ownsSlot(document: CompositionDocument, slotId: string, windowId: string, viewId: string): boolean {
  return !(document.windowBindings ?? []).some(entry => entry.slotId === slotId && (entry.windowId !== windowId || entry.viewId !== viewId));
}

function slotMatchesBinding(document: CompositionDocument, slot: CompositionSlot, binding: WindowSessionBinding): boolean {
  const key = sessionKey(binding);
  if (binding.sessionIntent === 'history') return slot.intent.kind === 'history' && sessionKey(compositionSelection(slot)) === key;
  if (slot.intent.kind === 'history') return false;
  if ([compositionSelection(slot), { hostId: slot.origin.target.hostId, ...slot.origin.target.native }].some(target => sessionKey(target) === key)) return true;
  if (slot.intent.kind !== 'role') return false;
  const intent = slot.intent;
  return document.roles.some(role => compositionRoleKey(role) === intent.roleKey && role.hostId === binding.hostId
    && role.appliedRevision === role.desired.committedRevision && role.appliedRevision >= intent.revision
    && role.documents.composition.status === 'applied'
    && [role.desired.from, role.desired.to].some(native => native.providerId === binding.providerId && native.nativeSessionId === binding.nativeSessionId));
}

/** Register a locally established identity without renaming its owners or native binding. */
export function bindWindowCompositionSlot(document: CompositionDocument, windowId: string, viewId: string, binding: WindowSessionBinding, slotId: string): CompositionSlot {
  const slot = document.slots.find(slot => slot.id === slotId);
  if (!slot || !slotMatchesBinding(document, slot, binding)) throw new Error('The Window view does not match its local session slot.');
  if (!ownsSlot(document, slotId, windowId, viewId)) throw new Error('The local session slot already belongs to another Window view.');
  const entries = document.windowBindings ??= [];
  const bindingKey = windowBindingKey(binding);
  const existing = entries.find(entry => entry.windowId === windowId && entry.viewId === viewId && entry.bindingKey === bindingKey);
  if (existing?.slotId === slotId) return slot;
  if (existing) existing.slotId = slotId;
  else {
    if (entries.length >= 4096) throw new Error('The local Window binding capacity has been reached.');
    entries.push({ windowId, viewId, bindingKey, slotId });
  }
  document.editRevision++;
  return slot;
}

/** New duplicate views allocate owners; adopted views keep their existing native identity. */
export function ensureWindowCompositionSlot(document: CompositionDocument, windowId: string, viewId: string, binding: WindowSessionBinding): CompositionSlot {
  const entries = (document.windowBindings ?? []).filter(entry => entry.windowId === windowId && entry.viewId === viewId);
  const exact = entries.find(entry => entry.bindingKey === windowBindingKey(binding));
  const existing = exact && document.slots.find(slot => slot.id === exact.slotId);
  if (existing && slotMatchesBinding(document, existing, binding)) return existing;
  const current = entries.flatMap(entry => document.slots.filter(slot => slot.id === entry.slotId)).find(slot => slotMatchesBinding(document, slot, binding));
  if (current) return bindWindowCompositionSlot(document, windowId, viewId, binding, current.id);
  if ((document.windowBindings?.length ?? 0) >= 4096) throw new Error('The local Window binding capacity has been reached.');
  const { role: _, sessionIntent, ...session } = binding;
  const slotId = `${windowSlotPrefix(windowId, viewId)}${compositionOriginId(binding, sessionIntent === 'history')}`;
  const retained = document.slots.find(slot => slot.id === slotId && slotMatchesBinding(document, slot, binding) && ownsSlot(document, slot.id, windowId, viewId));
  if (retained) {
    if (!document.asks.some(owner => owner.sourceSlot === retained.id)) { document.asks.push(createAskOwner(retained, document.scope)); document.editRevision++; }
    return bindWindowCompositionSlot(document, windowId, viewId, binding, retained.id);
  }
  const slot = sessionIntent === 'history' ? createHistorySlot(slotId, { hostId: binding.hostId,
    native: { providerId: binding.providerId, nativeSessionId: binding.nativeSessionId } }, document.scope) : createCompositionSlot(slotId, session, document.scope);
  slot.metadata = { ...slot.metadata, title: binding.title, ...(binding.parentNativeSessionId ? { parentNativeSessionId: binding.parentNativeSessionId } : {}) };
  const enrolled = sessionIntent !== 'history' && document.slots.find(candidate => candidate.intent.kind === 'role' && sessionKey(compositionSelection(candidate)) === sessionKey(binding)
    && document.roles.some(role => candidate.intent.kind === 'role' && compositionRoleKey(role) === candidate.intent.roleKey
      && role.appliedRevision >= candidate.intent.revision && role.documents.composition.status === 'applied'));
  if (enrolled) slot.intent = structuredClone(enrolled.intent);
  document.slots.push(slot);
  document.asks.push(createAskOwner(slot, document.scope));
  document.editRevision++;
  return bindWindowCompositionSlot(document, windowId, viewId, binding, slot.id);
}

/** First adoption records the selected primary identity; it never migrates native state. */
export function adoptWindowPrimaryRole(document: CompositionDocument, window: WorkspaceWindow): CompositionSlot | undefined {
  const binding = window.views.find(view => view.id === window.selectedPrimaryViewId)?.binding;
  const source = document.slots.find(slot => slot.id === document.primary);
  if (!binding || !source || !slotMatchesBinding(document, source, binding) || !ownsSlot(document, source.id, window.id, window.selectedPrimaryViewId)) return;
  return bindWindowCompositionSlot(document, window.id, window.selectedPrimaryViewId, binding, source.id);
}

/** Source anchors are references; only locally verified role checkpoints authorize succession. */
export function windowAskSourceAnchor(document: CompositionDocument, slot: CompositionSlot): WindowAskSourceAnchor {
  const source = compositionSelection(slot);
  const roleKey = slot.intent.kind === 'role' && document.roles.some(role => slot.intent.kind === 'role'
    && compositionRoleKey(role) === slot.intent.roleKey && role.appliedRevision >= slot.intent.revision
    && role.documents.composition.status === 'applied') ? slot.intent.roleKey : undefined;
  return { hostId: source.hostId ?? 'local', providerId: source.providerId, nativeSessionId: source.nativeSessionId,
    ...(roleKey ? { roleKey } : {}), ...(slot.metadata?.agentId ? { agentId: slot.metadata.agentId } : {}), ...(source.title ? { title: source.title } : {}) };
}
export function windowAskSourceMatches(document: CompositionDocument, slot: CompositionSlot, source: WindowAskSourceAnchor): boolean {
  const local = windowAskSourceAnchor(document, slot);
  return source.roleKey && local.roleKey ? source.roleKey === local.roleKey
    : sessionKey(local) === sessionKey(source) || sessionKey({ hostId: slot.origin.target.hostId, ...slot.origin.target.native }) === sessionKey(source);
}

/** Retain an addressable local reference for every open Ask, even after its main source changes. */
export function ensureWindowAskSources(document: CompositionDocument, window: WorkspaceWindow): void {
  for (const view of window.views) {
    const feature = parseWindowFeature(view.feature);
    if (feature?.kind !== 'ask' || !feature.source || !view.closeWith) continue;
    const source = feature.source;
    const id = `${windowSlotPrefix(window.id, view.closeWith)}ask-source:${feature.id}`;
    const retained = document.slots.find(slot => slot.id === id && windowAskSourceMatches(document, slot, source) && ownsSlot(document, slot.id, window.id, view.closeWith!));
    if (retained) {
      bindWindowCompositionSlot(document, window.id, view.closeWith, { ...source, title: source.title ?? 'Session' }, retained.id);
      if (!document.asks.some(owner => owner.sourceSlot === retained.id)) { document.asks.push(createAskOwner(retained, document.scope)); document.editRevision++; }
      continue;
    }
    const held = document.slots.find(slot => windowAskSourceMatches(document, slot, source)
      && document.windowBindings?.some(entry => entry.windowId === window.id && entry.viewId === view.closeWith && entry.slotId === slot.id));
    if (held) continue;
    if ((document.windowBindings?.length ?? 0) >= 4096) throw new Error('The local Window binding capacity has been reached.');
    const slot = createCompositionSlot(id, { ...source, title: source.title ?? 'Session' }, document.scope);
    document.slots.push(slot); document.asks.push(createAskOwner(slot, document.scope)); document.editRevision++;
    bindWindowCompositionSlot(document, window.id, view.closeWith, { ...source, title: source.title ?? 'Session' }, slot.id);
  }
}

export function windowCompositionMapping(document: CompositionDocument, window: WorkspaceWindow) {
  ensureWindowAskSources(document, window);
  return new Map(window.views.flatMap(view => {
    if (!view.binding) return [];
    const slot = ensureWindowCompositionSlot(document, window.id, view.id, view.binding);
    const feature = parseWindowFeature(view.feature);
    if (feature?.kind === 'team') slot.metadata = { title: slot.metadata?.title ?? view.binding!.title, ...slot.metadata, teamId: feature.id, ...(feature.memberId ? { teamMemberId: feature.memberId } : {}) };
    return [[view.id, slot] as const];
  }));
}
export function primaryWindowFamily(window: WorkspaceWindow, primaryViewId = window.selectedPrimaryViewId): Set<string> {
  const ids = new Set([primaryViewId]);
  for (const view of window.views) if (view.attachedTo && ids.has(view.attachedTo)) ids.add(view.id);
  return ids;
}
/** One-way projection: it must never emit a Window mutation or reconnect the selected primary. */
export function projectWindowComposition(document: CompositionDocument, window: WorkspaceWindow): boolean {
  const slots = windowCompositionMapping(document, window), family = primaryWindowFamily(window);
  const primary = slots.get(window.selectedPrimaryViewId);
  if (!primary) {
    if (!document.primary && !document.address && !document.focus && !document.anchor && !document.edges.length && !document.collapsed.length) return false;
    delete document.primary; delete document.address; delete document.focus; delete document.anchor;
    document.edges = []; document.collapsed = []; document.editRevision++; return true;
  }
  const selected = slots.get(window.selectedViewId);
  const edges = window.views.flatMap(view => view.attachedTo && family.has(view.id) && slots.has(view.id) && slots.has(view.attachedTo)
    ? [{ source: slots.get(view.attachedTo)!.id, target: slots.get(view.id)!.id, selected: true }] : []);
  const focus = selected && family.has(window.selectedViewId) ? selected.id : primary.id;
  const next = { primary: primary.id, address: focus, focus, anchor: focus, edges,
    collapsed: window.views.filter(view => family.has(view.id) && view.collapsed && slots.has(view.id)).map(view => slots.get(view.id)!.id) };
  if (Object.entries(next).every(([key, value]) => JSON.stringify(document[key as keyof CompositionDocument]) === JSON.stringify(value))) return false;
  Object.assign(document, next); document.editRevision++; return true;
}

/** Only verified role checkpoints may advance a shared session binding. */
export function windowSuccessionLayout(document: CompositionDocument, window: WorkspaceWindow): import('@orchardworks/agent-remote-protocol').WindowOperation | undefined {
  const slots = windowCompositionMapping(document, window);
  let changed = false;
  const views = window.views.map(view => {
    const slot = slots.get(view.id);
    if (!view.binding || view.binding.sessionIntent === 'history' || !slot || slot.intent.kind !== 'role') return view;
    const intent = slot.intent;
    const checkpoint = document.roles.find(role => compositionRoleKey(role) === intent.roleKey
      && role.appliedRevision >= intent.revision
      && role.documents.composition.status === 'applied');
    if (!checkpoint || sessionKey(view.binding) === sessionKey(compositionSelection(slot))) return view;
    changed = true;
    return { ...view, binding: { hostId: slot.intent.target.hostId, providerId: slot.intent.target.native.providerId,
      nativeSessionId: slot.intent.target.native.nativeSessionId, title: slot.metadata?.title ?? view.binding.title,
      ...(slot.metadata?.parentNativeSessionId ? { parentNativeSessionId: slot.metadata.parentNativeSessionId } : {}),
      role: { controllerId: checkpoint.controllerId, roleId: checkpoint.roleId, revision: slot.intent.revision } } };
  });
  if (!changed) return;
  const { schemaVersion: _, id: __, revision: ___, ...layout } = window;
  return { type: 'layout.apply', layout: { ...layout, views } };
}

/** Application identity adaptation stays outside the generic layout authority. */
export function resolveCompositionWindowViewId(document: CompositionDocument, window: WorkspaceWindow, localId: string): string | undefined {
  const direct = window.views.find(view => {
    const feature = parseWindowFeature(view.feature);
    return view.id === localId || feature && `${feature.kind}:${feature.id}` === localId;
  });
  if (direct) return direct.id;
  const askOwner = document.asks.find(owner => owner.id === localId || owner.display?.key === localId || `ask:${owner.geometryScope}` === localId);
  if (askOwner) return window.views.find(view => {
    const feature = parseWindowFeature(view.feature);
    return feature?.kind === 'ask' && feature.id === askOwner.id;
  })?.id;
  const slot = document.slots.find(slot => slot.id === localId || slot.owners.display.key === localId);
  if (!slot) return;
  const mapped = document.windowBindings?.find(entry => entry.windowId === window.id && entry.slotId === slot.id);
  const stable = window.views.find(view => view.id === mapped?.viewId);
  if (stable) return stable.id;
  try {
    const parts: unknown = JSON.parse(slot.id);
    if (Array.isArray(parts) && parts.includes(window.id)) {
      const view = window.views.find(view => parts.includes(view.id));
      if (view) return view.id;
    }
  } catch { /* Legacy slots fall back to their native reference. */ }
  return window.views.find(view => view.binding && sessionKey(view.binding) === sessionKey(compositionSelection(slot)))?.id;
}

export function createWindowSessionBridge(document: CompositionDocument, window: WorkspaceWindow): WindowSessionBridge {
  return {
    slotForView(viewId) {
      const view = window.views.find(view => view.id === viewId);
      return view?.binding ? ensureWindowCompositionSlot(document, window.id, view.id, view.binding) : undefined;
    },
  };
}
