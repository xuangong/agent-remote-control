import { createRoot } from 'react-dom/client';
import { ControllerUpdates } from '../../src/components/ControllerUpdates';
import type { HostPairingService, RemoteHost } from '../../src/components/HostPairing';
import '../../src/app.css';
const controller = { version: '0.1.0', revision: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeMajor: 22, remoteUpdate: true };
const hosts: RemoteHost[] = [{ id: 'mac', name: 'Studio Mac', online: true, access: 'owner', controller }, { id: 'offline', name: 'Offline laptop', online: false, access: 'owner', controller }];
const service: HostPairingService = { hosts: async () => ({ hosts }), pair: async () => { throw new Error('unused'); },
  controllerRelease: async () => ({ release: { protocolVersion: '1.5.0', version: '0.2.0', revision: 'b'.repeat(40), sha256: 'c'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', nodeMajor: 22, platforms: ['darwin-arm64'] } }),
  controllerUpdate: async (_id, input) => input ? { ...input, phase: 'failed', updatedAt: Date.now(), message: 'The new Controller did not register. The previous version was restored.' } : { phase: 'idle', updatedAt: 0 },
};
createRoot(document.getElementById('root')!).render(<main style={{ maxWidth: 360, padding: 12, boxSizing: 'border-box' }}><ControllerUpdates service={service} hosts={hosts} /></main>);
