import { useCallback, useSyncExternalStore } from 'react';
import type { DraftBinding } from '../draft-store.js';

/** Save failures update this small surface without rerendering other conversations. */
export function DraftRecoveryNotice({ binding }: { binding: DraftBinding }) {
  const { store, key } = binding;
  const subscribe = useCallback((listener: () => void) => store.subscribePersistence(listener), [store]);
  const snapshot = useCallback(() => store.hasSaveError(key), [store, key]);
  const failed = useSyncExternalStore(subscribe, snapshot, snapshot);
  return failed ? <p className="lab-control-note" role="alert">Draft is not saved. Keep this page open.{' '}
    <button type="button" aria-label="Retry saving draft" onClick={() => store.flush()}>Retry</button>
  </p> : null;
}
