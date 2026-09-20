import { PreviewProvider, usePreviewController, type PreviewContextValue } from '@agent-remote-controller/agent-remote-web/react';
import type { HttpPreviewClient } from '@agent-remote-controller/agent-remote-web';
import type { RemoteHost } from './HostPairing.js';
import { HostPreviewList } from './HostPreviewList.js';

export function HostPreviewGroups({ client, hosts, activeHostId, polling, onOpen, onOpenSource }: {
  client: HttpPreviewClient; hosts: readonly RemoteHost[]; activeHostId?: string; polling: boolean;
  onOpen(): void; onOpenSource(sessionId: string, itemId: string, hostId: string): void;
}) {
  const workspace = usePreviewController();
  const owned = hosts.filter(host => host.access !== 'shared');
  if (!owned.length) return null;
  return <section className="lab-preview-groups" aria-label="Host previews">
    <h2>Previews</h2>
    {owned.map(host => host.id === activeHostId && workspace
      ? <HostPreviewList key={host.id} hostName={host.name} controller={workspace} onOpen={onOpen} onOpenSource={(sessionId, itemId) => onOpenSource(sessionId, itemId, host.id)} />
      : <PreviewProvider key={host.id} client={client} hostId={host.id} canManage polling={polling}>
        <HostGroup host={host} workspace={workspace} onOpen={onOpen} onOpenSource={onOpenSource} />
      </PreviewProvider>)}
  </section>;
}

function HostGroup({ host, workspace, onOpen, onOpenSource }: {
  host: RemoteHost; workspace?: PreviewContextValue; onOpen(): void; onOpenSource(sessionId: string, itemId: string, hostId: string): void;
}) {
  const controller = usePreviewController()!;
  return <HostPreviewList hostName={host.name} controller={{ ...controller, unregister: async id => {
    if (workspace) { await workspace.unregister(id, host.id); await controller.refresh(); }
    else await controller.unregister(id);
  }, open: (id, target) => {
    const registration = controller.registrations.find(value => value.id === id);
    return workspace && registration ? workspace.open(id, target, undefined, { hostId: host.id, registration }) : controller.open(id, target);
  } }} onOpen={onOpen} onOpenSource={(sessionId, itemId) => onOpenSource(sessionId, itemId, host.id)} />;
}
