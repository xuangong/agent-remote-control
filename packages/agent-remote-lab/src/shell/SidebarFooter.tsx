import { IconButton } from '../ui/IconButton.js';

export function hostSummary(hosts: readonly { online: boolean }[], loaded: boolean): string {
  if (!hosts.length) return loaded ? 'No Hosts paired' : 'Checking Hosts…';
  const online = hosts.filter(host => host.online).length;
  const noun = hosts.length === 1 ? 'Host' : 'Hosts';
  if (!online) return 'All Hosts offline';
  return online === hosts.length ? `${online} ${noun} online` : `${online} of ${hosts.length} ${noun} online`;
}

/**
 * The bottom of the desktop Window sidebar: how many Hosts are online (opening the Hosts page) and Settings.
 * `hosts` are the Hosts the Hosts select offers, the Lab server included when it has local providers.
 */
export function SidebarFooter({ hosts, loaded, onHosts, hostsCurrent = false, onSettings, settingsCurrent }: {
  hosts: readonly { online: boolean }[]; loaded: boolean; onHosts(): void; hostsCurrent?: boolean; onSettings(): void; settingsCurrent: boolean;
}) {
  const online = hosts.filter(host => host.online).length;
  const state = !hosts.length ? 'none' : online === hosts.length ? 'online' : online ? 'partial' : 'offline';
  return <footer className="lab-sidebar-footer">
    <button type="button" className="lab-sidebar-hosts" title="Open Hosts" aria-description="Open Hosts" aria-current={hostsCurrent ? 'page' : undefined} onClick={onHosts}>
      <span className="lab-sidebar-host-dot" data-host-state={state} aria-hidden="true" />{hostSummary(hosts, loaded)}
    </button>
    <IconButton icon="gear" label="Sidebar settings" title="Settings" aria-current={settingsCurrent ? 'page' : undefined} onClick={onSettings} />
  </footer>;
}
