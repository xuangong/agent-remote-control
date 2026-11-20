import { useEffect, useRef, useState } from 'react';
import type { HostProviderChange, HostProviderSettings } from '@orchardworks/agent-remote-protocol';
import { errorWords } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { RemoteHost, HostPairingService } from './HostPairing.js';

export function HostProviders({ host, service, visible }: { host: RemoteHost; service: HostPairingService; visible: boolean }) {
  if (!host.providerManagement || host.access === 'shared' || !service.providerSettings) return null;
  return <ProviderSettings key={host.id} host={host} service={service} visible={visible} />;
}
function ProviderSettings({ host, service, visible }: { host: RemoteHost; service: HostPairingService; visible: boolean }) {
  const t = useTranslate();
  const words = useRef(t); words.current = t;
  const [state, setState] = useState<HostProviderSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const serial = useRef(0), writing = useRef(false), mounted = useRef(true);
  const serviceRef = useRef(service); serviceRef.current = service;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  async function request(input?: HostProviderChange) {
    if (!host.online || writing.current) return;
    const ticket = ++serial.current;
    writing.current = true; setBusy(true); setError(undefined);
    try {
      const next = await serviceRef.current.providerSettings!(host.id, input);
      if (mounted.current && ticket === serial.current) setState(next);
    } catch (reason) {
      if (mounted.current && ticket === serial.current) {
        setError(errorWords(reason, words.current, 'hosts.providers.failed'));
        // Read state after an uncertain write; never replay the mutation.
        if (input && !('refresh' in input)) {
          setState(undefined);
          try { const next = await serviceRef.current.providerSettings!(host.id); if (mounted.current && ticket === serial.current) setState(next); } catch {}
        }
      }
    } finally { writing.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => { if (visible && host.online) void request(); }, [host.id, host.online, visible]);
  return <details className="lab-host-providers">
    <summary>{t('hosts.providers.summary')}</summary>
    <p className="lab-control-note">{t('hosts.providers.note')}</p>
    <div className="lab-host-provider-list">
      {state?.providers.map(provider => <label key={provider.providerId} className="lab-host-provider-row">
        <input type="checkbox" aria-label={t('hosts.providers.enable', { name: provider.displayName })} checked={provider.state !== 'disabled'}
          disabled={busy || !host.online} onChange={event => void request({ providerId: provider.providerId, enabled: event.target.checked, revision: state.revision })} />
        <span><strong>{provider.displayName}</strong><small>{provider.state === 'enabled' ? t('hosts.providers.available') : provider.state === 'disabled' ? t('hosts.providers.disabled') : t('hosts.providers.notAvailable')}{provider.reason ? ` · ${provider.reason}` : ''}</small></span>
      </label>)}
    </div>
    <button type="button" disabled={busy || !host.online} onClick={() => void request({ refresh: true })}>{busy ? t('hosts.providers.checking') : t('hosts.providers.detect')}</button>
    {!host.online ? <p role="status">{t('hosts.providers.offline')}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </details>;
}
