import { useFeedbackToast } from '../../kernel/Toast.js';
import { useState } from 'react';
import { CopyTunnelUrl, usePreviewController, useTranslate, type PreviewContextValue } from '@orchardworks/agent-client-web/react';
import { errorWords, type Translate } from '@orchardworks/agent-client';

export function HostPreviewList({ controller: supplied, onOpenSource, onOpen, hostName, hideEmpty = false }: {
  readonly hideEmpty?: boolean;
  readonly hostName?: string;
  readonly onOpen?: () => void;
  readonly controller?: PreviewContextValue;
  readonly onOpenSource?: (sessionId: string, itemId: string) => void;
}) {
  const t = useTranslate();
  const inherited = usePreviewController();
  const controller = supplied ?? inherited;
  const [busy, setBusy] = useState<string>();
  const [pinning, setPinning] = useState<string>();
  const [failure, setFailure] = useState<string>();
  useFeedbackToast(t('hosts.toast.preview'), failure ?? controller?.error);
  if (!controller) return null;
  const registrations = controller.registrations.filter(item => item.status === 'active');
  const pinnedNames = controller.pinnedNames ?? [];
  if (hideEmpty && registrations.length === 0 && pinnedNames.length === 0) return null;

  async function unregister(id: string): Promise<void> {
    setBusy(id); setFailure(undefined);
    try { await controller!.unregister(id); }
    catch (error) { setFailure(errorWords(error, t, 'hosts.preview.unregisterFailed')); }
    finally { setBusy(undefined); }
  }

  async function open(id: string, target: string): Promise<void> {
    setBusy(id); setFailure(undefined);
    try {
      const opened = controller!.open(id, target);
      onOpen?.();
      await opened;
    }
    catch (error) { setFailure(errorWords(error, t, 'hosts.preview.accessFailed')); }
    finally { setBusy(undefined); }
  }

  async function pinName(id: string, pinned: boolean): Promise<void> {
    setPinning(id); setFailure(undefined);
    try { await controller!.pinName!(id, pinned); }
    catch (error) { setFailure(errorWords(error, t, 'hosts.preview.pinFailed')); }
    finally { setPinning(undefined); }
  }

  async function unpinName(nameId: string): Promise<void> {
    setPinning(nameId); setFailure(undefined);
    try { await controller!.unpinName!(nameId); }
    catch (error) { setFailure(errorWords(error, t, 'hosts.preview.unpinFailed')); }
    finally { setPinning(undefined); }
  }

  return <section className="lab-host-previews" aria-label={hostName ? t('hosts.preview.labelOn', { name: hostName }) : t('hosts.preview.label')}>
    <div className="lab-directory-heading"><h2>{hostName ?? t('hosts.preview.title')}</h2><button type="button" disabled={controller.loading} onClick={() => void controller.refresh()}>{t('common.refresh')}</button></div>
    {controller.error ? <p className="lab-control-note" role="alert">{t('hosts.preview.errorHint', { error: controller.error })}</p> : null}
    {!controller.loading && registrations.length === 0 && pinnedNames.length === 0 ? <p className="lab-control-note">{t('hosts.preview.empty')}</p> : null}
    <ul>
      {registrations.map(registration => <li key={registration.id}>
        {hostName ? <small className="lab-preview-host">{hostName}</small> : null}
        <div><code>{registration.target}</code><span>{lifecycle(registration.status, t)}</span>
          {registration.pendingUnregister ? <span>{t('hosts.preview.unregisterPending')}</span> : null}
          {registration.availability === 'controller_offline' ? <span>{t('hosts.preview.controllerOffline')}</span> : null}
        </div>
        {registration.tunnelOrigin ? <div className="lab-preview-mapping"><span aria-hidden="true">→</span><code>{registration.tunnelOrigin}</code></div> : null}
        <small>{t('hosts.preview.expires', { mode: controller.routing === 'subdomain' ? t('hosts.preview.dedicated') : registration.pathMode === 'preserve' ? t('hosts.preview.configuredBase', { id: registration.id }) : t('hosts.preview.rootMounted'), time: new Date(registration.expiresAt).toLocaleString() })}</small>
        <div className="lab-preview-actions">
          {registration.sources.length ? <div className="lab-preview-sources" aria-label={t('hosts.preview.sources')}>{registration.sources.map((source, index) => <button
            key={`${source.sessionId}:${source.itemId}`} className="lab-preview-source" type="button" disabled={!onOpenSource}
            onClick={() => onOpenSource?.(source.sessionId, source.itemId)}
          >{t('hosts.preview.openSource', { number: index + 1 })}</button>)}</div> : null}
          {controller.getTunnelUrl ? <CopyTunnelUrl disabled={busy === registration.id || registration.pendingUnregister || registration.availability !== 'online'}
            getUrl={() => controller.getTunnelUrl!(registration.id, registration.target)} /> : null}
          {registration.status === 'active' ? <button className="lab-preview-open" type="button" disabled={busy === registration.id || registration.pendingUnregister || registration.availability !== 'online'}
            onClick={event => { event.currentTarget.focus({ preventScroll: true }); void open(registration.id, registration.target); }}>{t('hosts.preview.open')}</button> : null}
          {controller.canManage && controller.routing === 'subdomain' && controller.pinName ? <button type="button" className="lab-preview-pin"
            aria-pressed={registration.tunnelNamePinned ?? false} disabled={pinning === registration.id || busy === registration.id || (registration.pendingUnregister && !registration.tunnelNamePinned)}
            title={registration.tunnelNamePinned ? t('hosts.preview.pinReleaseHint') : t('hosts.preview.pinKeepHint')}
            onClick={() => void pinName(registration.id, !registration.tunnelNamePinned)}>{pinning === registration.id ? t('hosts.preview.saving') : registration.tunnelNamePinned ? t('hosts.preview.unpin') : t('hosts.preview.pin')}</button> : null}
          {controller.canManage ? <button className="lab-preview-unregister" type="button"
            disabled={busy === registration.id || registration.status !== 'active' || registration.pendingUnregister}
            onClick={() => void unregister(registration.id)}>{busy === registration.id ? t('hosts.preview.unregistering') : t('hosts.preview.unregister')}</button> : null}
        </div>
      </li>)}
      {pinnedNames.map(pin => <li key={`pin:${pin.nameId}`}>
        {hostName ? <small className="lab-preview-host">{hostName}</small> : null}
        <div><code>{pin.target}</code><span>{t('hosts.preview.nameReserved')}</span></div>
        {pin.tunnelOrigin ? <div className="lab-preview-mapping"><span aria-hidden="true">→</span><code>{pin.tunnelOrigin}</code></div> : null}
        <small>{t('hosts.preview.noTunnel')}</small>
        {controller.canManage && controller.unpinName ? <div className="lab-preview-actions">
          <button type="button" className="lab-preview-pin" aria-pressed="true" disabled={pinning === pin.nameId}
            title={t('hosts.preview.unpinHint')}
            onClick={() => void unpinName(pin.nameId)}>{pinning === pin.nameId ? t('hosts.preview.saving') : t('hosts.preview.unpin')}</button>
        </div> : null}
      </li>)}
    </ul>
    {!controller.canManage ? <p className="lab-control-note">{t('hosts.preview.ownerOnly')}</p> : null}
    {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
  </section>;
}

function lifecycle(status: 'active' | 'expired' | 'unregistered', t: Translate): string {
  if (status === 'active') return t('hosts.preview.active');
  return status === 'expired' ? t('hosts.preview.expired') : t('hosts.preview.unregistered');
}
