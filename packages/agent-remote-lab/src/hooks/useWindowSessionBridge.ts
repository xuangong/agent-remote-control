import { useCallback, useEffect, useRef, useReducer } from 'react';
import type { WindowOperation, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { compositionSelection } from '../session-composition.js';
import { adoptWindowPrimaryRole, primaryWindowFamily, windowCompositionMapping, windowSuccessionLayout } from '../window-composition.js';
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
  const pending = useRef(0);
  const [settled, refreshProjection] = useReducer(value => value + 1, 0);
  const adopted = useRef(new Set<string>());
  const historyWindow = useRef<string>();
  const projected = useRef<string>();
  const successionAttempt = useRef<string>();
  const { window, succession, enabled } = options;
  const adoptedDocument = useRef(succession.document);
  if (adoptedDocument.current !== succession.document) {
    adoptedDocument.current = succession.document;
    adopted.current.clear();
    projected.current = undefined;
  }
  const history = succession.navigationIntent.sessionIntent === 'history';
  if (history && !historyWindow.current && window) historyWindow.current = window.id;
  if (!history) historyWindow.current = undefined;
  const concreteHistory = history && (!window || historyWindow.current === window.id);
  if (window && enabled && !succession.discovering && !concreteHistory && !adopted.current.has(window.id)) {
    adoptWindowPrimaryRole(succession.document, window); adopted.current.add(window.id);
  }
  const slots = window && (!succession.discovering || adopted.current.has(window.id)) && !concreteHistory ? windowCompositionMapping(succession.document, window) : undefined;
  const primary = window?.views.find(view => view.id === window.primaryViewId);
  const primarySlot = window && slots?.get(window.primaryViewId);
  const empty = !!options.unavailable || !!window && !primary?.binding && !concreteHistory;
  useEffect(() => {
    if (!enabled || succession.discovering || pending.current) return;
    if (concreteHistory) return;
    succession.projectWindow(window);
    if (!window) { projected.current = undefined; return; }
    const key = JSON.stringify([window.id, primarySlot?.id]);
    if (!primary?.binding || !primarySlot) {
      if (projected.current !== key) { succession.clearPresentation(); projected.current = key; }
      return;
    }
    projected.current = key;
    if (!history && succession.desired?.slot.id === primarySlot.id && succession.selected && sessionKey(succession.selected) === sessionKey(compositionSelection(primarySlot))) return;
    let cancelled = false;
    void succession.open(compositionSelection(primarySlot), undefined, undefined, primarySlot.id)
      .then(opened => { if (opened && !cancelled && latest.current.window?.id === window.id) latest.current.succession.projectWindow(latest.current.window); })
      .catch(error => { if (!cancelled) latest.current.onError(error); });
    return () => { cancelled = true; };
  }, [window?.id, window?.revision, primarySlot?.id, succession.document, enabled, concreteHistory, settled]);
  useEffect(() => {
    if (!window || concreteHistory || succession.discovering || pending.current) return;
    const operation = windowSuccessionLayout(succession.document, window);
    const key = operation && JSON.stringify([window.id, window.revision, operation]);
    if (!operation || key === successionAttempt.current) return;
    successionAttempt.current = key;
    void options.operate(operation).catch(error => latest.current.onError(error));
  }, [window?.id, window?.revision, succession.document.editRevision, succession.discovering, concreteHistory, settled]);

  const openPrimary = useCallback(async (session: SessionEntry, attached?: OpenedSession, restoreLayout = false, keepOriginal?: boolean, slotId?: string): Promise<boolean> => {
    const current = latest.current, targetWindow = current.window;
    if (current.unavailable) throw new Error('Choose an available Window before opening a session.');
    if (!targetWindow) return attached ? current.succession.openAttached(attached, restoreLayout) : current.succession.open(session);
    const operation: WindowOperation = { type: 'batch', operations: [
      { type: 'view.bind', viewId: targetWindow.primaryViewId, binding: windowSessionBinding(session) },
      { type: 'view.select', viewId: targetWindow.primaryViewId },
    ] };
    if (slotId && !current.succession.document.windowBindings?.some(entry => entry.slotId === slotId && (entry.windowId !== targetWindow.id || entry.viewId !== targetWindow.primaryViewId))) {
      current.succession.bindWindowView(targetWindow.id, targetWindow.primaryViewId, windowSessionBinding(session), slotId);
    }
    pending.current++;
    try {
      await current.operate(operation);
      const next = latest.current;
      const committed = next.readWindow ? next.readWindow() : next.window;
      if (committed?.id !== targetWindow.id) return false;
      const primaryBinding = committed.views.find(view => view.id === committed.primaryViewId)?.binding;
      if (!primaryBinding || sessionKey(primaryBinding) !== sessionKey(session)) return false;
      const slot = next.succession.ensureWindowView(committed.id, committed.primaryViewId, primaryBinding);
      next.succession.projectWindow(committed);
      const opened = await next.succession.open(session, undefined, keepOriginal, slot.id, undefined, undefined, attached, restoreLayout);
      const active = latest.current.readWindow ? latest.current.readWindow() : latest.current.window;
      const activePrimary = active?.views.find(view => view.id === active.primaryViewId)?.binding;
      if (active?.id !== committed.id || !activePrimary || sessionKey(activePrimary) !== sessionKey(session)) return false;
      if (opened) latest.current.succession.projectWindow(active);
      return opened;
    } finally { pending.current--; refreshProjection(); }
  }, []);
  const openAttached = useCallback((session: OpenedSession, restoreLayout = false) => openPrimary(session, session, restoreLayout), [openPrimary]);
  return { slots, primary: primary?.binding, selected: window?.views.find(view => view.id === window.selectedViewId)?.binding, family: window ? primaryWindowFamily(window) : undefined, empty, concreteHistory, openPrimary, openAttached,
    viewForSlot: (id: string | undefined) => id ? window?.views.find(view => slots?.get(view.id)?.id === id) : undefined };
}
