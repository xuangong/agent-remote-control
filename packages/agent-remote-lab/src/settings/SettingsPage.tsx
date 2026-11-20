import type { ReactNode } from 'react';
import { FloatingPanel } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import type { SettingsGroupId } from '../destinations.js';
import type { AccountFacts } from '../account.js';
import type { DeviceLinkNotice } from '../device-link.js';
import { DeviceLinkWords } from '../shell/DeviceLinkIndicator.js';
import { Icon, type IconName } from '../ui/Icon.js';
import { IconButton } from '../ui/IconButton.js';
import { AccountSettings } from './AccountSettings.js';
import { AdvancedSettings } from './AdvancedSettings.js';
import { AssistantSettings, type DeviceNotifications } from './AssistantSettings.js';
import { ComputerSettings, type ComputerServices } from './ComputerSettings.js';
import { GeneralSettings } from './GeneralSettings.js';
import { PrivacySettings } from './PrivacySettings.js';
import { settingsGroups, type SettingsFacts } from './settings-groups.js';
import { hostSummary } from './host-summary.js';
import './settings.css';

const ICONS: Record<SettingsGroupId, IconName> = { general: 'sliders', assistants: 'chat', computers: 'monitor', privacy: 'lock', advanced: 'wrench', account: 'person' };

/** What the page reads: who the reader is, what this device can do and the services each group acts through. */
export interface SettingsContext {
  readonly facts: SettingsFacts;
  readonly account?: AccountFacts;
  readonly baseUrl: string;
  readonly computers: ComputerServices;
  readonly notifications: DeviceNotifications;
  openTrace(): void;
  openInspector(): void;
  /** A recorded fixture's playback controls, shown under Advanced. */
  readonly playback?: ReactNode;
}

/**
 * The one Settings page (design "Navigation and Settings"). On the desktop the groups list stands where the sidebar is and the
 * chosen group fills the content panel, General when none is chosen; on the phone Me shows the account and the list, and a
 * group is a screen of its own that the system's Back leaves.
 */
export function SettingsPage({ context, group, phone, onGroup, linkNotice }: {
  context: SettingsContext; group: SettingsGroupId | undefined; phone: boolean; onGroup(group: SettingsGroupId | undefined): void; linkNotice?: DeviceLinkNotice;
}) {
  const t = useTranslate();
  const groups = settingsGroups(context.facts);
  const current = phone ? group : group ?? 'general';
  const title = (id: SettingsGroupId) => t(`settings.group.${id}` as const);
  const hint = (id: SettingsGroupId) => id === 'computers' ? hostSummary(context.computers.hosts, context.computers.loaded, t) : t(`settings.hint.${id}` as const);
  const list = <nav className="lab-settings-list" aria-label={t('settings.groups')}>
    {groups.map(item => <button key={item.id} type="button" className="lab-settings-group" aria-current={current === item.id ? 'page' : undefined} onClick={() => onGroup(item.id)}>
      <Icon name={ICONS[item.id]} size={20} />
      <span className="lab-settings-group-text"><strong>{title(item.id)}</strong>{phone ? <small>{hint(item.id)}</small> : null}</span>
      {phone ? <Icon name="chevron-right" size={16} /> : null}
    </button>)}
  </nav>;
  if (phone && !current) {
    const who = context.account?.name || context.account?.email || context.account?.id;
    return <FloatingPanel as="section" label={t('settings.me')} className="lab-settings lab-settings-me">
      <h1>{t('settings.me')}</h1>
      <div className="lab-settings-account"><span className="lab-settings-initial" aria-hidden="true">{[...(who ?? t('navigation.accountUnknown'))][0]?.toUpperCase()}</span><strong>{who ?? t('navigation.accountUnknown')}</strong></div>
      {linkNotice ? <DeviceLinkWords notice={linkNotice} /> : null}
      {list}
    </FloatingPanel>;
  }
  const items = groups.find(item => item.id === current)?.items ?? [];
  const body = <div className="lab-settings-body" data-group={current}>
    <header className="lab-settings-head">
      {phone ? <IconButton icon="chevron-left" label={t('common.back')} onClick={() => onGroup(undefined)} /> : null}
      <div><h1>{current ? title(current) : ''}</h1><p>{current ? t(`settings.${current}.hint` as const) : ''}</p></div>
    </header>
    {current === 'general' ? <GeneralSettings /> : null}
    {current === 'assistants' ? <AssistantSettings items={items} notifications={context.notifications} /> : null}
    {current === 'computers' ? <ComputerSettings services={context.computers} visible /> : null}
    {current === 'privacy' ? <PrivacySettings items={items} baseUrl={context.baseUrl} hosts={[...context.computers.hosts]} /> : null}
    {current === 'advanced' ? <AdvancedSettings openTrace={context.openTrace} openInspector={context.openInspector} {...(context.playback ? { playback: context.playback } : {})} /> : null}
    {current === 'account' ? <AccountSettings items={items} {...(context.account ? { account: context.account } : {})} hosts={context.computers.hosts} /> : null}
  </div>;
  if (phone) return <FloatingPanel as="section" label={current ? title(current) : ''} className="lab-settings">{body}</FloatingPanel>;
  return <>
    <FloatingPanel as="aside" label={t('settings.title')} className="lab-settings-sidebar"><h2 className="lab-sidebar-title">{t('settings.title')}</h2>{list}</FloatingPanel>
    <FloatingPanel as="section" label={current ? title(current) : ''} className="lab-settings">{body}</FloatingPanel>
  </>;
}
