import { useCallback, useEffect, useRef, useReducer } from 'react';
import type { WindowOperation, WindowSessionBinding, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { compositionSelection } from '../session-composition.js';
import { adoptWindowPrimaryRole, primaryWindowFamily, windowBindingKey, windowCompositionMapping, windowSuccessionLayout } from '../window-composition.js';
import { windowSessionBinding } from '../window-workspace.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import type { OpenedSession } from '../directory-client.js';
import type { useSessionSuccession } from './useSessionSuccession.js';

type Succession = Pick<ReturnType<typeof useSessionSuccession>, 'document' | 'desired' | 'selected' | 'discovering' | 'navigationIntent' | 'open' | 'openAttached' | 'ensureWindowView' | 'bindWindowView' | 'projectWindow' | 'leave' | 'clearPresentation'>;
interface Options {
  window?: WorkspaceWindow;
  unavailable?: boolean;
  readWindow?(): WorkspaceWindow | undefined;
  operate(operation: WindowOperation): Promise<void>;
  succession: Succession;
  enabled: boolean;
  onError(error: unknown): void;
}

/** Projects committed Window bindings into native Session Views without owning native execution. */
export function useWindowSessionBridge(options: Options) {
  const latest = useRef(options); latest.current = options;
  const pending = useRef(new Map<string, number>());
  const [settled, refreshProjection] = useReducer(value => value + 1, 0);
  const adopted = useRef(new Set<string>());
  const projectedGroup = useRef<string>();
  const projected = useRef<string>();
  const successionAttempt = useRef<string>();
  const { window, succession, enabled } = options;
  const adoptedDocument = useRef(succession.document);
  if (adoptedDocument.current !== succession.document) {
    adoptedDocument.current = succession.document;
    adopted.current.clear();
    projected.current = undefined;
    projectedGroup.current = undefined;
  }
  const groupKey = window && JSON.stringify([window.id, window.selectedPrimaryViewId]);
  const history = succession.navigationIntent.sessionIntent === 'history';
  const primary = window?.views.find(view => view.id === window.selectedPrimaryViewId);
  const concreteHistory = window ? primary?.binding?.sessionIntent === 'history' : history;
  const initialized = adopted.current.size > 0;
  if (window && groupKey && enabled && (!succession.discovering || initialized) && !adopted.current.has(groupKey)) {
    adoptWindowPrimaryRole(succession.document, window); adopted.current.add(groupKey);
  }
  const slots = window && (!succession.discovering || initialized || adopted.current.has(groupKey!)) ? windowCompositionMapping(succession.document, window) : undefined;
  const primarySlot = window && slots?.get(window.selectedPrimaryViewId);
  const empty = !!options.unavailable || !!window && !primary?.binding;
  useEffect(() => {
    if (!enabled || groupKey && pending.current.has(groupKey)) return;
    if (succession.discovering && (!slots || projectedGroup.current === groupKey)) return;
    if (!window && concreteHistory) return;
    succession.projectWindow(window);
    if (!window) { projected.current = undefined; projectedGroup.current = undefined; return; }
    projectedGroup.current = groupKey;
    const key = JSON.stringify([groupKey, primarySlot?.id]);
    if (!primary?.binding || !primarySlot) {
      if (projected.current !== key) { succession.clearPresentation(); projected.current = key; }
      return;
    }
    projected.current = key;
    if (history === concreteHistory && succession.desired?.slot.id === primarySlot.id && succession.selected && sessionKey(succession.selected) === sessionKey(compositionSelection(primarySlot))) return;
    let cancelled = false;
    void succession.open(compositionSelection(primarySlot), primary.binding.sessionIntent, undefined, primarySlot.id)
      .then(opened => {
        const current = latest.current.window;
        if (opened && !cancelled && current?.id === window.id && current.selectedPrimaryViewId === window.selectedPrimaryViewId) latest.current.succession.projectWindow(current);
      })
      .catch(error => { if (!cancelled) latest.current.onError(error); });
    return () => { cancelled = true; };
  }, [groupKey, window?.revision, primarySlot?.id, succession.document, enabled, concreteHistory, settled]);
  useEffect(() => {
    if (!window || succession.discovering || pending.current.size) return;
    const operation = windowSuccessionLayout(succession.document, window);
    const key = operation && JSON.stringify([window.id, window.revision, operation]);
    if (!operation || key === successionAttempt.current) return;
    successionAttempt.current = key;
    void options.operate(operation).catch(error => latest.current.onError(error));
  }, [window?.id, window?.revision, succession.document.editRevision, succession.discovering, concreteHistory, settled]);

  const openPrimary = useCallback(async (session: SessionEntry, attached?: OpenedSession, restoreLayout = false, keepOriginal?: boolean, slotId?: string, targetViewId?: string, sessionIntent?: 'history', expectedBinding?: WindowSessionBinding | null): Promise<boolean> => {
    const current = latest.current, targetWindow = current.window;
    if (current.unavailable) throw new Error('Choose an available Window before opening a session.');
    if (!targetWindow) return sessionIntent ? current.succession.open(session, sessionIntent, keepOriginal, slotId) : attached ? current.succession.openAttached(attached, restoreLayout) : current.succession.open(session);
    const viewId = targetViewId ?? targetWindow.selectedPrimaryViewId, targetGroup = JSON.stringify([targetWindow.id, viewId]);
    if (!targetWindow.views.some(view => view.id === viewId && view.placement === 'primary')) throw new Error('The target primary view is unavailable.');
    const requestedBinding = windowSessionBinding(session, sessionIntent);
    const operation: WindowOperation = { type: 'batch', operations: [
      { type: 'view.bind', viewId, binding: requestedBinding, ...(expectedBinding !== undefined ? { expectedBinding } : {}) },
      ...(targetWindow.selectedPrimaryViewId === viewId ? [{ type: 'view.select' as const, viewId }] : []),
    ] };
    if (slotId && !current.succession.document.windowBindings?.some(entry => entry.slotId === slotId && (entry.windowId !== targetWindow.id || entry.viewId !== viewId))) {
      current.succession.bindWindowView(targetWindow.id, viewId, requestedBinding, slotId);
    }
    pending.current.set(targetGroup, (pending.current.get(targetGroup) ?? 0) + 1);
    try {
      await current.operate(operation);
      const next = latest.current;
      const committed = next.readWindow ? next.readWindow() : next.window;
      if (committed?.id !== targetWindow.id) return false;
      const binding = committed.views.find(view => view.id === viewId)?.binding;
      if (!binding || windowBindingKey(binding) !== windowBindingKey(requestedBinding)) return false;
      const slot = next.succession.ensureWindowView(committed.id, viewId, binding);
      adopted.current.add(targetGroup);
      if (committed.selectedPrimaryViewId !== viewId) return true;
      projectedGroup.current = targetGroup;
      next.succession.projectWindow(committed);
      const opened = await next.succession.open(session, sessionIntent, keepOriginal, slot.id, undefined, undefined, attached, restoreLayout);
      const active = latest.current.readWindow ? latest.current.readWindow() : latest.current.window;
      const activeBinding = active?.views.find(view => view.id === viewId)?.binding;
      if (active?.id !== committed.id || !activeBinding || windowBindingKey(activeBinding) !== windowBindingKey(requestedBinding)) return false;
      if (active.selectedPrimaryViewId !== viewId) return true;
      if (opened) latest.current.succession.projectWindow(active);
      return opened;
    } finally {
      const remaining = (pending.current.get(targetGroup) ?? 1) - 1;
      if (remaining) pending.current.set(targetGroup, remaining); else pending.current.delete(targetGroup);
      refreshProjection();
    }
  }, []);
  const openAttached = useCallback((session: OpenedSession, restoreLayout = false) => openPrimary(session, session, restoreLayout), [openPrimary]);
  return { slots, primary: primary?.binding, selected: window?.views.find(view => view.id === window.selectedViewId)?.binding, family: window ? primaryWindowFamily(window) : undefined, empty, concreteHistory, openPrimary, openAttached,
    viewForSlot: (id: string | undefined) => id ? window?.views.find(view => slots?.get(view.id)?.id === id) : undefined };
}
