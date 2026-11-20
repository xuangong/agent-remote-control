import type { Translate } from '@orchardworks/agent-client';
import { translator } from '@orchardworks/agent-client';

/** The state of the computers as one dot: none paired, all online, some online or none. */
export function hostsState(hosts: readonly { online: boolean }[]): 'none' | 'online' | 'partial' | 'offline' {
  const online = hosts.filter(host => host.online).length;
  return !hosts.length ? 'none' : online === hosts.length ? 'online' : online ? 'partial' : 'offline';
}

/** "2 computers online", "1 of 2 online", "All computers offline": the lead of Settings > Computers and its row on the phone. */
export function hostSummary(hosts: readonly { online: boolean }[], loaded: boolean, t: Translate = translator('en')): string {
  if (!hosts.length) return loaded ? t('settings.computers.none') : t('settings.computers.checking');
  const online = hosts.filter(host => host.online).length;
  if (!online) return t('settings.computers.allOffline');
  return online === hosts.length ? t('settings.computers.online', { count: online }) : t('settings.computers.someOnline', { online, total: hosts.length });
}
