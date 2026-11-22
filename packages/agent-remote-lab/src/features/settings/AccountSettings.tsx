import { useTranslate } from '@orchardworks/agent-client-web/react';
import { Pill } from '@orchardworks/agent-client-web/primitives';
import type { AccountFacts } from '../../kernel/account.js';
import type { RemoteHost } from '../../kernel/remote-host.js';
import { runningDeploymentEntry } from '../computers/deployment-update.js';
import type { SettingsItemId } from './settings-groups.js';
import { SettingsRow, SettingsSection } from './SettingsRow.js';

/** The hash of the page's entry asset, which names the web build; a development server has none. */
export function webBuild(entry = typeof document === 'undefined' ? undefined : runningDeploymentEntry(document)): string | undefined {
  const match = entry && /-([A-Za-z0-9_-]{6,})\.[a-z]+$/.exec(entry);
  return match ? match[1] : undefined;
}

/** Settings > Account and about: who is signed in, Security, Sign out, and the version of the web page and of each Controller. */
export function AccountSettings({ items, account, hosts }: { items: readonly SettingsItemId[]; account?: AccountFacts; hosts: readonly RemoteHost[] }) {
  const t = useTranslate();
  const who = account?.name || account?.email || account?.id;
  return <>
    {account && items.includes('account') ? <SettingsSection>
      <SettingsRow label={who ? t('settings.account.signedInAs', { name: who }) : t('settings.account.none')} hint={account.name && account.email ? account.email : undefined} />
      {items.includes('security') ? <SettingsRow label={t('settings.account.security')}><Pill disabled={!account.ready} onClick={account.openSecurity}>{t('common.open')}</Pill></SettingsRow> : null}
      {items.includes('signOut') ? <SettingsRow label={t('common.signOut')}><Pill onClick={account.signOut}>{t('common.signOut')}</Pill></SettingsRow> : null}
    </SettingsSection> : null}
    <SettingsSection title={t('settings.account.versions')}>
      <SettingsRow label={t('settings.account.web')} hint={webBuild() ?? t('settings.account.webUnknown')} />
      {hosts.map(host => <SettingsRow key={host.id} label={t('settings.account.controller', { name: host.name })} hint={host.controller?.version ?? t('settings.account.controllerUnknown')} />)}
    </SettingsSection>
  </>;
}
