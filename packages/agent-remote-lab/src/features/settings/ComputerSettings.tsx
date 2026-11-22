import { useEffect, useState } from 'react';
import type { HttpPreviewClient } from '@orchardworks/agent-client';
import { Pill } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { ControllerUpdates } from '../computers/ControllerUpdates.js';
import { HostCodexDaemon } from '../computers/HostCodexDaemon.js';
import { HostEnvironmentDetails, HostRevoke } from '../computers/HostPairing.js';
import { type HostPairingService, type RemoteHost } from '../../kernel/remote-host.js';
import { HostOverview } from '../computers/HostOverview.js';
import { HostPreviewGroups } from '../computers/HostPreviewGroups.js';
import { HostProviders } from '../computers/HostProviders.js';
import { HostSecurityActions } from '../computers/HostSecurityActions.js';
import { HostVscodeTunnel } from '../computers/HostVscodeTunnel.js';
import { VscodeTunnelScope, type VscodeTunnelService } from '../../kernel/vscode-tunnel.js';
import { Icon } from '../../ui/Icon.js';
import { usePhoneLayout } from '../../kernel/usePhoneLayout.js';
import { computerItems } from './settings-groups.js';
import { SettingsRow, SettingsSection } from './SettingsRow.js';
import { SmartReading, type SmartReadingService } from './SmartReading.js';
import { hostSummary, hostsState } from './host-summary.js';

/** What the Computers group reads from the page: the Hosts, the services that act on them and the preview wiring. */
export interface ComputerServices {
  readonly hosts: readonly RemoteHost[];
  readonly loaded: boolean;
  readonly service: HostPairingService & Partial<SmartReadingService>;
  readonly previewClient: HttpPreviewClient;
  readonly tunnelService: VscodeTunnelService;
  /** The Host whose preview list is already in the page's preview scope, if any. */
  readonly activePreviewHostId?: string;
  openPreviewSource(sessionId: string, itemId: string, hostId: string): void;
  onRevoked(): void;
}

/** Marks the history entry of a Host's page, so the phone's Back returns to the list of computers. */
const COMPUTER_ENTRY = 'agentRemoteComputer';

/** Settings > Computers: every computer with its state; a computer opens its own page (a history entry, so Back returns). */
export function ComputerSettings({ services, visible }: { services: ComputerServices; visible: boolean }) {
  const t = useTranslate();
  const phone = usePhoneLayout();
  const [openId, setOpenId] = useState<string | undefined>(() => typeof history !== 'undefined' ? history.state?.[COMPUTER_ENTRY] : undefined);
  useEffect(() => {
    const popped = () => setOpenId(history.state?.[COMPUTER_ENTRY]);
    addEventListener('popstate', popped);
    return () => removeEventListener('popstate', popped);
  }, []);
  const open = (id: string) => { history.pushState({ ...history.state, [COMPUTER_ENTRY]: id }, ''); setOpenId(id); };
  const host = services.hosts.find(item => item.id === openId);
  if (host) return <HostPage host={host} services={services} visible={visible} onBack={() => history.back()} />;
  const state = hostsState(services.hosts);
  return <HostOverview hosts={services.hosts} service={services.service} visible={visible} compact={phone} onOpenHost={open}
    lead={<p className="lab-host-lead"><span className="lab-host-dot-lead" data-host-state={state} aria-hidden="true" />{hostSummary(services.hosts, services.loaded, t)}</p>} />;
}

/** One computer: its state and system, its agents, previews and VS Code tunnel, and for its owner its updates, smart reading and keys. */
function HostPage({ host, services, visible, onBack }: { host: RemoteHost; services: ComputerServices; visible: boolean; onBack(): void }) {
  const t = useTranslate();
  const items = computerItems({ owned: host.access !== 'shared' });
  const has = (item: (typeof items)[number]) => items.includes(item);
  const { service } = services;
  const subtitle = [host.environment?.os.name ?? host.controller?.platform, host.environment?.os.arch ?? host.controller?.arch, host.controller ? t('settings.computer.version', { version: host.controller.version }) : undefined].filter(Boolean).join(' · ');
  return <div className="lab-host-page" data-host-id={host.id}>
    <div className="lab-host-page-head">
      <Pill className="lab-host-back" onClick={onBack}><Icon name="chevron-left" size={16} />{t('settings.computers.back')}</Pill>
      <div className="lab-host-page-title"><h2>{host.name}</h2><p><span className="lab-host-dot-lead" data-host-state={host.online ? 'online' : 'offline'} aria-hidden="true" />{host.online ? t('settings.computer.online') : t('settings.computer.offline')}{subtitle ? ` · ${subtitle}` : ''}</p></div>
    </div>
    <SettingsSection title={t('settings.computer.system')}><div className="lab-setting-legacy"><HostEnvironmentDetails host={host} /></div></SettingsSection>
    {has('agents') ? <SettingsSection title={t('settings.computer.agents')}>
      {host.providers?.length ? host.providers.map(provider => <SettingsRow key={provider.providerId} label={provider.displayName} />) : <p className="lab-setting-note">{t('settings.computer.agentsNone')}</p>}
      <div className="lab-setting-legacy"><HostProviders host={host} service={service} visible={visible} />{has('hostSecurity') && host.managed ? <HostCodexDaemon host={host} service={service} visible={visible} /> : null}</div>
    </SettingsSection> : null}
    {has('smartReading') && service.smartReading && service.setSmartReading ? <SmartReading host={host} service={service as SmartReadingService} /> : null}
    {has('controllerUpdates') ? <SettingsSection title={t('settings.computer.updates')}><div className="lab-setting-legacy"><ControllerUpdates service={service} hosts={[host]} /></div></SettingsSection> : null}
    {has('vscodeTunnel') ? <SettingsSection><div className="lab-setting-legacy">
      <VscodeTunnelScope service={services.tunnelService} host={host} polling={visible}><HostVscodeTunnel key={host.id} /></VscodeTunnelScope></div></SettingsSection> : null}
    {has('previews') ? <SettingsSection title={t('settings.computer.previews')}><div className="lab-setting-legacy">
      <HostPreviewGroups client={services.previewClient} hosts={[host]} {...(services.activePreviewHostId ? { activeHostId: services.activePreviewHostId } : {})} polling={visible} onOpen={() => undefined} onOpenSource={services.openPreviewSource} /></div></SettingsSection> : null}
    {has('hostSecurity') ? <SettingsSection title={t('settings.computer.security')}><div className="lab-setting-legacy">
      <HostSecurityActions host={host} service={service} />
      <HostRevoke host={host} service={service} onRevoked={() => { services.onRevoked(); onBack(); }} /></div></SettingsSection> : null}
  </div>;
}
