import { useTranslate } from '@orchardworks/agent-client-web/react';
import { Pill, Sheet, Toggle } from '@orchardworks/agent-client-web/primitives';
import { useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../../ui/Button.js';
import { SettingsRow, SettingsSection } from './SettingsRow.js';
import { cacheProtectionState, setClearCacheOnClose, subscribeCacheProtection } from '../../kernel/conversation-storage.js';

/** Settings > Privacy and data: whether this device keeps chat data after the page closes; turning protection on asks first. */
export function CachePrivacySettings() {
  const t = useTranslate();
  const protection = useSyncExternalStore(subscribeCacheProtection, cacheProtectionState, cacheProtectionState);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  async function change(next: boolean) {
    setError(false);
    try { await setClearCacheOnClose(next); setConfirming(false); }
    catch { setError(true); }
  }
  return <SettingsSection title={t('settings.cache.title')}>
    <div ref={row}><SettingsRow label={t('settings.cache.clearOnClose')} hint={protection.enabled ? t('settings.cache.onNote') : t('settings.cache.offNote')}>
      <Toggle label={t('settings.cache.clearOnClose')} checked={protection.enabled} disabled={protection.clearing} onChange={next => { if (next) setConfirming(true); else void change(false); }} />
    </SettingsRow></div>
    {protection.clearing ? <p className="lab-setting-note" role="status">{t('settings.cache.removing')}</p> : null}
    {protection.failed ? <p className="lab-setting-note" role="alert">{t('settings.cache.removeFailed')}<Pill onClick={() => void change(true)}>{t('settings.cache.retryCleanup')}</Pill></p> : null}
    {error && !confirming ? <p className="lab-setting-note" role="alert">{t('settings.cache.saveFailedStorage')}</p> : null}
    {confirming ? <CacheProtectionConfirmation busy={protection.clearing} error={error} onConfirm={() => void change(true)}
      onCancel={() => { setConfirming(false); setError(false); row.current?.querySelector<HTMLElement>('[role="switch"]')?.focus({ preventScroll: true }); }} /> : null}
  </SettingsSection>;
}

/** What protection removes and what it costs, before it is turned on. A sheet: Escape, the backdrop and Cancel keep things as they are. */
function CacheProtectionConfirmation({ onCancel, onConfirm, busy, error }: { onCancel(): void; onConfirm(): void; busy: boolean; error: boolean }) {
  const t = useTranslate();
  return <Sheet open title={t('settings.cache.confirmTitle')} detent="content" onClose={() => { if (!busy) onCancel(); }}>
    <div className="lab-cache-confirmation">
      <p><strong>{t('settings.cache.lessLeft')}</strong> {t('settings.cache.lessLeftBody')}</p>
      <p><strong>{t('settings.cache.lessRecovery')}</strong> {t('settings.cache.lessRecoveryBody')}</p>
      <p>{t('settings.cache.confirmNote')}</p>
      {error ? <p role="alert">{t('settings.cache.saveFailed')}</p> : null}
      <div className="lab-sheet-actions">
        <Button autoFocus disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={busy} aria-busy={busy || undefined} onClick={onConfirm}>{busy ? t('settings.cache.clearing') : t('settings.cache.enable')}</Button>
      </div>
    </div>
  </Sheet>;
}
