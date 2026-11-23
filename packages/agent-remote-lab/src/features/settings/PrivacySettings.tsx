import { CachePrivacySettings } from './CachePrivacySettings.js';
import type { RemoteHost } from '../../kernel/remote-host.js';
import type { SettingsItemId } from './settings-groups.js';

/** Settings > Privacy and data: this device's cache. */
export function PrivacySettings({ items, baseUrl, hosts }: { items: readonly SettingsItemId[]; baseUrl: string; hosts: RemoteHost[] }) {
  return <>
    <CachePrivacySettings />
  </>;
}
