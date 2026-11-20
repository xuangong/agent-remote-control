import { useCallback, useSyncExternalStore } from 'react';
import type { DraftBinding } from '../draft-store.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

/** Save failures update this small surface without rerendering other conversations. */
export function DraftRecoveryNotice({ binding }: { binding: DraftBinding }) {
  const t = useTranslate();
  const { store, key } = binding;
  const subscribe = useCallback((listener: () => void) => store.subscribePersistence(listener), [store]);
  const snapshot = useCallback(() => store.hasSaveError(key), [store, key]);
  const failed = useSyncExternalStore(subscribe, snapshot, snapshot);
  return failed ? <p className="lab-control-note" role="alert">{t('sessions.draft.notSaved')}{' '}
    <button type="button" aria-label={t('sessions.draft.retryLabel')} onClick={() => store.flush()}>{t('common.retry')}</button>
  </p> : null;
}
