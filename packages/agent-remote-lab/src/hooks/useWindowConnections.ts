import { createContext, useEffect, useMemo, useState } from 'react';
import type { CompositionDocument } from '../session-composition.js';

const preferenceKey = (windowId: string, viewId: string) => JSON.stringify([windowId, viewId]);
function read(key: string): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch { return new Set(); }
}

/** Connection choices belong to this browser's views, not to the shared Window or native session. */
export function useWindowConnections(scope: string) {
  const key = `agent-remote:window-connections:${scope}`;
  const [saved, setSaved] = useState(() => ({ key, disabled: read(key) }));
  const disabled = saved.key === key ? saved.disabled : read(key);
  useEffect(() => {
    setSaved(current => current.key === key ? current : { key, disabled: read(key) });
    const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) setSaved({ key, disabled: read(key) }); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [key]);
  return useMemo(() => ({
    enabled: (windowId: string, viewId: string) => !disabled.has(preferenceKey(windowId, viewId)),
    enabledSlot: (slotId: string, document: CompositionDocument) => {
      const owner = document.windowBindings?.find(entry => entry.slotId === slotId);
      return !owner || !disabled.has(preferenceKey(owner.windowId, owner.viewId));
    },
    setEnabled(windowId: string, viewId: string, enabled: boolean) {
      setSaved(current => {
        const next = new Set(current.key === key ? current.disabled : read(key));
        const id = preferenceKey(windowId, viewId);
        if (enabled) next.delete(id); else next.add(id);
        try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* The choice remains effective for this page when storage is unavailable. */ }
        return { key, disabled: next };
      });
    },
  }), [key, disabled]);
}

export const WindowConnectionsContext = createContext<{
  enabled(slotId: string): boolean;
  setEnabled(slotId: string, enabled: boolean): void;
} | undefined>(undefined);
