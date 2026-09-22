import { useFeedbackToast } from './Toast.js';
import { useState } from 'react';
import { CopyTunnelUrl, usePreviewController, type PreviewContextValue } from '@orchardworks/agent-remote-web/react';

export function HostPreviewList({ controller: supplied, onOpenSource, onOpen, hostName, hideEmpty = false }: {
  readonly hideEmpty?: boolean;
  readonly hostName?: string;
  readonly onOpen?: () => void;
  readonly controller?: PreviewContextValue;
  readonly onOpenSource?: (sessionId: string, itemId: string) => void;
}) {
  const inherited = usePreviewController();
  const controller = supplied ?? inherited;
  const [busy, setBusy] = useState<string>();
  const [pinning, setPinning] = useState<string>();
  const [failure, setFailure] = useState<string>();
  useFeedbackToast('Preview', failure ?? controller?.error);
  if (!controller) return null;
  const registrations = controller.registrations.filter(item => item.status === 'active');
  if (hideEmpty && registrations.length === 0) return null;

  async function unregister(id: string): Promise<void> {
    setBusy(id); setFailure(undefined);
    try { await controller!.unregister(id); }
    catch (error) { setFailure(error instanceof Error && error.message ? error.message : 'Preview could not be unregistered.'); }
    finally { setBusy(undefined); }
  }

  async function open(id: string, target: string): Promise<void> {
    setBusy(id); setFailure(undefined);
    try {
      const opened = controller!.open(id, target);
      onOpen?.();
      await opened;
    }
    catch (error) { setFailure(error instanceof Error && error.message ? error.message : 'Preview access could not be prepared.'); }
    finally { setBusy(undefined); }
  }

  async function pinName(id: string, pinned: boolean): Promise<void> {
    setPinning(id); setFailure(undefined);
    try { await controller!.pinName!(id, pinned); }
    catch (error) { setFailure(error instanceof Error ? error.message : 'The tunnel name could not be saved. Retry.'); }
    finally { setPinning(undefined); }
  }

  return <section className="lab-host-previews" aria-label={hostName ? `Previews on ${hostName}` : 'Host previews'}>
    <div className="lab-directory-heading"><h2>{hostName ?? 'Previews'}</h2><button type="button" disabled={controller.loading} onClick={() => void controller.refresh()}>Refresh</button></div>
    {controller.error ? <p className="lab-control-note" role="alert">{controller.error} Check that preview tunneling is enabled and the Controller is connected.</p> : null}
    {!controller.loading && registrations.length === 0 ? <p className="lab-control-note">No active previews for this Host.</p> : null}
    <ul>
      {registrations.map(registration => <li key={registration.id}>
        {hostName ? <small className="lab-preview-host">{hostName}</small> : null}
        <div><code>{registration.target}</code><span>{lifecycle(registration.status)}</span>
          {registration.pendingUnregister ? <span>Unregister pending</span> : null}
          {registration.availability === 'controller_offline' ? <span>Controller offline</span> : null}
        </div>
        {registration.tunnelOrigin ? <div className="lab-preview-mapping"><span aria-hidden="true">→</span><code>{registration.tunnelOrigin}</code></div> : null}
        <small>{controller.routing === 'subdomain' ? 'Dedicated tunnel' : registration.pathMode === 'preserve' ? `Configured base /p/${registration.id}/` : 'Root-mounted path adaptation'} · Expires {new Date(registration.expiresAt).toLocaleString()}</small>
        <div className="lab-preview-actions">
          {registration.sources.length ? <div className="lab-preview-sources" aria-label="Preview sources">{registration.sources.map((source, index) => <button
            key={`${source.sessionId}:${source.itemId}`} className="lab-preview-source" type="button" disabled={!onOpenSource}
            onClick={() => onOpenSource?.(source.sessionId, source.itemId)}
          >Open source {index + 1}</button>)}</div> : null}
          {controller.getTunnelUrl ? <CopyTunnelUrl disabled={busy === registration.id || registration.pendingUnregister || registration.availability !== 'online'}
            getUrl={() => controller.getTunnelUrl!(registration.id, registration.target)} /> : null}
          {registration.status === 'active' ? <button className="lab-preview-open" type="button" disabled={busy === registration.id || registration.pendingUnregister || registration.availability !== 'online'}
            onClick={event => { event.currentTarget.focus({ preventScroll: true }); void open(registration.id, registration.target); }}>Open preview</button> : null}
          {controller.canManage && controller.routing === 'subdomain' && controller.pinName ? <button type="button" className="lab-preview-pin"
            aria-pressed={registration.tunnelNamePinned ?? false} disabled={pinning === registration.id || busy === registration.id || registration.pendingUnregister}
            title={registration.tunnelNamePinned ? 'Release the reserved name for future registrations. This active tunnel keeps its URL.' : 'Keep this domain for this Host and local origin after the tunnel is released.'}
            onClick={() => void pinName(registration.id, !registration.tunnelNamePinned)}>{pinning === registration.id ? 'Saving…' : registration.tunnelNamePinned ? 'Unpin tunnel name' : 'Pin tunnel name'}</button> : null}
          {controller.canManage ? <button className="lab-preview-unregister" type="button"
            disabled={busy === registration.id || registration.status !== 'active' || registration.pendingUnregister}
            onClick={() => void unregister(registration.id)}>{busy === registration.id ? 'Unregistering…' : 'Unregister'}</button> : null}
        </div>
      </li>)}
    </ul>
    {!controller.canManage ? <p className="lab-control-note">Only the Host owner can unregister previews.</p> : null}
    {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
  </section>;
}

function lifecycle(status: 'active' | 'expired' | 'unregistered'): string {
  if (status === 'active') return 'Active';
  return status === 'expired' ? 'Expired' : 'Unregistered';
}
