import { createRoot } from 'react-dom/client';
import type { ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import { HostOverview } from '../../src/features/computers/HostOverview';
import type { HostPairingService, RemoteHost } from '../../src/kernel/remote-host.js';
import '../../src/ui/tokens.css';
import '../../src/app.css';

// Settings > Computers with a fake update service: each Host answers like a Controller that downloads, restarts and comes back. The page
// under test drives the stages with window.fleet; `studio` refuses its update request.
const controller = { version: '0.1.0', revision: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeMajor: 22, remoteUpdate: true };
const host = (id: string, name: string, extra: Partial<RemoteHost> = {}): RemoteHost => ({ id, name, online: true, access: 'owner', hostStatus: true, sessionControl: true, controller, ...extra });
let hosts: RemoteHost[] = [host('mac', 'Studio Mac'), host('studio', 'Design studio'), host('desk', 'Desk PC'), host('laptop', 'Offline laptop', { online: false }),
  host('lent', 'Shared server', { access: 'shared' }), host('fresh', 'Current mini', { controller: { ...controller, version: '0.2.0' } })];
const statuses = new Map<string, ControllerUpdateStatus>();
const release = { protocolVersion: '1.8.0', version: '0.2.0', revision: 'b'.repeat(40), sha256: 'c'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', nodeMajor: 22, platforms: ['darwin-arm64'] };
const requests: string[] = [];
const service: HostPairingService = { hosts: async () => ({ hosts }), pair: async () => { throw new Error('unused'); },
  hostStatus: async () => ({ sampledAt: 1, sessions: { running: 1, waiting: 0, idle: 0, failed: 0 }, cpu: { cores: 8, usage: 0.2 } }),
  controllerRelease: async () => ({ release }),
  controllerUpdate: async (id, input) => {
    if (!input) return statuses.get(id) ?? { phase: 'idle', updatedAt: 0 };
    requests.push(id);
    if (id === 'studio') throw new Error('The Controller did not answer. The previous version is still running.');
    const status: ControllerUpdateStatus = { ...input, phase: 'downloading', updatedAt: Date.now() };
    statuses.set(id, status); return status;
  } };
const root = createRoot(document.getElementById('root')!);
const draw = () => root.render(<main style={{ maxWidth: 1100, padding: 12, boxSizing: 'border-box' }}><HostOverview hosts={hosts} service={service} visible onOpenHost={() => {}} /></main>);
Object.assign(window, { fleet: {
  requests,
  /** The Controllers restart: updating Hosts report their next phase. */
  restart: () => { for (const [id, status] of statuses) statuses.set(id, { ...status, phase: 'restarting' }); },
  /** Updating Hosts register again with the new version. */
  back: () => { hosts = hosts.map(item => statuses.has(item.id) ? { ...item, controller: { ...controller, version: '0.2.0' } } : item); draw(); },
} });
draw();
