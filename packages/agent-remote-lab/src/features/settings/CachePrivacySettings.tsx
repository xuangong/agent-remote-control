import { useTranslate } from '@orchardworks/agent-client-web/react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { cacheProtectionState, setClearCacheOnClose, subscribeCacheProtection } from '../../kernel/conversation-storage.js';

export function CachePrivacySettings() {
  const t = useTranslate();
  const protection = useSyncExternalStore(subscribeCacheProtection, cacheProtectionState, cacheProtectionState);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = useId(), description = useId();
  async function change(next: boolean) {
    setError(false);
    try { await setClearCacheOnClose(next); setConfirming(false); }
    catch { setError(true); }
  }
  return <div className="lab-display-settings lab-cache-settings">
    <h2>{t('settings.cache.title')}</h2>
    <div className="lab-cache-setting">
      <span id={label}>{t('settings.cache.clearOnClose')}</span>
      <button ref={trigger} type="button" role="switch" aria-checked={protection.enabled} aria-labelledby={label} aria-describedby={description}
        disabled={protection.clearing} onClick={() => { if (protection.enabled) void change(false); else setConfirming(true); }}>
        <span aria-hidden="true" />
      </button>
    </div>
    <p id={description}>{protection.enabled
      ? t('settings.cache.onNote')
      : t('settings.cache.offNote')}</p>
    {protection.clearing ? <p role="status">{t('settings.cache.removing')}</p> : null}
    {protection.failed ? <p role="alert">{t('settings.cache.removeFailed')} <button type="button" onClick={() => void change(true)}>{t('settings.cache.retryCleanup')}</button></p> : null}
    {error ? <p role="alert">{t('settings.cache.saveFailedStorage')}</p> : null}
    {confirming ? <CacheProtectionConfirmation onCancel={() => { setConfirming(false); trigger.current?.focus({ preventScroll: true }); }} onConfirm={() => void change(true)} busy={protection.clearing} error={error} /> : null}
  </div>;
}
function CacheProtectionConfirmation({ onCancel, onConfirm, busy, error }: { onCancel(): void; onConfirm(): void; busy: boolean; error: boolean }) {
  const t = useTranslate();
  const dialog = useRef<HTMLDialogElement>(null);
  const label = useId(), description = useId();
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (focus?.isConnected) focus.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={dialog} className="lab-favorite-dialog lab-cache-confirmation" aria-labelledby={label} aria-describedby={description}
    onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <header><h2 id={label}>{t('settings.cache.confirmTitle')}</h2></header>
    <div className="lab-cache-confirmation-body" id={description}>
      <p><strong>{t('settings.cache.lessLeft')}</strong> {t('settings.cache.lessLeftBody')}</p>
      <p><strong>{t('settings.cache.lessRecovery')}</strong> {t('settings.cache.lessRecoveryBody')}</p>
      <p>{t('settings.cache.confirmNote')}</p>
    </div>
    {error ? <p role="alert">{t('settings.cache.saveFailed')}</p> : null}
    <footer><button type="button" autoFocus disabled={busy} onClick={onCancel}>{t('common.cancel')}</button><button type="button" className="lab-favorite-primary" disabled={busy} onClick={onConfirm}>{busy ? t('settings.cache.clearing') : t('settings.cache.enable')}</button></footer>
  </dialog>, document.body);
}
