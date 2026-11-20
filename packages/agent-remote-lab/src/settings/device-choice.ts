import { useSyncExternalStore } from 'react';

/** A device choice as `bindAppearance`, `bindLanguage` and `bindMotion` keep it: read it and follow its changes, here or in another tab. */
export function useDeviceChoice<T>(choice: { subscribe(listener: () => void): () => void }, read: () => T): T {
  return useSyncExternalStore(choice.subscribe, read, read);
}
