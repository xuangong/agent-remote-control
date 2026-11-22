import { useEffect, useRef, useState } from 'react';
import { Toggle } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { MessageKey } from '@orchardworks/agent-client';
import { DirectoryError } from '../../kernel/directory-client.js';
import type { RemoteHost } from '../../kernel/remote-host.js';
import { SettingsRow, SettingsSection } from './SettingsRow.js';

/** What the Relay keeps about smart reading; the owner of a Host reads and changes it provider by provider. */
export interface SmartReadingService {
  smartReading(hostId: string): Promise<{ providers: readonly string[] }>;
  setSmartReading(hostId: string, providerId: string, enabled: boolean): Promise<{ providers: readonly string[] }>;
}

/** The sentence a refusal of the Relay says: no journals (409), not the owner (403), or anything else. */
export function smartReadingRefusal(error: unknown): MessageKey {
  if (error instanceof DirectoryError && error.code === 'journals_unavailable') return 'settings.smartReading.unavailable';
  if (error instanceof DirectoryError && error.status === 403) return 'settings.smartReading.forbidden';
  return 'settings.smartReading.failed';
}

/** One switch per agent of a Host the reader owns. A refusal says why and puts the switch back where the Relay has it. */
export function SmartReading({ host, service }: { host: RemoteHost; service: SmartReadingService }) {
  const t = useTranslate();
  const [enabled, setEnabled] = useState<ReadonlySet<string>>();
  const [refusal, setRefusal] = useState<MessageKey>();
  const [busy, setBusy] = useState<string>();
  const current = useRef(host.id); current.current = host.id;
  useEffect(() => {
    let live = true;
    setEnabled(undefined); setRefusal(undefined);
    service.smartReading(host.id).then(value => { if (live) setEnabled(new Set(value.providers)); }, () => { if (live) { setEnabled(new Set()); setRefusal('settings.smartReading.failed'); } });
    return () => { live = false; };
  }, [host.id, service]);
  async function change(providerId: string, next: boolean) {
    const before = enabled;
    setBusy(providerId); setRefusal(undefined);
    setEnabled(value => { const copy = new Set(value); if (next) copy.add(providerId); else copy.delete(providerId); return copy; });
    try {
      const saved = await service.setSmartReading(host.id, providerId, next);
      if (current.current === host.id) setEnabled(new Set(saved.providers));
    } catch (error) {
      if (current.current !== host.id) return;
      setEnabled(before); setRefusal(smartReadingRefusal(error));
    } finally { setBusy(undefined); }
  }
  const providers = host.providers ?? [];
  if (!providers.length) return null;
  return <SettingsSection title={t('settings.smartReading')}>
    {enabled === undefined ? <p className="lab-setting-note" role="status">{t('settings.smartReading.loading')}</p> : providers.map(provider => <SettingsRow key={provider.providerId} label={provider.displayName} hint={t('settings.smartReading.hint', { agent: provider.displayName })}>
      <Toggle label={t('settings.smartReading.label', { agent: provider.displayName })} checked={enabled.has(provider.providerId)} disabled={busy === provider.providerId} onChange={next => void change(provider.providerId, next)} />
    </SettingsRow>)}
    {refusal ? <p className="lab-setting-note" role="alert">{t(refusal)}</p> : null}
  </SettingsSection>;
}
