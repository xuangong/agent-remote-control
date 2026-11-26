import { useState } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { Button } from '../../ui/Button.js';
import type { RemoteHost } from '../../kernel/remote-host.js';
import { cardUpdate } from './fleet-update.js';
import type { FleetUpdate } from './useFleetUpdate.js';

/** The action in the Computers list's head: Update all (n) while some online computer can move to the latest Controller, its progress while they update. */
export function FleetUpdateAction({ fleet, asking, onAsk }: { fleet: FleetUpdate; asking: boolean; onAsk(): void }) {
  const t = useTranslate();
  const count = fleet.plan.eligible.length;
  if (count) return <Button className="lab-host-update-all" aria-expanded={asking} title={t('hosts.fleet.updateAllHint', { version: fleet.release?.version ?? '' })} onClick={onAsk}>{t('hosts.fleet.updateAll', { count })}</Button>;
  return fleet.updating ? <span className="lab-host-update-progress" role="status">{t('hosts.fleet.updatingCount', { count: fleet.updating })}</span> : null;
}

/** The one confirmation: the computers that will update, from which version to which, and the ones that will not, each with its reason. */
export function FleetConfirm({ fleet, onConfirm, onCancel }: { fleet: FleetUpdate; onConfirm(): void; onCancel(): void }) {
  const t = useTranslate();
  const { eligible, skipped } = fleet.plan;
  const version = fleet.release?.version ?? '';
  const bridged = eligible.some(({ target }) => target.version !== version);
  return <div className="lab-host-fleet-confirm" role="group" aria-label={t('hosts.fleet.confirmLabel')}>
    <p><strong>{t('hosts.fleet.confirmTitle', { count: eligible.length, version })}</strong></p>
    <p className="lab-host-fleet-note">{t('hosts.fleet.confirmNote')}{bridged ? ` ${t('hosts.updates.confirmBridges', { versions: [...new Set(eligible.filter(({ target }) => target.version !== version).map(({ target }) => target.version))].join(', '), version })}` : ''}</p>
    <h4>{t('hosts.fleet.willUpdate')}</h4>
    <ul data-list="update">{eligible.map(({ host, target }) => <li key={host.id}><span>{host.name}</span><small>{t('hosts.fleet.fromTo', { from: host.controller?.version ?? '', to: target.version })}</small></li>)}</ul>
    {skipped.length ? <>
      <h4>{t('hosts.fleet.willNot')}</h4>
      <ul data-list="skip">{skipped.map(({ host, reason }) => <li key={host.id}><span>{host.name}</span><small>{t(`hosts.fleet.reason.${reason}`)}</small></li>)}</ul>
    </> : null}
    <div className="lab-host-fleet-buttons"><Button onClick={onConfirm}>{t('hosts.updates.confirmAction')}</Button><Button onClick={onCancel}>{t('common.cancel')}</Button></div>
  </div>;
}

/**
 * A card's Controller line: the version, and beside it the update's progress or result in the same place; a failed update offers its retry here.
 * An owner's online computer keeps the line from its first paint, and the text holds two lines whatever it says, so a release found later or a state that arrives later changes text, not layout.
 */
export function HostUpdateLine({ host, fleet }: { host: RemoteHost; fleet: FleetUpdate }) {
  const t = useTranslate();
  const [asking, setAsking] = useState(false);
  if (host.access === 'shared' || !host.online || !host.controller) return null;
  const state = cardUpdate(host, fleet.statuses[host.id]);
  const eligible = fleet.plan.eligible.some(entry => entry.host.id === host.id);
  const latest = fleet.release?.version ?? '';
  const outdated = eligible || fleet.plan.skipped.some(entry => entry.host.id === host.id && entry.reason !== 'current' && entry.reason !== 'updating');
  const text = state?.kind === 'updating' ? t(state.phase === 'downloading' ? 'hosts.updates.phaseDownloading' : 'hosts.updates.phaseWaiting')
    : state?.kind === 'reconnecting' ? t('hosts.fleet.reconnecting')
    : state?.kind === 'updated' ? t('hosts.fleet.updated', { version: state.version })
    : state?.kind === 'failed' ? `${t('hosts.fleet.failed')}${state.message ? ` ${state.message}` : ''}`
    : eligible ? t('hosts.fleet.available', { version: latest }) : fleet.release && !outdated ? t('hosts.fleet.upToDate') : '';
  const go = () => { setAsking(false); void fleet.start([host.id]); };
  const version = t('hosts.fleet.version', { version: host.controller.version });
  const shown = asking ? t('hosts.fleet.confirmOne', { version: latest }) : text;
  return <div className="lab-host-update-line" data-update-state={state?.kind}>
    <p className="lab-host-update-text" title={`${version}${shown ? ` · ${shown}` : ''}`}>{version}{shown ? <> · <span role="status" data-failed={state?.kind === 'failed' || undefined}>{shown}</span></> : null}</p>
    {asking ? <span className="lab-host-update-buttons"><Button onClick={go}>{t('hosts.updates.confirmAction')}</Button><Button onClick={() => setAsking(false)}>{t('common.cancel')}</Button></span>
      : eligible && state?.kind !== 'updated' ? <Button className="lab-host-update-action" onClick={() => setAsking(true)}>{state?.kind === 'failed' ? t('hosts.updates.retryUpdate') : t('hosts.fleet.update')}</Button> : null}
  </div>;
}
