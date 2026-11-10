import { IconButton } from '../ui/IconButton.js';

export function hostSummary(hosts: readonly { online: boolean }[], loaded: boolean): string {
  if (!hosts.length) return loaded ? 'No Hosts paired' : 'Checking Hosts…';
  const online = hosts.filter(host => host.online).length;
  return online === hosts.length ? `${online} ${online === 1 ? 'Host' : 'Hosts'} online` : `${online} of ${hosts.length} Hosts online`;
}

/** The bottom of the desktop Window sidebar: how many Hosts are online (opening All sessions, where Hosts are chosen) and Settings. */
export function SidebarFooter({ hosts, loaded, onHosts, onSettings, settingsPressed }: {
  hosts: readonly { online: boolean }[]; loaded: boolean; onHosts(): void; onSettings(): void; settingsPressed: boolean;
}) {
  const online = hosts.filter(host => host.online).length;
  const state = !hosts.length ? 'none' : online === hosts.length ? 'online' : online ? 'partial' : 'offline';
  return <footer className="lab-sidebar-footer">
    <button type="button" className="lab-sidebar-hosts" onClick={onHosts}>
      <span className="lab-sidebar-host-dot" data-host-state={state} aria-hidden="true" />{hostSummary(hosts, loaded)}
    </button>
    <IconButton icon="gear" label="Sidebar settings" title="Settings" aria-pressed={settingsPressed} onClick={onSettings} />
  </footer>;
}
