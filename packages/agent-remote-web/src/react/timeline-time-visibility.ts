import { useSyncExternalStore } from 'react';

// All mounted conversations, including Side conversations, share this display preference.
let visible = true;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getSnapshot = () => visible;
const getServerSnapshot = () => true;

export function toggleTimelineTime() {
  visible = !visible;
  listeners.forEach(listener => listener());
}

export function useTimelineTimeVisibility() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
