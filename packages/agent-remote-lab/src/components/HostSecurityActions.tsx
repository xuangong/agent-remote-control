import { HostProviders } from './HostProviders.js';
import { HostCodexDaemon } from './HostCodexDaemon.js';
import { useFeedbackToast } from './Toast.js';
import { useState } from 'react';
import type { HostPairingService, RemoteHost, HostStopResult } from './HostPairing.js';
import { needsReauthentication } from '../security-client.js';
import { ReauthenticationNotice } from './ReauthenticationNotice.js';

export function HostSecurityActions({ host, service, visible = true }: { host: RemoteHost; service: HostPairingService; visible?: boolean }) {
  const [action, setAction] = useState<'rotate' | 'stop'>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  useFeedbackToast('Host action', failure);
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
      else setFailure(error instanceof Error ? error.message : 'The Host action could not be completed.');
    } finally { setBusy(false); }
  }
  if (host.access === 'shared' || !host.managed) return null;
  return <div className="lab-host-security">
    <HostProviders host={host} service={service} visible={visible} />
    <HostCodexDaemon host={host} service={service} visible={visible} />
    <div className="lab-host-security-actions">
      {host.credentialRotation && service.rotate ? <button type="button" disabled={busy} onClick={() => setAction('rotate')}>Rotate credential</button> : null}
      {service.stop ? <button type="button" disabled={busy || !host.online} onClick={() => setAction('stop')}>Stop work</button> : null}
    </div>
    {action ? <div className="gateway-security-confirmation" role="group" aria-label={action === 'rotate' ? 'Confirm credential rotation' : 'Confirm stop work'}>
      <p>{action === 'rotate' ? `Replace the saved credential for ${host.name}? The Host must acknowledge the replacement before it becomes active.` : `Request cancellation for sessions on ${host.name}? Host stays paired. Native cancellation does not guarantee operating-system processes have stopped.`}</p>
      <button type="button" disabled={busy} onClick={() => void run()}>{busy ? 'Working…' : action === 'rotate' ? 'Confirm rotation' : 'Confirm stop'}</button>
      <button type="button" disabled={busy} onClick={() => setAction(undefined)}>Cancel</button>
    </div> : null}
    {failure ? <p role="alert">{failure}</p> : null}
    {reauthenticate ? <ReauthenticationNotice /> : null}
    {rotation ? <p role="status">{rotation === 'pending' ? 'Rotation pending. The Host has not yet confirmed the replacement. No credential is shown here.' : 'Credential rotated. The Host confirmed its saved replacement.'}</p> : null}
    {results ? <div role="status"><p>{results.length ? 'Stop results. Host stays paired.' : 'No sessions were available to stop. Host stays paired.'}</p>
      <ul className="lab-host-stop-results">{results.map((result, index) => <li key={`${result.agentId}:${index}`}><code>{result.agentId}</code>: {result.status === 'cancelled' ? 'Cancellation requested' : result.status === 'unsupported' ? 'Cancellation unsupported' : 'Cancellation failed'}{result.message ? `: ${result.message}` : ''}</li>)}</ul>
      {results.length ? <p>Cancellation requested means the native cancel call completed. It does not confirm process termination.</p> : null}
    </div> : null}
  </div>;
}
