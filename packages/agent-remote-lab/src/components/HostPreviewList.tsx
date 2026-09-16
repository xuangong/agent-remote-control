import { useState } from 'react';
import { usePreviewController, type PreviewContextValue } from '@agent-remote-controller/agent-remote-web/react';

export function HostPreviewList({ controller: supplied, onOpenSource }: {
  readonly controller?: PreviewContextValue;
  readonly onOpenSource?: (sessionId: string, itemId: string) => void;
}) {
  const inherited = usePreviewController();
  const controller = supplied ?? inherited;
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [entryUrls, setEntryUrls] = useState<Record<string, string>>({});
  if (!controller) return null;

  async function unregister(id: string): Promise<void> {
    setBusy(id); setFailure(undefined);
    try { await controller!.unregister(id); }
    catch (error) { setFailure(error instanceof Error && error.message ? error.message : 'Preview could not be unregistered.'); }
    finally { setBusy(undefined); }
  }

  async function open(id: string, target: string): Promise<void> {
    setBusy(id); setFailure(undefined);
    try {
      const entryUrl = await controller!.open(id, target);
      setEntryUrls(current => ({ ...current, [id]: entryUrl }));
    }
    catch (error) { setFailure(error instanceof Error && error.message ? error.message : 'Preview access could not be prepared.'); }
    finally { setBusy(undefined); }
  }

  return <section className="lab-host-previews" aria-label="Host previews">
    <div className="lab-directory-heading"><h2>Previews</h2><button type="button" disabled={controller.loading} onClick={() => void controller.refresh()}>Refresh</button></div>
    {controller.error ? <p className="lab-control-note" role="alert">{controller.error} Check that preview tunneling is enabled and the Controller is connected.</p> : null}
    {!controller.loading && controller.registrations.length === 0 ? <p className="lab-control-note">No previews are registered for this Host.</p> : null}
    <ul>
      {controller.registrations.map(registration => <li key={registration.id}>
        <div><code>{registration.target}</code><span>{lifecycle(registration.status)}</span>
          {registration.pendingUnregister ? <span>Unregister pending</span> : null}
          {registration.availability === 'controller_offline' ? <span>Controller offline</span> : null}
        </div>
        <small>{registration.pathMode === 'preserve' ? `Configured base /p/${registration.id}/` : 'Root-mounted path adaptation'} · Expires {new Date(registration.expiresAt).toLocaleString()}</small>
        {registration.sources.length ? <div className="lab-preview-sources" aria-label="Preview sources">{registration.sources.map((source, index) => <button
          key={`${source.sessionId}:${source.itemId}`} className="lab-preview-source" type="button" disabled={!onOpenSource}
          onClick={() => onOpenSource?.(source.sessionId, source.itemId)}
        >Open source {index + 1}</button>)}</div> : null}
        {registration.status === 'active' ? <button className="lab-preview-open" type="button" disabled={busy === registration.id || registration.availability !== 'online'}
          onClick={() => void open(registration.id, registration.target)}>Prepare link</button> : null}
        {entryUrls[registration.id] ? <a className="lab-preview-ready" href={entryUrls[registration.id]} target="_blank" rel="noreferrer">Open ready preview</a> : null}
        {controller.canManage ? <button className="lab-preview-unregister" type="button"
          disabled={busy === registration.id || registration.status !== 'active' || registration.pendingUnregister}
          onClick={() => void unregister(registration.id)}>{busy === registration.id ? 'Unregistering…' : 'Unregister'}</button> : null}
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
