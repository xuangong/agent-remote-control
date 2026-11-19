import type { MotionPort, MotionState } from '../primitives/MotionProvider.js';

/** A motion port the test drives: change the facts, then `emit()`. */
export function stubMotionPort(initial: Partial<MotionState> = {}) {
  let state: MotionState = { reducedMotion: false, pageVisible: true, ...initial };
  const listeners = new Set<() => void>();
  const port: MotionPort = { read: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  return { port, listeners, set(next: Partial<MotionState>) { state = { ...state, ...next }; for (const listener of listeners) listener(); } };
}
