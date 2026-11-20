import { useFeedbackToast } from './Toast.js';
import { useState } from 'react';
import { errorWords } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { HostPairingService, RemoteHost, HostStopResult } from './HostPairing.js';
import { needsReauthentication } from '../security-client.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';

/** Rotate the Host's credential and stop its work, each after a confirmation; only for a Host the reader owns. */
export function HostSecurityActions({ host, service }: { host: RemoteHost; service: HostPairingService }) {
  const t = useTranslate();
  const [action, setAction] = useState<'rotate' | 'stop'>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  useFeedbackToast(t('hosts.toast.action'), failure);
  const [reauthenticate, setReauthenticate] = useState(false);
  const [rotation, setRotation] = useState<'pending' | 'rotated'>();
  const [results, setResults] = useState<HostStopResult[]>();
  async function run() {
    if (!action || busy) return;
    setBusy(true); setFailure(undefined); setReauthenticate(false);
    try {
      if (action === 'rotate' && service.rotate) { const result = await service.rotate(host.id); setRotation(result.status); }
      if (action === 'stop' && service.stop) { const result = await service.stop(host.id); setResults(result.results); }
      setAction(undefined);
    } catch (error) {
      if (needsReauthentication(error)) { setReauthenticate(true); setAction(undefined); }
      else setFailure(errorWords(error, t, 'hosts.actions.failed'));
    } finally { setBusy(false); }
  }
  if (host.access === 'shared' || !host.managed) return null;
  return <div className="lab-host-security">
    <div className="lab-host-security-actions">
      {host.credentialRotation && service.rotate ? <button type="button" disabled={busy} onClick={() => setAction('rotate')}>{t('hosts.actions.rotate')}</button> : null}
      {service.stop ? <button type="button" disabled={busy || !host.online} onClick={() => setAction('stop')}>{t('hosts.actions.stop')}</button> : null}
    </div>
    {action ? <div className="gateway-security-confirmation" role="group" aria-label={action === 'rotate' ? t('hosts.actions.confirmRotateLabel') : t('hosts.actions.confirmStopLabel')}>
      <p>{action === 'rotate' ? t('hosts.actions.confirmRotate', { name: host.name }) : t('hosts.actions.confirmStop', { name: host.name })}</p>
      <button type="button" disabled={busy} onClick={() => void run()}>{busy ? t('hosts.pairing.working') : action === 'rotate' ? t('hosts.actions.confirmRotation') : t('hosts.actions.confirmStopAction')}</button>
      <button type="button" disabled={busy} onClick={() => setAction(undefined)}>{t('common.cancel')}</button>
    </div> : null}
    {failure ? <p role="alert">{failure}</p> : null}
    {reauthenticate ? <ReauthenticationNotice /> : null}
    {rotation ? <p role="status">{rotation === 'pending' ? t('hosts.actions.rotationPending') : t('hosts.actions.rotated')}</p> : null}
    {results ? <div role="status"><p>{results.length ? t('hosts.actions.stopResults') : t('hosts.actions.stopNone')}</p>
      <ul className="lab-host-stop-results">{results.map((result, index) => <li key={`${result.agentId}:${index}`}><code>{result.agentId}</code>: {result.status === 'cancelled' ? t('hosts.actions.cancelled') : result.status === 'unsupported' ? t('hosts.actions.unsupported') : t('hosts.actions.cancelFailed')}{result.message ? `: ${result.message}` : ''}</li>)}</ul>
      {results.length ? <p>{t('hosts.actions.cancelNote')}</p> : null}
    </div> : null}
  </div>;
}
