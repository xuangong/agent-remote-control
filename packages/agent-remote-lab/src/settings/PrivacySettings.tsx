import { CachePrivacySettings } from '../components/CachePrivacySettings.js';
import { CallForSupportSettings } from '../components/call-for-support/CallForSupportSettings.js';
import type { RemoteHost } from '../kernel/remote-host.js';
import type { SettingsItemId } from './settings-groups.js';
import { SettingsSection } from './SettingsRow.js';

/** Settings > Privacy and data: this device's cache and what a support call may share. */
export function PrivacySettings({ items, baseUrl, hosts }: { items: readonly SettingsItemId[]; baseUrl: string; hosts: RemoteHost[] }) {
  return <>
    <SettingsSection><div className="lab-setting-legacy"><CachePrivacySettings /></div></SettingsSection>
    {items.includes('supportSharing') ? <SettingsSection><div className="lab-setting-legacy"><CallForSupportSettings baseUrl={baseUrl} enabled hosts={hosts} /></div></SettingsSection> : null}
  </>;
}
