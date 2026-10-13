import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { moveSessionHost } from './SessionDock.js';

const Context = createContext<{ homes: Map<string, HTMLElement>; register(id: string, home: HTMLElement | null): void } | undefined>(undefined);

/** Ask owners stay mounted at workspace level while their floating surface follows its source pane. */
export function SessionAskSurfaceProvider({ children }: { children: ReactNode }) {
  const [homes, setHomes] = useState(new Map<string, HTMLElement>());
  const register = useCallback((id: string, home: HTMLElement | null) => setHomes(current => {
    if (current.get(id) === (home ?? undefined)) return current;
    const next = new Map(current); if (home) next.set(id, home); else next.delete(id); return next;
  }), []);
  const value = useMemo(() => ({ homes, register }), [homes, register]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function SessionAskHome({ id }: { id: string }) {
  const { register } = useContext(Context)!;
  const ref = useCallback((home: HTMLDivElement | null) => register(id, home), [id, register]);
  return <div ref={ref} style={{ display: 'contents' }} />;
}
export function SessionAskSurface({ id, active = true, children }: { id: string; active?: boolean; children: ReactNode }) {
  const { homes } = useContext(Context)!;
  const [host] = useState(() => { const element = document.createElement('div'); element.className = 'lab-session-ask-surface'; return element; });
  const fallback = useRef<HTMLDivElement>(null);
  const home = active ? homes.get(id) : undefined;
  useLayoutEffect(() => { moveSessionHost(host, home ?? fallback.current!); return () => host.remove(); }, [host, home]);
  return <><div ref={fallback} hidden={!!home} className="lab-session-composition" style={{ position: 'absolute', inset: 0, zIndex: 45, pointerEvents: 'none' }} />{createPortal(children, host)}</>;
}
