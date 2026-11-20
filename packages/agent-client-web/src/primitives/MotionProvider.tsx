import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** What every avatar and mark needs to decide whether it moves. */
export interface MotionState { readonly reducedMotion: boolean; readonly pageVisible: boolean }
/** The page's reduced-motion setting and visibility, and a way to hear about changes to either. */
export interface MotionPort { read(): MotionState; subscribe(onChange: () => void): () => void }

/** Without a provider nothing moves: the safe default for a page that never set motion up. */
const still: MotionState = { reducedMotion: true, pageVisible: true };
const MotionContext = createContext<MotionState>(still);

/** The browser's port: one reduced-motion query and the page's visibility. */
export function browserMotionPort(view: Window = window): MotionPort {
  const query = view.matchMedia('(prefers-reduced-motion: reduce)');
  return {
    read: () => ({ reducedMotion: query.matches, pageVisible: view.document.visibilityState !== 'hidden' }),
    subscribe: onChange => {
      query.addEventListener('change', onChange);
      view.document.addEventListener('visibilitychange', onChange);
      return () => { query.removeEventListener('change', onChange); view.document.removeEventListener('visibilitychange', onChange); };
    },
  };
}

/** Subscribes once for the whole page and gives every avatar and mark the same facts. */
export function MotionProvider({ children, port }: { children: ReactNode; port?: MotionPort }) {
  const [source] = useState(() => port ?? browserMotionPort());
  const [state, setState] = useState(() => source.read());
  useEffect(() => {
    const update = () => setState(current => {
      const next = source.read();
      return next.reducedMotion === current.reducedMotion && next.pageVisible === current.pageVisible ? current : next;
    });
    update();
    return source.subscribe(update);
  }, [source]);
  return <MotionContext.Provider value={state}>{children}</MotionContext.Provider>;
}

export function useMotionState(): MotionState {
  return useContext(MotionContext);
}

/** Holds the avatars and marks inside still, as reduced motion does: an earlier answer's avatar rests while the latest one moves. */
export function MotionStill({ children }: { children: ReactNode }) {
  const state = useContext(MotionContext);
  const held = useMemo(() => state.reducedMotion ? state : { ...state, reducedMotion: true }, [state]);
  return <MotionContext.Provider value={held}>{children}</MotionContext.Provider>;
}
